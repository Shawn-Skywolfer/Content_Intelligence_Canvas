import json
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api import workspace as routes
from app.repositories.workspace import WorkspaceRepository
from app.schemas.workspace import ProviderConfigRequest
from app.services.ai.cancellation import CancellationToken, OperationCancelled, cancellation_scope
from app.services.ai.gateway import AIProviderGateway
from app.services.ai.secret_store import LocalSecretStore
from app.services.ai.task_logs import safe_log


def test_384k_boundary_can_be_saved_and_reloaded(tmp_path):
    repo = WorkspaceRepository(tmp_path / "app.db")
    for model in ("deepseek-flash", "custom-model"):
        config = ProviderConfigRequest(name=model, model_name=model, base_url="https://example.org/v1", max_tokens=393216)
        saved = repo.upsert_provider(config.model_dump())
        assert repo.get_provider(saved["id"])["max_tokens"] == 393216
    for value in (0, 393217):
        with pytest.raises(ValidationError):
            ProviderConfigRequest(name="模型", model_name="m", base_url="https://example.org", max_tokens=value)


def test_logs_survive_restart_export_all_and_stopped_only_deletion_retains_nodes(tmp_path, monkeypatch):
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("日志", "问题", "")
    node = repo.create_node(project["id"], {"title": "保留结果"})
    job = repo.create_magic_job(project["id"], [node["id"]])
    job_id = job["job_id"]
    monkeypatch.setattr(routes, "get_container", lambda: SimpleNamespace(workspace=repo))
    app = FastAPI(); app.include_router(routes.router)
    client = TestClient(app)
    assert client.delete(f"/api/magic/jobs/{job_id}").status_code == 409
    def add_logs(index):
        for i in range(110):
            repo.update_magic_job(job_id, expected_attempt=1, detail=f"并行日志 {index}-{i}", metrics={"content_chars": i})
    with ThreadPoolExecutor(2) as executor:
        list(executor.map(add_logs, range(2)))
    assert len(repo.get_magic_job(job_id)["events"]) == 200
    assert len(repo.magic_job_logs(job_id)) == 221
    repo.interrupt_magic_jobs()
    repo = WorkspaceRepository(tmp_path / "app.db")
    assert repo.get_magic_job(job_id)["status"] == "failed"
    assert repo.magic_job_logs(job_id)[-1]["level"] == "error"
    assert repo.restart_magic_job(job_id, {"instruction": "重试"}, {})
    before = len(repo.magic_job_logs(job_id))
    repo.update_magic_job(job_id, expected_attempt=1, detail="过期线程不能写入")
    assert len(repo.magic_job_logs(job_id)) == before
    repo.update_magic_job(job_id, expected_attempt=2, status="failed", detail="HTTP 429：额度不足", error="额度不足")
    exported = client.get(f"/api/magic/jobs/{job_id}/logs/export?format=json")
    assert exported.status_code == 200
    data = exported.json()
    assert len(data["logs"]) == 224
    assert data["logs"][-1]["level"] == "error"
    assert data["logs"][-1]["attempt"] == 2
    assert "HTTP 429" in client.get(f"/api/magic/jobs/{job_id}/logs/export").text
    assert client.get(f"/api/magic/jobs/{job_id}/logs/export?format=bad").status_code == 422
    assert client.delete(f"/api/magic/jobs/{job_id}").status_code == 204
    assert repo.magic_job_logs(job_id) == []
    assert repo.get_node(node["id"])
    for status in ("completed", "paused", "cancelled"):
        task = repo.create_magic_job(project["id"], [])
        if status == "completed":
            repo.update_magic_job(task["job_id"], status=status)
        else:
            repo.stop_magic_job(task["job_id"], status)
        assert client.delete(f"/api/magic/jobs/{task['job_id']}").status_code == 204


