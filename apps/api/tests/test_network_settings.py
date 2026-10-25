from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

from app.api import settings as settings_api
from app.repositories.workspace import WorkspaceRepository
from app.schemas.workspace import GlobalNetworkConfig
from app.services.ai.gateway import AIProviderGateway
from app.services.ai.secret_store import LocalSecretStore
from app.services.deepseek_web import DeepSeekWebService
from app.services.mcp_search import McpSearchService
from app.services.network_settings import NetworkSettings


def services(tmp_path):
    repo = WorkspaceRepository(tmp_path / "app.db")
    secrets = LocalSecretStore(tmp_path / "secrets.json")
    return repo, secrets, NetworkSettings(repo, secrets)


def test_global_inheritance_and_explicit_overrides_across_all_clients(tmp_path, monkeypatch):
    repo, secrets, network = services(tmp_path)
    saved = network.save({"network_mode": "custom_proxy", "proxy_url": "http://proxy.local:8080", "proxy_username": "domain-user", "proxy_password": "private-password"})
    assert saved["has_proxy_password"] and "private-password" not in str(saved)
    assert "private-password" not in str(repo.get_setting("global_network"))
    gateway = AIProviderGateway(repo, secrets)
    assert gateway._network_settings({"extra": {"network_mode": "inherit"}}) == ("custom_proxy", "http://proxy.local:8080", "domain-user", "private-password")
    assert gateway._network_settings({"extra": {"network_mode": "direct"}}) == ("direct", "", "", None)
    assert network.resolve({"network_mode": "custom_proxy", "proxy_url": "http://other:8888"})["proxy_password"] is None
    mcp = McpSearchService(repo, secrets)
    options = mcp._client_options({"network_mode": "inherit"}, "https://example.org")
    assert options["proxy"].url.host == "proxy.local" and options["trust_env"] is False
    assert mcp._client_options({"network_mode": "direct"}, "https://example.org")["proxy"] is None
    deepseek = DeepSeekWebService(repo, secrets)
    deepseek.save({"enabled": True, "api_key": "test-key"})
    request = Mock(return_value=httpx.Response(200, json={"content": "# 正文"}))
    monkeypatch.setattr(AIProviderGateway, "_request", request)
    deepseek.fetch("https://example.org")
    assert request.call_args.kwargs["proxy_password"] == "private-password"
    assert request.call_args.kwargs["network_mode"] == "custom_proxy"
    deepseek.save({"enabled": True, "network_mode": "direct"})
    deepseek.fetch("https://example.org")
    assert request.call_args.kwargs["network_mode"] == "direct"
    assert request.call_args.kwargs["proxy_password"] is None


def test_migration_preserves_explicit_routes_and_runs_once(tmp_path):
    repo, _, network = services(tmp_path)
    provider = repo.upsert_provider({"name": "模型", "base_url": "https://example.org", "model_name": "m", "extra": {"network_mode": "auto"}})
    repo.set_setting("mcp_search", {"network_mode": "direct"})
    repo.set_setting("deepseek_web", {"network_mode": "auto", "enabled": True})
    network.migrate_inheritance()
    assert repo.get_provider(provider["id"])["extra"]["network_mode"] == "inherit"
    assert repo.get_setting("mcp_search")["network_mode"] == "direct"
    assert repo.get_setting("deepseek_web")["network_mode"] == "inherit"
    repo.set_setting("deepseek_web", {"network_mode": "auto"})
    network.migrate_inheritance()
    assert repo.get_setting("deepseek_web")["network_mode"] == "auto"


@pytest.mark.parametrize("url", ["wrong", "http://proxy:bad", "http://user:pass@proxy:80", "http://proxy:80/path", "http://[::1]:99999"])
def test_invalid_global_proxy_is_rejected(tmp_path, url):
    _, _, network = services(tmp_path)
    with pytest.raises(ValueError, match="代理地址无效"):
        network.save({"network_mode": "custom_proxy", "proxy_url": url})


def test_global_network_api_and_clear_password(tmp_path, monkeypatch):
    repo, secrets, network = services(tmp_path)
    monkeypatch.setattr(settings_api, "get_container", lambda: SimpleNamespace(workspace=repo, secrets=secrets))
    settings_api.save_global_network(GlobalNetworkConfig(network_mode="custom_proxy", proxy_url="http://proxy:80", proxy_password="password"))
    assert settings_api.get_global_network()["has_proxy_password"]
    settings_api.save_global_network(GlobalNetworkConfig(network_mode="direct", clear_proxy_password=True))
    assert not network.config()["has_proxy_password"]
    request = Mock(return_value=httpx.Response(404, extensions={"cic_network_route": "直连"}))
    monkeypatch.setattr(AIProviderGateway, "_request", request)
    result = settings_api.test_global_network()
    assert result["reachable"] is True and result["http_status"] == 404
    assert request.call_args.kwargs["timeout"] == 8
    assert "鉴权和功能请分别测试" in result["message"]
