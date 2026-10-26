from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.container import get_container
from app.main import app
from app.repositories.workspace import WorkspaceRepository


def test_model_summary_persists_and_full_body_survives_canvas_save(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CIC_DATA_DIR", str(tmp_path))
    get_container.cache_clear()
    client = TestClient(app)
    project = client.post("/api/projects", json={"idea": "研究一个问题"}).json()
    project_id = project["id"]
    full_body = "## 完整内容\n\n" + "这是必须完整保留的证据与分析。" * 80
    node = client.post(f"/api/projects/{project_id}/nodes", json={
        "title": "长节点", "body": full_body, "type": "insight",
    }).json()
    url = f"/api/projects/{project_id}/nodes/{node['id']}/summary"
    unconfigured = client.post(url, json={"force": False})
    assert unconfigured.status_code == 422
    assert "摘要生成失败" in unconfigured.json()["detail"]
    assert client.get(f"/api/projects/{project_id}/canvas").json()["nodes"][-1]["body"] == full_body

    calls = []

    def model(_system: str, user: str):
        calls.append(user)
        return {"summary": "核心结论与关键证据均保留在完整正文中。"}, {"provider": "测试", "model": "模型"}

    monkeypatch.setattr(get_container().ai, "complete_json", model)
    response = client.post(url, json={"force": False})
    assert response.status_code == 200
    assert response.json()["summary"] == "核心结论与关键证据均保留在完整正文中。"
    assert response.json()["summary_model"] == "测试 · 模型"
    assert json.loads(calls[0])["body"] == full_body
    assert client.post(url, json={"force": False}).status_code == 200
    assert len(calls) == 1

    board = client.get(f"/api/projects/{project_id}/canvas").json()
    saved = client.put(f"/api/projects/{project_id}/canvas", json={
        "nodes": board["nodes"], "edges": board["edges"], "viewport": board["viewport"],
    })
    assert saved.status_code == 200
    current = next(item for item in saved.json()["nodes"] if item["id"] == node["id"])
    assert current["summary"] and current["body"] == full_body

    updated = client.patch(f"/api/projects/{project_id}/nodes/{node['id']}", json={"body": "已编辑正文"})
    assert updated.status_code == 200
    assert updated.json()["summary"] is None
    assert updated.json()["body"] == "已编辑正文"
    get_container.cache_clear()


def test_summary_from_old_body_cannot_overwrite_edited_node(tmp_path: Path) -> None:
    repository = WorkspaceRepository(tmp_path / "app.db")
    project = repository.create_project("项目", "一个研究问题")
    node = repository.create_node(project["id"], {"title": "原标题", "body": "原正文"})
    repository.update_node(project["id"], node["id"], {"body": "新正文"})
    stale = repository.save_node_summary(project["id"], node["id"], "原标题", "原正文", "旧摘要", "旧模型")
    assert stale and stale["summary"] is None
    current = repository.save_node_summary(project["id"], node["id"], "原标题", "新正文", "新摘要", "新模型")
    assert current and current["summary"] == "新摘要"
    repository.update_node(project["id"], node["id"], {"title": "新标题"})
    assert repository.get_node(node["id"])["summary"] is None
