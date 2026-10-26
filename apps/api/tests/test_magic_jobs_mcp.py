import json

import httpx
import pytest

from app.repositories.workspace import WorkspaceRepository
from app.services.ai.secret_store import LocalSecretStore
from app.services.mcp_search import McpSearchService
from app.services.workflow import ContentWorkflowService


def test_parallel_jobs_survive_repository_reload_and_preserve_concurrent_node(tmp_path):
    path = tmp_path / "app.db"
    repo = WorkspaceRepository(path)
    project = repo.create_project("测试", "概念", "")
    first = repo.create_node(project["id"], {"title": "A"})
    second = repo.create_node(project["id"], {"title": "B"})
    board = repo.get_canvas(project["id"])
    a = repo.create_magic_job(project["id"], [first["id"]])
    b = repo.create_magic_job(project["id"], [second["id"]])
    repo.update_magic_job(a["job_id"], progress=65, phase="模型综合生成")
    new_node = repo.create_node(project["id"], {"title": "AI 结果", "created_by": "ai", "parent_id": first["id"]})
    reloaded = WorkspaceRepository(path)
    jobs = reloaded.list_magic_jobs(project["id"])
    assert len(jobs) == 2
    assert {tuple(job["node_ids"]) for job in jobs} == {(first["id"],), (second["id"],)}
    assert reloaded.get_magic_job(a["job_id"])["progress"] == 65
    reloaded.replace_canvas(project["id"], board["nodes"], board["edges"], board["viewport"], board["updated_at"])
    assert reloaded.get_node(new_node["id"]) is not None
    assert any(edge["target_node_id"] == new_node["id"] for edge in reloaded.get_canvas(project["id"])["edges"])
    reloaded.interrupt_magic_jobs()
    assert all(job["status"] == "failed" for job in reloaded.list_magic_jobs(project["id"]))


def test_cancelled_magic_job_cannot_be_completed_by_late_worker(tmp_path):
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("测试", "概念", "")
    job = repo.create_magic_job(project["id"], ["node-1"])
    assert repo.cancel_magic_job(job["job_id"])
    repo.update_magic_job(job["job_id"], status="completed", progress=100, phase="生成完成")
    assert repo.get_magic_job(job["job_id"])["status"] == "cancelled"
    assert not repo.cancel_magic_job(job["job_id"])


def test_selected_upstream_depth_changes_model_context(tmp_path):
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("测试", "概念", "")
    names = ["第一层", "第二层", "第三层", "目标"]
    nodes = [repo.create_node(project["id"], {"title": name, "body": name}) for name in names]
    for left, right in zip(nodes, nodes[1:]):
        repo.create_edge(project["id"], left["id"], right["id"], "context")
    assert [node["title"] for node in repo.upstream_nodes(project["id"], [nodes[-1]["id"]], max_depth=2)] == ["第三层", "第二层"]
    assert repo.upstream_nodes(project["id"], [nodes[-1]["id"]], max_depth=0) == []
    prompts = []

    class AI:
        def complete(self, _system, prompt):
            prompts.append(json.loads(prompt))
            return "加工结果", {"provider": "mock", "model": "mock"}

    workflow = ContentWorkflowService(repo, None, None, AI(), None)
    workflow._wiki_context = lambda _question, _nodes: []
    result, *_ = workflow.magic(project["id"], [nodes[-1]["id"]], "提炼观点", "insight", upstream_depth=2)
    assert [node["title"] for node in prompts[0]["inherited_upstream_context"]] == ["第三层", "第二层"]
    assert result["metadata"]["inherited_upstream_depth"] == 2


