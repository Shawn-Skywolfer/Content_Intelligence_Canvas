from types import SimpleNamespace

from app.api import settings as settings_api
from app.repositories.knowledge_manifest import KnowledgeManifestRepository
from app.repositories.workspace import WorkspaceRepository
from app.services.ai.secret_store import LocalSecretStore
from app.services.mcp_search import McpSearchService
from app.schemas.workspace import ProviderConfigRequest


def test_large_output_limit_can_be_saved_with_matching_ui_bounds():
    for limit in (200000, 256000, 262144):
        request = ProviderConfigRequest(name="大输出模型", base_url="https://example.org/v1", model_name="model", max_tokens=limit)
        assert request.max_tokens == limit


def test_settings_round_trip_includes_local_keys_but_no_wiki_contents(tmp_path, monkeypatch):
    vault = tmp_path / "wiki"
    vault.mkdir()
    (vault / "private.md").write_text("私有知识原文", encoding="utf-8")

    def container(folder):
        folder.mkdir()
        workspace = WorkspaceRepository(folder / "app.db")
        secrets = LocalSecretStore(folder / "secrets.json")
        return SimpleNamespace(workspace=workspace, manifest=KnowledgeManifestRepository(folder / "app.db"),
                               secrets=secrets, mcp_search=McpSearchService(workspace, secrets))

    original = container(tmp_path / "first")
    monkeypatch.setattr(settings_api, "get_container", lambda: original)
    provider = settings_api.save_provider(ProviderConfigRequest(name="内部模型", base_url="https://example.org/v1",
                                                                model_name="example", is_external=False,
                                                                api_key="local-test-key", extra={"reasoning_mode": "effort", "reasoning_effort": "high"}))
    original.workspace.set_setting("active_provider_id", provider.id)
    original.manifest.upsert_source("wiki-source", "我的 Wiki", str(vault))
    backup = settings_api.export_settings()
    assert backup["providers"][0]["api_key"] == "local-test-key"
    assert "私有知识原文" not in str(backup)
    assert "secret_ref" not in str(backup)

    restored = container(tmp_path / "restored")
    monkeypatch.setattr(settings_api, "get_container", lambda: restored)
    result = settings_api.import_settings(backup)
    assert result["missing_paths"] == []
    assert restored.workspace.active_provider()["id"] == provider.id
    assert restored.secrets.get(restored.workspace.get_provider(provider.id)["secret_ref"]) == "local-test-key"
    assert restored.manifest.list_sources()[0]["root_path"] == str(vault.resolve())
