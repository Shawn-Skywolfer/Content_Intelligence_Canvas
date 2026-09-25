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
    assert repaired.json()["edges"] == []

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


def test_legacy_starter_link_is_removed_once_without_erasing_user_links(tmp_path: Path, monkeypatch) -> None:
    client, data_dir = _client(tmp_path, monkeypatch)
    project_id = client.post("/api/projects", json={"name": "旧白板", "idea": "想法", "brief": ""}).json()["id"]
    canvas = client.get(f"/api/projects/{project_id}/canvas").json()
    idea = next(node for node in canvas["nodes"] if node["type"] == "idea")
    brief = next(node for node in canvas["nodes"] if node["type"] == "brief")
    with sqlite3.connect(data_dir / "app.db") as db:
        # A migrated legacy project has not yet received the one-time cleanup marker.
        db.execute("DELETE FROM app_settings WHERE key=?", (f"starter_edges_checked:{project_id}",))
        db.execute("UPDATE canvas_nodes SET parent_id=? WHERE id=?", (idea["id"], brief["id"]))
        db.execute(
            """INSERT INTO canvas_edges(id,project_id,canvas_id,source_node_id,target_node_id,relation,metadata_json,created_at)
            VALUES(?,?,?,?,?,?,?,datetime('now'))""",
            ("legacy_starter", project_id, idea["canvas_id"], idea["id"], brief["id"], "derived_from", "{}"),
        )
    assert client.get(f"/api/projects/{project_id}/canvas").json()["edges"] == []
    canvas["edges"] = [{"id": "user_link", "source_node_id": idea["id"], "target_node_id": brief["id"], "relation": "derived_from", "metadata": {}}]
    assert client.put(f"/api/projects/{project_id}/canvas", json=canvas).status_code == 200
    assert [edge["id"] for edge in client.get(f"/api/projects/{project_id}/canvas").json()["edges"]] == ["user_link"]


def test_existing_research_board_removes_only_unused_examples(tmp_path: Path, monkeypatch) -> None:
    client, _ = _client(tmp_path, monkeypatch)
    project_id = client.post("/api/projects", json={"name": "旧研究项目", "idea": "AIDC 液冷", "brief": ""}).json()["id"]
    before = client.get(f"/api/projects/{project_id}/canvas").json()
    repo = get_container().workspace
    idea = next(node for node in before["nodes"] if node["type"] == "idea")
    edited = next(node for node in before["nodes"] if node["type"] == "knowledge")
    linked = next(node for node in before["nodes"] if node["type"] == "fact")
    repo.update_node(project_id, edited["id"], {"body": "我自己修改过的知识材料"})
    repo.create_edge(project_id, idea["id"], linked["id"])
    generated = repo.create_node(project_id, {
        "type": "fact", "title": "真实研究事实", "body": "基于知识库的事实", "x": 1800, "y": 40,
        "metadata": {"research_query": "AIDC 液冷"},
    })
    run_id = repo.create_run(project_id, "quick_research", "AIDC 液冷", [])
    repo.finish_run(run_id, [generated["id"]], None, None)
    migrated = client.get(f"/api/projects/{project_id}/canvas").json()
    ids = {node["id"] for node in migrated["nodes"]}
    assert {edited["id"], linked["id"], generated["id"]} <= ids
    assert len([node for node in migrated["nodes"] if node["metadata"].get("starter_template")]) == 2
    assert len([node for node in migrated["nodes"] if node["type"] == "frame"]) == 3
    assert len(migrated["edges"]) == 1
    assert next(node for node in migrated["nodes"] if node["id"] == edited["id"])["body"] == "我自己修改过的知识材料"


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

    def wiki_model(_system: str, prompt: str):
        import json
        data = json.loads(prompt)
        trace = {"provider": "测试模型", "model": "test-model"}
        if "evidence" not in data:
            return {"queries": ["本地知识库 可追溯事实"]}, trace
        chunk_id = data["evidence"][0]["chunk_id"]
        return {
            "findings": [
                {"type": "fact", "title": f"发现{index}", "body": "知识库保存可追溯事实", "evidence_chunk_ids": [chunk_id]}
                for index in range(3)
            ],
            "directions": [
                {"title": f"方向{index}", "body": "基于证据的方向", "source_finding_indexes": [index]}
                for index in range(3)
            ],
        }, trace

    monkeypatch.setattr(get_container().ai, "complete_json", wiki_model)
    monkeypatch.setattr(get_container().ai, "complete", lambda _system, _prompt: (
        "依据 Wiki 合并的研究结论", {"provider": "测试模型", "model": "test-model"}
    ))

    started = client.post(
        f"/api/projects/{project['id']}/research/quick/start",
        json={
            "source_id": source["id"],
            "query": "本地知识库有什么价值",
            "finding_count": 3,
            "use_llm": True,
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
    history = client.get(f"/api/projects/{project['id']}/runs")
    assert history.status_code == 200
    assert history.json()[0]["action"] == "quick_research"
    assert history.json()[0]["prompt"] == "本地知识库有什么价值"
    assert len(history.json()[0]["output_node_ids"]) == len(job["result"]["nodes"])

    board = client.get(f"/api/projects/{project['id']}/canvas").json()
    frames = [node for node in board["nodes"] if node["type"] == "frame"]
    assert [frame["metadata"]["group_key"] for frame in frames] == ["input", "research", "thinking"]
    assert not any(node["metadata"].get("starter_template") for node in board["nodes"])
    results = [node for node in board["nodes"] if node["id"] in history.json()[0]["output_node_ids"]]
    assert len(results) == len(job["result"]["nodes"])
    for node in results:
        frame = next(frame for frame in frames if frame["x"] <= node["x"] < frame["x"] + frame["width"])
        assert frame["metadata"]["group_key"] in {"research", "thinking"}
        assert node["y"] + node["height"] <= frame["y"] + frame["height"]
    assert all(
        left["x"] + left["width"] <= right["x"] or right["x"] + right["width"] <= left["x"]
        or left["y"] + left["height"] <= right["y"] or right["y"] + right["height"] <= left["y"]
        for index, left in enumerate(results) for right in results[index + 1:]
    )
    assert client.get(f"/api/projects/{project['id']}/canvas").json()["nodes"] == board["nodes"]

    generated = client.post(
        f"/api/projects/{project['id']}/magic",
        json={"node_ids": [results[0]["id"], results[1]["id"]], "instruction": "综合两条研究发现", "output_type": "insight"},
    )
    assert generated.status_code == 200
    created = generated.json()["nodes"][0]
    assert created["metadata"]["source_node_ids"] == [results[0]["id"], results[1]["id"]]
    assert created["metadata"]["source_node_titles"] == [results[0]["title"], results[1]["title"]]
    after_magic = client.get(f"/api/projects/{project['id']}/canvas").json()
    assert {edge["source_node_id"] for edge in after_magic["edges"] if edge["target_node_id"] == created["id"]} == {results[0]["id"], results[1]["id"]}

    removed = client.delete(f"/api/projects/{project['id']}/research/runs/{history.json()[0]['id']}")
    assert removed.status_code == 204
    assert all(run["id"] != history.json()[0]["id"] for run in client.get(f"/api/projects/{project['id']}/runs").json())
    assert {node["id"] for node in results} <= {node["id"] for node in client.get(f"/api/projects/{project['id']}/canvas").json()["nodes"]}

    assert client.delete(f"/api/knowledge-sources/{source['id']}").status_code == 204
    assert client.get("/api/knowledge-sources").json() == []
