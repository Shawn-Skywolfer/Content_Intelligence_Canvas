from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from app.container import get_container
from app.main import app


def test_complete_local_vertical_slice(tmp_path: Path, monkeypatch) -> None:
    data_dir = tmp_path / "data"
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    (wiki / "concept-alpha.md").write_text(
        """# Alpha 能源系统

## 核心事实

Alpha 系统通过模块化设计提升供电连续性，并降低部署复杂度。

## 相关概念

参见 [[concept-beta]]。

## 参考来源

https://example.com/alpha
""",
        encoding="utf-8",
    )
    (wiki / "concept-beta.md").write_text(
        """# Beta 调度能力

## 应用价值

Beta 调度能力可以在负载变化时协调多个能源单元。

## 参考来源

https://example.com/beta
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("CIC_DATA_DIR", str(data_dir))
    get_container.cache_clear()
    client = TestClient(app)

    source = client.post(
        "/api/knowledge-sources", json={"name": "测试 Wiki", "root_path": str(wiki)}
    )
    assert source.status_code == 200
    source_id = source.json()["id"]
    report = client.post(f"/api/knowledge-sources/{source_id}/refresh")
    assert report.status_code == 200
    assert report.json()["discovered"] == 2

    search = client.post(
        "/api/knowledge/search",
        json={
            "source_id": source_id,
            "query": "Alpha 系统有什么价值",
            "top_k": 5,
            "lexical_weight": 1,
            "semantic_weight": 1,
            "wikilink_enabled": True,
            "wikilink_weight": 0.75,
            "max_per_document": 2,
        },
    )
    assert search.status_code == 200
    assert search.json()["hits"]
    chunk_id = search.json()["hits"][0]["chunk_id"]
    detail = client.get(f"/api/knowledge/chunks/{chunk_id}")
    assert detail.status_code == 200
    assert detail.json()["full_text"]
    assert detail.json()["context"]

    project = client.post(
        "/api/projects",
        json={"name": "测试内容项目", "idea": "Alpha 系统的内容机会", "brief": "面向业务决策者"},
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    research = client.post(
        f"/api/projects/{project_id}/research/quick",
        json={
            "source_id": source_id,
            "query": "Alpha 系统有什么价值",
            "finding_count": 3,
            "use_llm": False,
        },
    )
    assert research.status_code == 200
    assert len(research.json()["nodes"]) == 6
    assert research.json()["used_llm"] is False

    canvas = client.get(f"/api/projects/{project_id}/canvas")
    assert canvas.status_code == 200
    nodes = canvas.json()["nodes"]
    finding_ids = [node["id"] for node in nodes if node["type"] in {"fact", "internal_knowledge"}]
    assert len(finding_ids) >= 2

    magic = client.post(
        f"/api/projects/{project_id}/magic",
        json={
            "node_ids": finding_ids[:2],
            "instruction": "合并成一个核心判断",
            "output_type": "insight",
        },
    )
    assert magic.status_code == 200
    insight_id = magic.json()["nodes"][0]["id"]
    challenge = client.post(
        f"/api/projects/{project_id}/magic",
        json={
            "node_ids": finding_ids[:2],
            "instruction": "挑战这些观点并指出证据缺口",
            "output_type": "challenge",
        },
    )
    assert challenge.status_code == 200
    assert challenge.json()["nodes"][0]["type"] == "challenge"
    pattern = client.post(
        f"/api/projects/{project_id}/magic",
        json={
            "node_ids": finding_ids[:2],
            "instruction": "保存为可复用的创意模式",
            "output_type": "creative_pattern",
        },
    )
    assert pattern.status_code == 200
    assert pattern.json()["nodes"][0]["type"] == "creative_pattern"

    concept = client.post(
        f"/api/projects/{project_id}/concept",
        json={"node_ids": [insight_id, finding_ids[0]], "title": "Alpha 内容概念", "use_llm": False},
    )
    assert concept.status_code == 200
    concept_id = concept.json()["nodes"][0]["id"]
    locked = client.patch(
        f"/api/projects/{project_id}/nodes/{concept_id}", json={"locked": True}
    )
    assert locked.status_code == 200
    refused = client.patch(
        f"/api/projects/{project_id}/nodes/{concept_id}", json={"body": "不应覆盖"}
    )
    assert refused.status_code == 409
    unlocked = client.patch(
        f"/api/projects/{project_id}/nodes/{concept_id}",
        json={"locked": False, "status": "candidate"},
    )
    assert unlocked.status_code == 200
    assert unlocked.json()["locked"] is False
    relocked = client.patch(
        f"/api/projects/{project_id}/nodes/{concept_id}", json={"locked": True}
    )
    assert relocked.status_code == 200

    bodies: list[str] = []
    for format_name in ("wechat", "video_script", "poster_campaign"):
        generated = client.post(
            f"/api/projects/{project_id}/content/generate",
            json={
                "node_ids": [concept_id],
                "format": format_name,
                "title": "",
                "duration_seconds": 90,
                "use_llm": False,
            },
        )
        assert generated.status_code == 200
        bodies.append(generated.json()["asset"]["body"])
    assert len(set(bodies)) == 3
    assert len(client.get(f"/api/projects/{project_id}/assets").json()) == 3

    secret = "unit-test-secret-value"
    provider = client.post(
        "/api/providers",
        json={
            "name": "测试兼容模型",
            "protocol": "openai_compatible",
            "base_url": "http://127.0.0.1:9999/v1",
            "api_key": secret,
            "model_name": "test-model",
            "enabled": True,
            "is_external": False,
            "temperature": 0.2,
            "max_tokens": 1000,
            "timeout_seconds": 5,
            "extra": {},
        },
    )
    assert provider.status_code == 200
    assert provider.json()["has_api_key"] is True
    assert "api_key" not in provider.json()

    class MockModelResponse:
        status_code = 200

        @staticmethod
        def raise_for_status() -> None:
            return None

        @staticmethod
        def json() -> dict:
            return {"choices": [{"message": {"content": "OK"}}]}

    monkeypatch.setattr("app.services.ai.gateway.AIProviderGateway._request", lambda *args, **kwargs: MockModelResponse())
    health = client.post(f"/api/providers/{provider.json()['id']}/test")
    assert health.status_code == 200
    assert health.json()["capability_test"] is True
    assert health.json()["message"] == "连接成功"

    class MockModelsResponse:
        status_code = 200

        @staticmethod
        def raise_for_status() -> None:
            return None

        @staticmethod
        def json() -> dict:
            return {"data": [{"id": "deepseek-chat"}, {"id": "deepseek-reasoner"}]}

    monkeypatch.setattr("app.services.ai.gateway.AIProviderGateway._request", lambda *args, **kwargs: MockModelsResponse())
    models = client.post(
        "/api/providers/discover-models",
        json={
            "provider_id": provider.json()["id"],
            "base_url": "https://api.deepseek.com",
            "timeout_seconds": 5,
        },
    )
    assert models.status_code == 200
    assert models.json()["models"] == ["deepseek-chat", "deepseek-reasoner"]
    with sqlite3.connect(data_dir / "app.db") as db:
        rows = db.execute("SELECT * FROM provider_configs").fetchall()
        assert rows
        assert all(secret not in str(row) for row in rows)

    exported = client.get(f"/api/projects/{project_id}/export?format=json")
    assert exported.status_code == 200
    assert secret not in exported.text
    assert "测试内容项目" in exported.text
    assert client.get(f"/api/projects/{project_id}/runs").json()
    get_container.cache_clear()
