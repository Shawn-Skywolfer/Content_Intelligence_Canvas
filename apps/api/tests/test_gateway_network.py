from __future__ import annotations

import pytest
import httpx
from threading import Event

from app.services.ai.gateway import AIProviderGateway, ProviderConnectionError
from app.repositories.workspace import WorkspaceRepository
from app.services.ai.secret_store import LocalSecretStore
from app.services.ai.cancellation import CancellationToken, OperationCancelled, cancellation_scope, check_cancelled


def test_invalid_proxy_port_is_rejected() -> None:
    assert AIProviderGateway._proxy_url("http://[::1]:1]") is None
    assert AIProviderGateway._proxy_url("127.0.0.1:7890") == "http://127.0.0.1:7890"


def test_auto_mode_tries_system_proxy_then_direct(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        AIProviderGateway,
        "_system_proxy",
        classmethod(lambda cls, target_url: "http://127.0.0.1:7890"),
    )
    assert AIProviderGateway._network_routes("https://api.deepseek.com/models", "auto", None) == [
        ("系统代理", "http://127.0.0.1:7890"),
        ("直连", None),
    ]


def test_custom_proxy_requires_valid_http_url() -> None:
    with pytest.raises(ProviderConnectionError, match="自定义代理地址无效"):
        AIProviderGateway._network_routes(
            "https://api.deepseek.com/models",
            "custom_proxy",
            "http://[::1]:1]",
        )


def test_internal_model_bypasses_protection_only_when_explicitly_classified(tmp_path, monkeypatch):
    repo = WorkspaceRepository(tmp_path / "app.db")
    external = repo.upsert_provider({"name": "外部", "base_url": "https://example.org/v1", "model_name": "external", "enabled": True, "is_external": True})
    internal = repo.upsert_provider({"name": "内部", "base_url": "https://internal.example/v1", "model_name": "internal", "enabled": True, "is_external": False})
    repo.set_setting("protect_internal_data", True)
    repo.set_setting("active_provider_id", external["id"])
    gateway = AIProviderGateway(repo, LocalSecretStore(tmp_path / "secret.json"))
    with pytest.raises(PermissionError, match="数据保护"):
        gateway.complete("系统", "内部资料")
    repo.set_setting("active_provider_id", internal["id"])
    request = httpx.Request("POST", "https://internal.example/v1/chat/completions")
    monkeypatch.setattr(AIProviderGateway, "_request", lambda *args, **kwargs: httpx.Response(
        200, request=request, json={"choices": [{"message": {"content": "OK"}}]}))
    answer, trace = gateway.complete("系统", "内部资料")
    assert answer == "OK"
    assert trace["model"] == "internal"


def test_cancel_token_closes_active_connection_and_blocks_late_results():
    closed = Event()

    class Client:
        def close(self):
            closed.set()

    token = CancellationToken()
    with cancellation_scope(token):
        token.bind(Client())
        token.cancel()
        assert closed.wait(1)
        with pytest.raises(OperationCancelled):
            check_cancelled()


def test_short_text_probe_reports_reasoning_only_as_failure(tmp_path, monkeypatch):
    repo = WorkspaceRepository(tmp_path / "app.db")
    provider = repo.upsert_provider({"name": "推理模型", "base_url": "https://example.org/v1", "model_name": "reasoner", "extra": {"test_timeout_seconds": 15}})
    gateway = AIProviderGateway(repo, LocalSecretStore(tmp_path / "secrets.json"))
    captured = {}

    def fake_request(*args, **kwargs):
        captured.update(kwargs)
        return httpx.Response(200, request=httpx.Request("POST", args[1]), json={
            "choices": [{"message": {"content": "", "reasoning_content": "思考中"}, "finish_reason": "length"}],
            "usage": {"completion_tokens": 128},
        })

    monkeypatch.setattr(gateway, "_request", fake_request)
    result = gateway.health_check(provider)
    assert result["reachable"] is True and result["capability_test"] is False
    assert result["status"] == "failed" and result["finish_reason"] == "length"
    assert result["usage"]["completion_tokens"] == 128
    assert captured["json_payload"]["messages"][0]["content"] == "请只回复 OK"
    assert captured["json_payload"]["max_tokens"] >= 128
    assert captured["timeout"] == 15


def test_deleting_active_provider_removes_selection(tmp_path):
    repo = WorkspaceRepository(tmp_path / "app.db")
    first = repo.upsert_provider({"name": "甲", "base_url": "https://a.example/v1", "model_name": "a"})
    second = repo.upsert_provider({"name": "乙", "base_url": "https://b.example/v1", "model_name": "b"})
    repo.set_setting("active_provider_id", first["id"])
    assert repo.delete_provider(first["id"])
    assert repo.get_setting("active_provider_id") is None
    assert repo.active_provider()["id"] == second["id"]


def test_deepseek_thinking_off_is_explicit_but_other_providers_remain_compatible():
    provider = {"base_url": "https://api.deepseek.com/v1", "extra": {"reasoning_mode": "off"}}
    assert AIProviderGateway._reasoning_payload(provider) == {"thinking": {"type": "disabled"}}
    assert AIProviderGateway._reasoning_payload({"base_url": "https://other.example/v1", "extra": {"reasoning_mode": "off"}}) == {}
    assert AIProviderGateway._reasoning_payload({**provider, "extra": {"reasoning_mode": "thinking"}}) == {"thinking": {"type": "enabled"}}
