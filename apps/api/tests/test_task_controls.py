import time
from threading import Event
from types import SimpleNamespace

from app.api import workspace as routes
from app.repositories.workspace import WorkspaceRepository
from app.schemas.workspace import MagicRequest
from app.services.ai.cancellation import check_cancelled
from app.services.ai.gateway import AIProviderGateway, provider_scope
from app.services.ai.secret_store import LocalSecretStore


def wait_for(predicate):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.01)
    assert predicate()


def test_pause_resume_parallel_tasks_and_late_worker_do_not_duplicate_output(tmp_path, monkeypatch):
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("并行测试", "想法", "")
    nodes = [repo.create_node(project["id"], {"title": name}) for name in ("A", "B")]
    provider = repo.upsert_provider({"name": "代理模型", "base_url": "https://example.org/v1", "model_name": "model", "extra": {"network_mode": "system_proxy"}})
    repo.set_setting("active_provider_id", provider["id"])
    started = [Event(), Event(), Event()]
    released = [Event(), Event(), Event()]
    calls = []

    class Workflow:
        def magic(self, project_id, node_ids, instruction, output_type, **kwargs):
            index = len(calls)
            calls.append(node_ids)
            kwargs["progress"](40, "模型处理中", instruction)
            started[index].set()
            assert released[index].wait(5)
            check_cancelled()
            node = repo.create_node(project_id, {"title": instruction, "parent_id": node_ids[0]})
            return node, "run", True, "已完成"

    monkeypatch.setattr(routes, "get_container", lambda: SimpleNamespace(workspace=repo, workflow=Workflow()))
    a = routes.start_magic_job(project["id"], MagicRequest(node_ids=[nodes[0]["id"]], instruction="任务甲"))
    assert repo.get_node(nodes[0]["id"])["metadata"]["ai_prompt_history"][-1]["instruction"] == "任务甲"
    assert started[0].wait(2)
    b = routes.start_magic_job(project["id"], MagicRequest(node_ids=[nodes[1]["id"]], instruction="任务乙"))
    assert started[1].wait(2)
    paused = routes.pause_magic_job(a["job_id"])
    assert paused["status"] == "paused"
    resumed = routes.resume_magic_job(a["job_id"])
    assert resumed["attempt"] == 2 and resumed["provider"]["network_mode"] == "system_proxy"
    assert started[2].wait(2)
    for event in released:
        event.set()
    wait_for(lambda: all(repo.get_magic_job(job["job_id"])["status"] == "completed" for job in (a, b)))
    assert len([node for node in repo.get_canvas(project["id"])["nodes"] if node["title"] == "任务甲"]) == 1
    assert repo.get_magic_job(a["job_id"])["request"]["instruction"] == "任务甲"


def test_failed_legacy_task_can_be_cancelled_and_retried_with_explicit_prompt(tmp_path, monkeypatch):
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("旧任务", "想法", "")
    node = repo.create_node(project["id"], {"title": "输入"})
    job = repo.create_magic_job(project["id"], [node["id"]])
    repo.update_magic_job(job["job_id"], status="failed", error="原始网络错误", phase="失败", detail="完整错误")
    monkeypatch.setattr(routes, "get_container", lambda: SimpleNamespace(workspace=repo))
    monkeypatch.setattr(routes, "_launch_magic_job", lambda *args: None)
    assert routes.cancel_magic_job(job["job_id"])["status"] == "cancelled"
    retried = routes.resume_magic_job(job["job_id"], MagicRequest(node_ids=[node["id"]], instruction="补充的新要求"))
    assert retried["request"]["instruction"] == "补充的新要求" and retried["attempt"] == 2
    assert any(event["detail"] == "完整错误" for event in retried["events"])


def test_generation_uses_task_provider_even_if_default_changes(tmp_path, monkeypatch):
    import httpx
    repo = WorkspaceRepository(tmp_path / "app.db")
    a = repo.upsert_provider({"name": "代理模型", "base_url": "https://a.example/v1", "model_name": "A", "is_external": False, "extra": {"network_mode": "system_proxy"}})
    b = repo.upsert_provider({"name": "直连模型", "base_url": "https://b.example/v1", "model_name": "B", "is_external": False})
    repo.set_setting("active_provider_id", b["id"])
    gateway = AIProviderGateway(repo, LocalSecretStore(tmp_path / "secrets.json"))
    captured = []
    def request(method, url, **kwargs):
        captured.append((url, kwargs["network_mode"]))
        return httpx.Response(200, request=httpx.Request(method, url), json={"choices": [{"message": {"content": "OK"}}]})
    monkeypatch.setattr(gateway, "_request", request)
    with provider_scope(a):
        assert gateway.complete("系统", "测试")[1]["model"] == "A"
    assert captured == [("https://a.example/v1/chat/completions", "system_proxy")]


def test_mcp_enabled_for_all_research_node_types_on_start_and_retry(tmp_path, monkeypatch):
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("联网加工", "问题", "")
    node = repo.create_node(project["id"], {"title": "输入"})
    monkeypatch.setattr(routes, "get_container", lambda: SimpleNamespace(workspace=repo))
    monkeypatch.setattr(routes, "_launch_magic_job", lambda *args: None)
    for output_type in ("insight", "challenge", "creative_pattern", "note"):
        request = MagicRequest(node_ids=[node["id"]], instruction="综合内外资料", output_type=output_type, web_search=True)
        job = routes.start_magic_job(project["id"], request)
        assert job["request"]["web_search"] is True
        routes.pause_magic_job(job["job_id"])
        retried = routes.resume_magic_job(job["job_id"])
        assert retried["request"]["output_type"] == output_type and retried["request"]["web_search"] is True
        routes.cancel_magic_job(job["job_id"])
