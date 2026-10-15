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
