from __future__ import annotations

import pytest

from app.services.ai.gateway import AIProviderGateway, ProviderConnectionError


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
