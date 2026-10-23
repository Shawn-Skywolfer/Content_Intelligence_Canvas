import json
import time
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

from app.repositories.workspace import WorkspaceRepository
from app.services.ai.cancellation import OperationCancelled
from app.services.ai.gateway import AIProviderGateway
from app.services.ai.secret_store import LocalSecretStore
from app.services.deepseek_web import DeepSeekWebService, DeepSeekWebTestJobs, WebSearchService
from app.services.workflow import ContentWorkflowService


def make_service(tmp_path):
    repo = WorkspaceRepository(tmp_path / "app.db")
    service = DeepSeekWebService(repo, LocalSecretStore(tmp_path / "secrets.json"))
    service.save({"enabled": True, "api_key": "private-test-key", "fetch_top_k": 1})
    return service


def test_search_fetch_payloads_and_secrets_do_not_escape(tmp_path, monkeypatch):
    service = make_service(tmp_path)
    calls = []

    def request(method, url, **kwargs):
        calls.append((url, kwargs))
        assert kwargs["headers"]["Authorization"] == "Bearer private-test-key"
        body = {"results": [{"title": "资料", "url": "https://example.org/article", "summary": "搜索摘要", "content": "", "authority": 3}]} if url.endswith("search") else {"title": "详情", "content": "# 抓取正文\n原始证据"}
        return httpx.Response(200, json=body, extensions={"cic_network_route": "系统代理"})

    monkeypatch.setattr(AIProviderGateway, "_request", request)
    hits = service.search("很长的问题" * 100)
    assert calls[0][0] == "https://api.deepseek.com/v1/tools/search"
    assert len(calls[0][1]["json_payload"]["query"]) == 128
    assert calls[0][1]["json_payload"]["need_content"] is True
    assert calls[1][1]["json_payload"] == {"url": "https://example.org/article"}
    assert hits[0]["excerpt"] == "# 抓取正文\n原始证据" and hits[0]["provider"] == "DeepSeek Search/Fetch"
    assert hits[0]["authority"] == 3
    assert "private-test-key" not in json.dumps(service.config())
    assert "private-test-key" not in json.dumps(service.repository.get_setting("deepseek_web"))
    service.save({"base_url": "https://api.deepseek.com/v1", "enabled": True, "api_key": ""})
    service.fetch("https://example.org")
    assert calls[-1][0] == "https://api.deepseek.com/v1/tools/fetch"


@pytest.mark.parametrize("status", [401, 402, 403, 404, 429, 504])
def test_http_errors_are_specific_and_never_echo_response_secrets(tmp_path, monkeypatch, status):
    service = make_service(tmp_path)
    monkeypatch.setattr(AIProviderGateway, "_request", lambda *a, **kw: httpx.Response(status, json={"error": {"message": "private-test-key"}}))
    with pytest.raises(ValueError, match=f"HTTP {status}") as error:
        service.fetch("https://example.org")
    assert "private-test-key" not in str(error.value)


def test_http_200_empty_fetch_is_failure_and_partial_search_is_kept(tmp_path, monkeypatch):
    service = make_service(tmp_path)
    def request(_method, url, **kwargs):
        return httpx.Response(200, json={"content": ""} if url.endswith("fetch") else {"results": [{"url": "https://example.org", "summary": "有效搜索摘要"}]})
    monkeypatch.setattr(AIProviderGateway, "_request", request)
    with pytest.raises(ValueError, match="没有可用 Markdown"):
        service.fetch("https://example.org")
    with pytest.raises(ValueError, match="不会使用摘要代替全文"):
        service.search("问题")


def test_provider_detection_prioritizes_deepseek_and_falls_back_transparently(tmp_path):
    deepseek = make_service(tmp_path)
    mcp = SimpleNamespace(config=lambda: {"enabled": True, "url": "https://example.org/mcp", "tool_name": "search"}, search=Mock(return_value=[{"provider": "MCP"}]))
    service = WebSearchService(deepseek.repository, mcp, deepseek)
    deepseek.search = Mock(return_value=[{"provider": "DeepSeek"}])
    assert service.selection()["provider"] == "deepseek"
    assert service.search("问题")[0]["provider"] == "DeepSeek"
    mcp.search.assert_not_called()
    deepseek.search.side_effect = ValueError("HTTP 402，余额不足")
    events = []
    with pytest.raises(ValueError, match="402"):
        service.search("问题", events.append)
    mcp.search.assert_not_called()
    deepseek.search.side_effect = OperationCancelled("已取消")
    mcp.search.reset_mock()
    with pytest.raises(OperationCancelled):
        service.search("问题")
    mcp.search.assert_not_called()
    deepseek.save({"enabled": False})
    assert service.selection()["provider"] == "mcp"
    mcp.config = lambda: {"enabled": False, "url": "", "tool_name": ""}
    with pytest.raises(ValueError, match="请先在设置中启用"):
        service.search("问题")