def setup_gateway(tmp_path, monkeypatch, handler):
    repo = WorkspaceRepository(tmp_path / "app.db")
    provider = repo.upsert_provider({"name": "流式模型", "model_name": "m", "base_url": "https://model.example/v1", "is_external": False, "max_tokens": 393216, "extra": {"network_mode": "direct"}})
    gateway = AIProviderGateway(repo, LocalSecretStore(tmp_path / "secret.json"))
    real_client = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    token = CancellationToken()
    events = []
    token.on_telemetry = lambda detail, metrics, level: events.append({"detail": detail, "metrics": dict(metrics), "level": level})
    return gateway, provider, token, events


def sse(*values):
    return "".join("data: " + (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)) + "\n\n" for value in values)


def chunk(content=None, reasoning=None, finish=None):
    return {"choices": [{"delta": {"content": content, "reasoning_content": reasoning}, "finish_reason": finish}]}


def test_stream_provider_reasoning_recorded_once_body_aggregated_usage_and_http_reported(tmp_path, monkeypatch):
    def handler(request):
        payload = json.loads(request.content)
        assert payload["stream"] and payload["max_tokens"] == 393216
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, text=sse(chunk(reasoning="供应商"), chunk(reasoning="返回的"), chunk(reasoning="推理说明"), chunk(content="生成"), chunk(content="正文"), {"choices": [], "usage": {"total_tokens": 33}}, chunk(finish="stop"), "[DONE]"))
    gateway, provider, token, events = setup_gateway(tmp_path, monkeypatch, handler)
    with cancellation_scope(token):
        answer, _ = gateway.complete("系统", "问题", provider=provider)
    assert answer == "生成正文"
    assert events[-1]["metrics"]["content_chars"] == 4
    assert events[-1]["metrics"]["reasoning_chars"] == len("供应商返回的推理说明")
    assert events[-1]["metrics"]["usage"]["total_tokens"] == 33
    assert events[-1]["metrics"]["http_status"] == 200
    assert "".join(event["metrics"].get("provider_reasoning", "") for event in events) == "供应商返回的推理说明"


@pytest.mark.parametrize("mode,expected", [("http", "HTTP 429"), ("cut", "意外中断"), ("length", "长度上限"), ("malformed", "无效的流式数据"), ("error", "额度耗尽")])
def test_stream_errors_do_not_return_partial_results(tmp_path, monkeypatch, mode, expected):
    def handler(request):
        if mode == "http":
            return httpx.Response(429, json={"error": {"message": "额度不足"}})
        values = {"cut": sse(chunk(content="部分正文")), "length": sse(chunk(content="部分正文", finish="length"), "[DONE]"), "malformed": "data: not-json\n\n", "error": sse({"error": {"message": "额度耗尽"}})}
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, text=values[mode])
    gateway, provider, token, events = setup_gateway(tmp_path, monkeypatch, handler)
    with cancellation_scope(token), pytest.raises(RuntimeError, match=expected):
        gateway.complete("系统", "问题", provider=provider)
    assert any(event["metrics"].get("http_status") == (429 if mode == "http" else 200) for event in events)


def test_stream_incompatible_provider_falls_back_once(tmp_path, monkeypatch):
    calls = []
    def handler(request):
        payload = json.loads(request.content); calls.append(payload)
        if payload.get("stream"):
            return httpx.Response(400, json={"error": {"message": "stream is unsupported"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "正常结果"}, "finish_reason": "stop"}]})
    gateway, provider, token, events = setup_gateway(tmp_path, monkeypatch, handler)
    with cancellation_scope(token):
        assert gateway.complete("系统", "问题", provider=provider)[0] == "正常结果"
    assert len(calls) == 2 and "stream" not in calls[-1]
    assert any(event["metrics"].get("stage") == "fallback" for event in events)


def test_stream_cancellation_never_returns_late_body(tmp_path, monkeypatch):
    gateway, provider, token, events = setup_gateway(tmp_path, monkeypatch, lambda request: httpx.Response(200, headers={"Content-Type": "text/event-stream"}, text=sse(chunk(content="正文", finish="stop"), "[DONE]")))
    def report(detail, metrics, level):
        if metrics.get("stage") == "output":
            token.event.set()
    token.on_telemetry = report
    with cancellation_scope(token), pytest.raises(OperationCancelled):
        gateway.complete("系统", "问题", provider=provider)


