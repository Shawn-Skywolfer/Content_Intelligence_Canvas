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
    node_types = {node["type"] for node in nodes}
    assert {"idea", "brief", "frame", "fact", "insight", "output"} <= node_types
    assert len([node for node in nodes if node["type"] == "frame"]) == 4

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


def test_directed_upstream_context_is_inherited_and_generation_stays_in_target(
    tmp_path: Path, monkeypatch
) -> None:
    client, _ = _client(tmp_path, monkeypatch)
    project = client.post(
        "/api/projects", json={"name": "有向上下文", "idea": "测试", "brief": ""}
    ).json()
    project_id = project["id"]
    canvas = client.get(f"/api/projects/{project_id}/canvas").json()
    source = next(node for node in canvas["nodes"] if node["type"] == "fact")
    target = next(node for node in canvas["nodes"] if node["type"] == "note")
    source["title"] = "上游事实"
    source["body"] = "这条事实必须出现在下游生成上下文中。"
    canvas["edges"].append({
        "id": "edge_directed_context",
        "source_node_id": source["id"],
        "target_node_id": target["id"],
        "relation": "context",
        "metadata": {"source_handle": "right", "target_handle": "left"},
    })
    saved = client.put(
        f"/api/projects/{project_id}/canvas",
        json={"nodes": canvas["nodes"], "edges": canvas["edges"], "viewport": canvas["viewport"]},
    )
    assert saved.status_code == 200
    before_count = len(saved.json()["nodes"])

    generated = client.post(
        f"/api/projects/{project_id}/nodes/{target['id']}/generate",
        json={"instruction": "整理成一句清晰判断", "use_llm": False},
    )
    assert generated.status_code == 200
    updated = generated.json()["nodes"][0]
    assert updated["id"] == target["id"]
    assert "上游事实" in updated["body"]
    assert source["id"] in updated["metadata"]["inherited_upstream_ids"]
    after = client.get(f"/api/projects/{project_id}/canvas").json()
    assert len(after["nodes"]) == before_count


def test_content_generation_job_reports_live_progress(tmp_path: Path, monkeypatch) -> None:
    client, _ = _client(tmp_path, monkeypatch)
    project = client.post(
        "/api/projects", json={"name": "进展", "idea": "生成一篇内容", "brief": ""}
    ).json()
    canvas = client.get(f"/api/projects/{project['id']}/canvas").json()
    idea = next(node for node in canvas["nodes"] if node["type"] == "idea")
    started = client.post(
        f"/api/projects/{project['id']}/content/generate/start",
        json={
            "node_ids": [idea["id"]], "format": "wechat", "title": "进展测试",
            "duration_seconds": 90, "use_llm": False, "instruction": "结构清晰",
            "save_as_asset": False,
        },
    )
    assert started.status_code == 200
    job = started.json()
    for _ in range(100):
        job = client.get(f"/api/content/jobs/{job['job_id']}").json()
        if job["status"] != "running":
            break
        time.sleep(0.02)
    assert job["status"] == "completed"
    assert job["progress"] == 100
    assert job["result"]["asset"] is None
    assert job["result"]["node"]["type"] == "output"


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
