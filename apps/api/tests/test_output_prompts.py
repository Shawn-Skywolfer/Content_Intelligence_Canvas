from __future__ import annotations

import json
import time

from fastapi.testclient import TestClient

from app.container import get_container
from app.main import app


def test_output_prompts_reach_model_and_remain_on_node(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CIC_DATA_DIR", str(tmp_path))
    get_container.cache_clear()
    client = TestClient(app)
    project = client.post("/api/projects", json={"name": "内容项目", "idea": "选题"}).json()
    project_id = project["id"]
    idea = next(node for node in client.get(f"/api/projects/{project_id}/canvas").json()["nodes"] if node["type"] == "idea")
    calls = []

    def model(system: str, prompt: str):
        calls.append((system, json.loads(prompt)))
        return "# 有证据的草稿", {"provider": "测试模型", "model": "test"}

    monkeypatch.setattr(get_container().ai, "complete", model)
    request = {
        "node_ids": [idea["id"]], "format": "wechat", "title": "输出测试",
        "instruction": "写一篇准确的文章", "negative_prompt": "不要编造数据",
        "use_llm": True, "save_as_asset": False,
    }
    response = client.post(f"/api/projects/{project_id}/content/generate", json=request)
    assert response.status_code == 200, response.text
    node = response.json()["node"]
    assert calls[-1][1]["writing_instruction"] == request["instruction"]
    assert calls[-1][1]["negative_prompt"] == request["negative_prompt"]
    assert "负向 Prompt" in calls[-1][0]
    assert node["metadata"]["instruction"] == request["instruction"]
    assert node["metadata"]["negative_prompt"] == request["negative_prompt"]

    started = client.post(f"/api/projects/{project_id}/content/generate/start", json=request)
    assert started.status_code == 200
    for _ in range(100):
        job = client.get(f"/api/content/jobs/{started.json()['job_id']}").json()
        if job["status"] != "running":
            break
        time.sleep(.02)
    assert job["status"] == "completed", job
    assert job["result"]["node"]["metadata"]["negative_prompt"] == request["negative_prompt"]

    generated = client.post(f"/api/projects/{project_id}/magic", json={
        "node_ids": [idea["id"]], "instruction": "提炼为文案",
        "negative_prompt": "不要夸大结论", "output_type": "output",
    })
    assert generated.status_code == 200, generated.text
    assert calls[-1][1]["negative_prompt"] == "不要夸大结论"
    assert generated.json()["nodes"][0]["metadata"]["negative_prompt"] == "不要夸大结论"
    get_container.cache_clear()
