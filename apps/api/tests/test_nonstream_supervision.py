"""Reproduce blocked TLS teardown, JSON parsing and diagnostic writes without real API calls."""
import time
from threading import Event

import httpx
import pytest

from app.repositories.workspace import WorkspaceRepository
from app.services.ai.cancellation import CancellationToken, cancellation_scope, current_token
from app.services.ai.gateway import AIProviderGateway, ModelRequestTimeout, completion_scope
from app.services.ai.secret_store import LocalSecretStore


def gateway_at(root):
    repo = WorkspaceRepository(root / "app.db")
    provider = repo.upsert_provider({"name": "测试模型", "model_name": "m", "base_url": "https://api.deepseek.com",
                                    "is_external": False, "timeout_seconds": 300, "max_tokens": 393216,
                                    "extra": {"network_mode": "direct", "reasoning_mode": "thinking", "stream_output": True}})
    return AIProviderGateway(repo, LocalSecretStore(root / "secrets.json")), provider


@pytest.mark.parametrize("blocked_stage", ["socket", "parsing"])
def test_deadline_covers_socket_and_parsing_without_poisoning_parent(tmp_path, monkeypatch, blocked_stage):
    gateway, provider = gateway_at(tmp_path)
    released = Event()
    parent = CancellationToken()
    def request(*args, **kwargs):
        if blocked_stage == "socket":
            released.wait(3)
        response = httpx.Response(200, json={"choices": [{"message": {"content": "迟到结果"}}]})
        if blocked_stage == "parsing":
            original = response.json
            def blocked_json():
                released.wait(3)
                return original()
            response.json = blocked_json
        return response
    monkeypatch.setattr(gateway, "_request", request)
    started = time.monotonic()
    try:
        with cancellation_scope(parent), completion_scope("relation_plan", timeout=.25):
            with pytest.raises(ModelRequestTimeout, match="relation_plan.*线程诊断"):
                gateway.complete("系统", "问题", provider=provider)
            parent.check()  # Optional refinement may continue with the first plan.
        assert time.monotonic() - started < 1.5
        assert parent.failure is None and not parent.event.is_set()
    finally:
        released.set()


def test_completed_body_survives_blocked_tls_teardown_and_logger(tmp_path, monkeypatch):
    gateway, provider = gateway_at(tmp_path)
    released = Event()
    parent = CancellationToken()
    parent.on_telemetry = lambda *args: released.wait(3)
    real_client = httpx.Client
    class FrozenTeardown:
        def __init__(self, **kwargs):
            self.client = real_client(transport=httpx.MockTransport(lambda request: httpx.Response(
                200, json={"choices": [{"message": {"content": "完整正文"}}]})), **kwargs)
        def __enter__(self):
            return self.client
        def __exit__(self, *_args):
            released.wait(3)  # Actual _request published the response before this.
            self.client.close()
    monkeypatch.setattr(httpx, "Client", FrozenTeardown)
    started = time.monotonic()
    try:
        with cancellation_scope(parent), completion_scope("wiki_plan", timeout=1):
            assert gateway.complete("系统", "问题", provider=provider)[0] == "完整正文"
        assert time.monotonic() - started < 1.5
    finally:
        released.set()


def test_planning_budget_preserves_full_guides_and_final_generation_config(tmp_path, monkeypatch):
    gateway, provider = gateway_at(tmp_path)
    provider["extra"]["stream_output"] = False
    captured = []
    def request(*args, **kwargs):
        captured.append(kwargs)
        return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})
    monkeypatch.setattr(gateway, "_request", request)
    full_guides = "完整总览和领域图" * 20000
    with completion_scope("wiki_plan"):
        gateway.complete("完整阅读", full_guides, provider=provider)
    gateway.complete("最终写作", "原始 Wiki", provider=provider)
    assert captured[0]["json_payload"]["messages"][1]["content"] == full_guides
    assert captured[0]["json_payload"]["max_tokens"] == 2048
    assert captured[0]["json_payload"]["thinking"] == {"type": "disabled"}
    assert captured[0]["timeout"] == 75
    assert captured[1]["json_payload"]["max_tokens"] == 393216
    assert captured[1]["json_payload"]["thinking"] == {"type": "enabled"}
    assert provider["timeout_seconds"] == 300
