from __future__ import annotations

from pathlib import Path

import pytest

from app.domain.knowledge import KnowledgeHit
from app.repositories.workspace import WorkspaceRepository
from app.services.workflow import ContentWorkflowService


def test_research_creates_only_model_authored_and_cited_nodes(tmp_path: Path) -> None:
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("AIDC", "800V DC 为什么重要？")
    hit = KnowledgeHit(
        "chk_real", "doc_real", "AIDC 供电架构", ("技术路径",),
        "SST→800V DC→PowerShelf", 1, ("fts",), "aidc-power-supply.md",
        10, 20, None, ("https://example.com/source",),
    )

    class Wiki:
        def gather(self, *_args, **_kwargs):
            return [hit], {"provider": "Mock", "model": "mock-reasoner"}

        def evidence(self, hits):
            return [{"chunk_id": hits[0].chunk_id, "title": hits[0].title,
                     "text": "SST→800V DC→PowerShelf", "path": hits[0].source_path}]

    class Model:
        def complete_json(self, _system, _prompt):
            return {
                "findings": [{"type": "fact", "title": "供电路径", "body": "SST 直供 800V DC",
                              "evidence_chunk_ids": ["chk_real"]}],
                "directions": [{"title": f"路线{i}", "body": "基于供电路径", "source_finding_indexes": [0]}
                               for i in range(3)],
            }, {"provider": "Mock", "model": "mock-reasoner"}

    workflow = ContentWorkflowService(repo, None, None, Model(), Wiki())
    nodes, run_id, used_llm, _ = workflow.quick_research(project["id"], "source_real", "800V DC 为什么重要？", 3, True)
    assert used_llm is True
    assert len(nodes) == 4
    assert all(node["created_by"] == "ai" for node in nodes)
    assert nodes[0]["metadata"]["evidence"][0]["chunk_id"] == "chk_real"
    assert repo.list_runs(project["id"])[0]["model_name"] == "mock-reasoner"


def test_model_error_leaves_no_fake_research_nodes(tmp_path: Path) -> None:
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("AIDC", "800V DC 为什么重要？")

    class FailedWiki:
        def gather(self, *_args, **_kwargs):
            raise RuntimeError("模型服务不可用")

    workflow = ContentWorkflowService(repo, None, None, None, FailedWiki())
    original = len(repo.get_canvas(project["id"])["nodes"])
    with pytest.raises(RuntimeError, match="模型服务不可用"):
        workflow.quick_research(project["id"], "source_real", "800V DC", 3, True)
    assert len(repo.get_canvas(project["id"])["nodes"]) == original
    assert not repo.list_runs(project["id"])


def test_canvas_ai_error_does_not_create_a_template_node(tmp_path: Path) -> None:
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("AIDC", "800V DC 为什么重要？")
    idea = next(item for item in repo.get_canvas(project["id"])["nodes"] if item["type"] == "idea")

    class Sources:
        def list_sources(self):
            return []

    class Retrieval:
        manifest = Sources()

    class Model:
        def complete(self, *_args):
            raise RuntimeError("模型服务不可用")

    original = len(repo.get_canvas(project["id"])["nodes"])
    workflow = ContentWorkflowService(repo, Retrieval(), None, Model(), None)
    with pytest.raises(RuntimeError, match="模型服务不可用"):
        workflow.magic(project["id"], [idea["id"]], "从 Wiki 提炼事实", "insight")
    assert len(repo.get_canvas(project["id"])["nodes"]) == original
    assert repo.list_runs(project["id"])[0]["status"] == "failed"


def test_research_direction_indexes_follow_validated_findings(tmp_path: Path) -> None:
    repo = WorkspaceRepository(tmp_path / "app.db")
    workflow = ContentWorkflowService(repo, None, None, None, None)
    hits = [type("Hit", (), {"chunk_id": "real"})()]
    payload = workflow._validate_research_payload({
        "findings": [
            {"type": "fact", "title": "伪造", "body": "", "evidence_chunk_ids": ["fake"]},
            {"type": "fact", "title": "可信", "body": "", "evidence_chunk_ids": ["real"]},
        ],
        "directions": [
            {"title": f"方向{index}", "body": "", "source_finding_indexes": [1]}
            for index in range(3)
        ],
    }, hits, 3)
    assert [item["title"] for item in payload["findings"]] == ["可信"]
    assert all(item["source_finding_indexes"] == [0] for item in payload["directions"])
