from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from fastapi.testclient import TestClient

from app.container import get_container
from app.main import app


def _client(tmp_path: Path, monkeypatch) -> tuple[TestClient, Path]:
    data_dir = tmp_path / "data"
    monkeypatch.setenv("CIC_DATA_DIR", str(data_dir))
    get_container.cache_clear()
    return TestClient(app), data_dir


def test_canvas_self_repairs_and_draft_is_saved_only_on_confirmation(tmp_path: Path, monkeypatch) -> None:
    client, data_dir = _client(tmp_path, monkeypatch)
    project = client.post("/api/projects", json={"name": "白板", "idea": "测试想法", "brief": ""}).json()
    project_id = project["id"]

    with sqlite3.connect(data_dir / "app.db") as db:
        db.execute("DELETE FROM canvas_edges WHERE project_id=?", (project_id,))
        db.execute("DELETE FROM canvas_nodes WHERE project_id=?", (project_id,))
        db.execute("DELETE FROM canvases WHERE project_id=?", (project_id,))

    repaired = client.get(f"/api/projects/{project_id}/canvas")
    assert repaired.status_code == 200
    nodes = repaired.json()["nodes"]
    assert {node["type"] for node in nodes} == {"idea", "brief"}

    draft = client.post(
        f"/api/projects/{project_id}/content/generate",
        json={
            "node_ids": [nodes[0]["id"]],
            "format": "wechat",
            "title": "白板草稿",
            "duration_seconds": 90,
            "use_llm": False,
            "instruction": "语气简洁",
            "save_as_asset": False,
        },
    )
    assert draft.status_code == 200
    assert draft.json()["asset"] is None
    output = draft.json()["node"]
    assert client.get(f"/api/projects/{project_id}/assets").json() == []

    client.patch(
        f"/api/projects/{project_id}/nodes/{output['id']}",
        json={"body": "这是用户在白板中修改后的最终正文。"},
    )
    saved = client.post(f"/api/projects/{project_id}/nodes/{output['id']}/save-asset")
    assert saved.status_code == 200
    assert saved.json()["asset"]["body"] == "这是用户在白板中修改后的最终正文。"
    assert len(client.get(f"/api/projects/{project_id}/assets").json()) == 1


def test_research_job_reports_progress_and_source_can_be_removed(tmp_path: Path, monkeypatch) -> None:
    client, _ = _client(tmp_path, monkeypatch)
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    (wiki / "fact.md").write_text(
        "# 产品事实\n\n## 价值\n\n本地知识库可以为内容研究提供可追溯的事实证据。",
        encoding="utf-8",
    )
    source = client.post(
        "/api/knowledge-sources", json={"name": "我的知识库", "root_path": str(wiki)}
    ).json()
    assert client.post(f"/api/knowledge-sources/{source['id']}/refresh").status_code == 200
    project = client.post("/api/projects", json={"name": "研究", "idea": "知识证据", "brief": ""}).json()

    started = client.post(
        f"/api/projects/{project['id']}/research/quick/start",
        json={
            "source_id": source["id"],
            "query": "本地知识库有什么价值",
            "finding_count": 3,
            "use_llm": False,
        },
    )
    assert started.status_code == 200
    job = started.json()
    for _ in range(100):
        job = client.get(f"/api/research/jobs/{job['job_id']}").json()
        if job["status"] != "running":
            break
        time.sleep(0.02)
    assert job["status"] == "completed"
    assert job["progress"] == 100
    assert job["phase"] == "研究完成"

    assert client.delete(f"/api/knowledge-sources/{source['id']}").status_code == 204
    assert client.get("/api/knowledge-sources").json() == []
