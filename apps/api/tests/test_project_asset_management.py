from __future__ import annotations

import json
import sqlite3

from fastapi.testclient import TestClient

from app.container import get_container
from app.main import app


def test_projects_archive_restore_delete_and_asset_lifecycle(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CIC_DATA_DIR", str(tmp_path))
    get_container.cache_clear()
    client = TestClient(app)
    first = client.post("/api/projects", json={"name": "甲项目", "idea": "甲项目的想法"}).json()
    other = client.post("/api/projects", json={"name": "乙项目", "idea": "乙项目的想法"}).json()
    first_id = first["id"]
    archived = client.patch(f"/api/projects/{first_id}", json={"status": "archived"})
    assert archived.status_code == 200 and archived.json()["status"] == "archived"
    assert client.get(f"/api/projects/{first_id}/canvas").status_code == 200
    assert client.patch(f"/api/projects/{first_id}", json={"status": "deleted"}).status_code == 422
    assert client.patch(f"/api/projects/{first_id}", json={"status": "active"}).json()["status"] == "active"

    output = client.post(f"/api/projects/{first_id}/nodes", json={
        "type": "output", "title": "最终稿", "body": "## 第一版正文",
        "metadata": {"format": "wechat"},
    }).json()
    saved = client.post(f"/api/projects/{first_id}/nodes/{output['id']}/save-asset")
    assert saved.status_code == 200, saved.text
    asset_id = saved.json()["asset"]["id"]
    listed = client.get(f"/api/projects/{first_id}/assets").json()
    assert listed[0]["node_id"] == output["id"]
    assert client.get(f"/api/projects/{other['id']}/assets").json() == []
    assert client.patch(f"/api/projects/{other['id']}/assets/{asset_id}", json={"title": "越权", "body": "正文"}).status_code == 404

    edited = client.patch(f"/api/projects/{first_id}/assets/{asset_id}", json={"title": "更新标题", "body": "## 第二版正文"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["version"] == 2
    linked = next(node for node in client.get(f"/api/projects/{first_id}/canvas").json()["nodes"] if node["id"] == output["id"])
    assert linked["title"] == "更新标题" and linked["body"] == "## 第二版正文"
    assert client.delete(f"/api/projects/{other['id']}/assets/{asset_id}").status_code == 404
    assert client.delete(f"/api/projects/{first_id}/assets/{asset_id}").status_code == 204
    linked = next(node for node in client.get(f"/api/projects/{first_id}/canvas").json()["nodes"] if node["id"] == output["id"])
    assert "asset_id" not in linked["metadata"] and linked["body"] == "## 第二版正文"

    assert client.delete(f"/api/projects/{first_id}").status_code == 204
    assert client.get(f"/api/projects/{first_id}").status_code == 404
    assert client.delete(f"/api/projects/{first_id}").status_code == 404
    assert client.get(f"/api/projects/{other['id']}/canvas").status_code == 200
    with sqlite3.connect(tmp_path / "app.db") as db:
        for table in ("canvases", "canvas_nodes", "canvas_edges", "ai_runs", "content_assets"):
            assert db.execute(f"SELECT COUNT(*) FROM {table} WHERE project_id=?", (first_id,)).fetchone()[0] == 0
    get_container.cache_clear()


def test_custom_format_prompts_used_for_downstream_output(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CIC_DATA_DIR", str(tmp_path))
    get_container.cache_clear()
    client = TestClient(app)
    defaults = client.get("/api/content-formats").json()
    assert {item["id"] for item in defaults} == {"wechat", "video_script", "poster_campaign"}
    formats = [*defaults, {"id": "podcast", "name": "播客提纲", "positive_prompt": "用问答形式组织观点", "negative_prompt": "不要使用未经证实的数字"}]
    assert client.put("/api/content-formats", json={"formats": formats}).status_code == 200
    assert client.put("/api/content-formats", json={"formats": [formats[-1], formats[-1]]}).status_code == 422
    project_id = client.post("/api/projects", json={"name": "播客", "idea": "新的内容表达"}).json()["id"]
    idea = next(node for node in client.get(f"/api/projects/{project_id}/canvas").json()["nodes"] if node["type"] == "idea")
    calls = []

    def model(system: str, prompt: str):
        calls.append((system, json.loads(prompt)))
        return "# 播客提纲\n\n有证据的讨论", {"provider": "测试", "model": "测试模型"}

    monkeypatch.setattr(get_container().ai, "complete", model)
    result = client.post(f"/api/projects/{project_id}/content/generate", json={
        "node_ids": [idea["id"]], "format": "podcast", "title": "", "use_llm": True,
        "save_as_asset": False, "instruction": "开头提出问题", "negative_prompt": "不要太长",
    })
    assert result.status_code == 200, result.text
    created = result.json()["node"]
    assert created["title"] == "播客｜播客提纲初稿"
    assert created["metadata"]["format_positive_prompt"] == "用问答形式组织观点"
    assert created["metadata"]["format_negative_prompt"] == "不要使用未经证实的数字"
    assert calls[-1][1]["writing_instruction"] == "开头提出问题"
    assert calls[-1][1]["negative_prompt"] == "不要太长"
    assert calls[-1][1]["format_positive_prompt"] == "用问答形式组织观点"
    assert calls[-1][1]["format_negative_prompt"] == "不要使用未经证实的数字"
    assert idea["id"] in created["metadata"]["source_node_ids"]
    assert any(edge["source_node_id"] == idea["id"] and edge["target_node_id"] == created["id"] for edge in client.get(f"/api/projects/{project_id}/canvas").json()["edges"])
    get_container.cache_clear()