def test_streamable_mcp_search_discovers_tool_and_redacts_key(tmp_path, monkeypatch):
    repo = WorkspaceRepository(tmp_path / "app.db")
    service = McpSearchService(repo, LocalSecretStore(tmp_path / "secrets.json"))
    service.save({"name": "Tavily", "url": "https://mcp.tavily.com/mcp/", "tool_name": "tavily_search", "api_key": "private-key", "enabled": True})
    assert "private-key" not in json.dumps(service.config())
    assert "private-key" not in (tmp_path / "app.db").read_bytes().decode("utf-8", errors="ignore")
    calls = []

    def handler(request):
        payload = json.loads(request.content)
        calls.append((payload, str(request.url)))
        if payload["method"] == "initialize":
            return httpx.Response(200, headers={"mcp-session-id": "session-1"}, json={"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-11-25"}})
        assert request.headers["mcp-session-id"] == "session-1"
        if payload["method"] == "notifications/initialized":
            return httpx.Response(202)
        if payload["method"] == "tools/list":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 2, "result": {"tools": [{"name": "tavily_search"}]}})
        payload = {"jsonrpc": "2.0", "id": 3, "result": {"content": [{"type": "text", "text": "Detailed Results:\n\nTitle: 资料\nURL: https://example.org\nContent: 论据"}]}}
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=f"event: message\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n")

    original_client = httpx.Client
    monkeypatch.setattr("app.services.mcp_search.httpx.Client", lambda **kwargs: original_client(transport=httpx.MockTransport(handler)))
    hits = service.search("查询")
    assert hits[0]["url"] == "https://example.org"
    assert hits[0]["excerpt"] == "论据"
    assert calls[-1][0]["params"]["arguments"]["query"] == "查询"
    assert "tavilyApiKey=private-key" in calls[0][1]


@pytest.mark.parametrize("output_type", ["insight", "challenge", "creative_pattern", "note"])
def test_supported_nodes_combine_internal_wiki_and_mcp_sources(tmp_path, output_type):
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("测试", "概念", "")
    source = repo.create_node(project["id"], {"title": "核心问题", "body": "内部知识摘要"})
    prompts = []

    class AI:
        def complete(self, system, prompt):
            prompts.append((system, json.loads(prompt)))
            return "结合内部与外部资料的洞察 [来源](https://example.org)", {"provider": "mock", "model": "mock"}

    class Search:
        def search(self, query):
            return [{"title": "网络报道", "url": "https://example.org", "excerpt": "外部事实", "provider": "Tavily"}]

    workflow = ContentWorkflowService(repo, None, None, AI(), None, Search())
    workflow._wiki_context = lambda question, nodes: [{"chunk_id": "wiki-1", "excerpt": "内部 Wiki 证据"}]
    created, run_id, used_llm, message = workflow.magic(project["id"], [source["id"]], "综合分析", output_type, web_search=True)
    assert used_llm
    assert created["type"] == output_type
    assert prompts[0][1]["wiki_evidence"][0]["chunk_id"] == "wiki-1"
    assert prompts[0][1]["web_evidence"][0]["url"] == "https://example.org"
    assert created["metadata"]["web_sources"][0]["url"] == "https://example.org"
    assert created["metadata"]["source_node_ids"] == [source["id"]]


def test_stateless_mcp_search_protocol(tmp_path, monkeypatch):
    repo = WorkspaceRepository(tmp_path / "app.db")
    service = McpSearchService(repo, LocalSecretStore(tmp_path / "secrets.json"))
    service.save({"name": "自定义", "url": "https://example.org/mcp", "tool_name": "search", "api_key": "token", "enabled": True})

    def handler(request):
        payload = json.loads(request.content)
        if payload["method"] == "initialize":
            return httpx.Response(404)
        assert request.headers["mcp-protocol-version"] == "2026-07-28"
        assert request.headers["mcp-method"] == payload["method"]
        assert request.headers["authorization"] == "Bearer token"
        if payload["method"] == "tools/list":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 2, "result": {"tools": [{"name": "search", "inputSchema": {"properties": {"query": {"type": "string"}}}}]}})
        assert request.headers["mcp-name"] == "search"
        assert payload["params"]["arguments"] == {"query": "测试"}
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 3, "result": {"structuredContent": {"results": [{"title": "出处", "url": "https://example.org/1", "content": "内容"}]}}})

    original_client = httpx.Client
    monkeypatch.setattr("app.services.mcp_search.httpx.Client", lambda **kwargs: original_client(transport=httpx.MockTransport(handler)))
    assert service.search("测试")[0]["url"] == "https://example.org/1"