def test_logs_hide_keys_proxy_credentials_and_raw_reasoning():
    hidden = safe_log({"message": "Bearer private-token https://u:pass@proxy.example sk-12345678901234567890 https://example?api_key=private", "reasoning_content": "原始思维链", "api_key": "private"})
    assert "private" not in str(hidden) and "原始思维链" not in str(hidden) and "u:pass" not in str(hidden)


def test_finish_reason_finishes_without_waiting_for_done(tmp_path, monkeypatch):
    class Stream(httpx.SyncByteStream):
        def __iter__(self):
            yield sse(chunk(content="完整正文", finish="stop")).encode()
            raise AssertionError("收到 stop 后不应继续等 DONE")
    gateway, provider, token, events = setup_gateway(tmp_path, monkeypatch, lambda request: httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=Stream()))
    with cancellation_scope(token):
        assert gateway.complete("系统", "要求", provider=provider)[0] == "完整正文"


def test_idle_watchdog_keeps_partial_and_interrupts_blocked_reader(tmp_path, monkeypatch):
    import time
    from threading import Event
    released = Event()
    class Stream(httpx.SyncByteStream):
        def __iter__(self):
            yield sse(chunk(content="未完成草稿")).encode()
            assert released.wait(10)
            yield b": keepalive\n\n"
        def close(self):
            released.set()
    gateway, provider, token, events = setup_gateway(tmp_path, monkeypatch, lambda request: httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=Stream()))
    provider["timeout_seconds"] = 5
    started = time.monotonic()
    with cancellation_scope(token), pytest.raises(RuntimeError, match="未返回新的正文或推理"):
        gateway.complete("系统", "要求", provider=provider)
    assert time.monotonic() - started < 9
    assert token.partial_output == "未完成草稿"


def test_idle_supervisor_returns_even_when_socket_and_close_do_not_wake(tmp_path, monkeypatch):
    import time
    from threading import Event
    released = Event()
    class FrozenStream(httpx.SyncByteStream):
        def __iter__(self):
            yield sse(chunk(content='{"')).encode()
            released.wait(15)
            yield sse(chunk(content="迟到结果", finish="stop")).encode()
        def close(self):
            released.wait(15)
    gateway, provider, token, events = setup_gateway(tmp_path, monkeypatch, lambda request: httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=FrozenStream()))
    provider["timeout_seconds"] = 5
    started = time.monotonic()
    try:
        with cancellation_scope(token), pytest.raises(RuntimeError, match="线程诊断"):
            gateway.complete("系统", "要求", provider=provider)
        assert time.monotonic() - started < 8
        assert token.partial_output == '{"'
    finally:
        released.set()


def test_blocked_log_writer_cannot_stop_receiving_model_body(tmp_path, monkeypatch):
    import time
    from threading import Event
    released = Event()
    gateway, provider, token, events = setup_gateway(tmp_path, monkeypatch, lambda request: httpx.Response(200, headers={"Content-Type": "text/event-stream"}, text=sse(chunk(reasoning="推理"), chunk(content="完整正文", finish="stop"))))
    def stuck_logger(*args):
        released.wait(15)
    token.on_telemetry = stuck_logger
    started = time.monotonic()
    try:
        with cancellation_scope(token):
            assert gateway.complete("系统", "要求", provider=provider)[0] == "完整正文"
        assert time.monotonic() - started < 3
    finally:
        released.set()


def test_completed_answer_returns_even_if_tls_teardown_blocks(tmp_path, monkeypatch):
    import time
    from threading import Event
    released = Event()
    class SlowClose(httpx.SyncByteStream):
        def __iter__(self):
            yield sse(chunk(content="完整结果", finish="stop")).encode()
        def close(self):
            released.wait(15)
    gateway, provider, token, events = setup_gateway(tmp_path, monkeypatch, lambda request: httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=SlowClose()))
    started = time.monotonic()
    try:
        with cancellation_scope(token):
            assert gateway.complete("系统", "要求", provider=provider)[0] == "完整结果"
        assert time.monotonic() - started < 3
        assert events[-1]["metrics"]["stage"] == "complete"
    finally:
        released.set()