def test_real_test_job_reports_search_success_and_fetch_failure_separately(tmp_path, monkeypatch):
    service = make_service(tmp_path)
    monkeypatch.setattr(service, "search_raw", lambda *a: ([{"url": "https://example.org", "summary": "材料"}], {"http_status": 200}))
    monkeypatch.setattr(service, "fetch", Mock(side_effect=ValueError("Fetch HTTP 404")))
    tests = DeepSeekWebTestJobs(service)
    job = tests.start("both", "问题", "https://example.org")
    deadline = time.monotonic() + 3
    while tests.get(job["job_id"])["status"] == "running" and time.monotonic() < deadline:
        time.sleep(.01)
    result = tests.get(job["job_id"])
    assert result["status"] == "failed" and "404" in result["error"]
    assert result["result"]["search"]["http_status"] == 200
    elapsed = result["elapsed_seconds"]
    assert tests.get(job["job_id"])["elapsed_seconds"] == elapsed


@pytest.mark.parametrize("output_type", ["insight", "challenge", "creative_pattern", "note"])
def test_auto_selected_web_material_reaches_model_and_downstream_node(tmp_path, output_type):
    deepseek = make_service(tmp_path)
    repo = deepseek.repository
    project = repo.create_project("研究", "供电", "")
    node = repo.create_node(project["id"], {"title": "输入", "body": "内部材料"})
    full_text = "网页正文" * 4000 + "末尾不能丢失的事实"
    deepseek.search = Mock(return_value=[{"title": "网页", "url": "https://example.org", "content": full_text, "content_chars": len(full_text), "excerpt": full_text[:800], "provider": "DeepSeek Search/Fetch"}])
    mcp = SimpleNamespace(config=lambda: {"enabled": False, "url": "", "tool_name": ""})
    router = WebSearchService(repo, mcp, deepseek)
    prompts = []
    class AI:
        def complete(self, system, prompt):
            prompts.append(json.loads(prompt))
            return "综合结论", {"provider": "test", "model": "test"}
    workflow = ContentWorkflowService(repo, None, None, AI(), None, router)
    workflow._wiki_context = lambda *args: [{"chunk_id": "wiki", "excerpt": "Wiki 证据"}]
    created, *_ = workflow.magic(project["id"], [node["id"]], "综合资料", output_type, web_search=True)
    assert prompts[0]["web_evidence"][0]["provider"] == "DeepSeek Search/Fetch"
    assert prompts[0]["web_evidence"][0]["content"] == full_text
    assert created["metadata"]["web_context_chars"] == len(full_text)
    assert prompts[0]["wiki_evidence"][0]["chunk_id"] == "wiki"
    assert created["metadata"]["web_sources"][0]["url"] == "https://example.org"


def test_search_full_content_is_kept_without_redundant_fetch_or_8000_limit(tmp_path, monkeypatch):
    service = make_service(tmp_path)
    service.save({"enabled": True, "need_content": False, "fetch_top_k": 0, "max_content_chars": 1000})
    full_text = "完整网页正文" * 4000 + "正文末尾的关键事实"
    calls = []
    def request(method, url, **kwargs):
        calls.append(url)
        assert kwargs["json_payload"]["need_content"] is True
        return httpx.Response(200, json={"results": [{"url": "https://example.org", "content": full_text}]})
    monkeypatch.setattr(AIProviderGateway, "_request", request)
    result = service.search("问题")
    assert len(calls) == 1
    assert result[0]["content"] == full_text
    assert result[0]["content_chars"] > 8000
    assert result[0]["retrieval_report"]["full_text_pages"] == 1
