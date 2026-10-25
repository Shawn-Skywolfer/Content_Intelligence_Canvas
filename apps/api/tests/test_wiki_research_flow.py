from __future__ import annotations

import json
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


def test_research_synthesis_receives_global_context_from_planning(tmp_path: Path) -> None:
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("供电研究", "AIDC 供电", "面向技术决策者，比较可靠性与 TCO")
    hit = KnowledgeHit("real", "doc", "供电", (), "原始事实", 1, ("fts",),
                       "power.md", 1, 2, None, ())

    class Wiki:
        def gather(self, _source, question, **_kwargs):
            assert "面向技术决策者，比较可靠性与 TCO" in question
            return [hit], {"agent_context": {"overview.md": "全局判断", "domain-map.md": "领域关系"}}

        def evidence(self, _hits):
            return [{"chunk_id": "real", "text": "原始事实"}]

    class Model:
        def complete_json(self, _system, prompt):
            payload = json.loads(prompt)
            assert payload["project_brief"] == "面向技术决策者，比较可靠性与 TCO"
            assert payload["agent_context"] == {"overview.md": "全局判断", "domain-map.md": "领域关系"}
            return {"findings": [{"type": "fact", "title": "供电", "body": "原始事实",
                                  "evidence_chunk_ids": ["real"]}],
                    "directions": [{"title": f"方向 {i}", "body": "依据供电事实",
                                    "source_finding_indexes": [0]} for i in range(3)]}, {}

    workflow = ContentWorkflowService(repo, None, None, Model(), Wiki())
    nodes, *_ = workflow.quick_research(project["id"], "source", "AIDC 供电", 3, True)
    assert len(nodes) == 4


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


def test_research_supports_twenty_findings_and_validates_bounds(tmp_path):
    from pydantic import ValidationError
    from app.schemas.workspace import QuickResearchRequest
    assert QuickResearchRequest(source_id="wiki", query="研究问题").finding_count == 20
    with pytest.raises(ValidationError):
        QuickResearchRequest(source_id="wiki", query="研究问题", finding_count=21)
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("研究", "研究问题")
    hits = [KnowledgeHit(f"c{i}", f"d{i}", f"证据{i}", (), "原文", 1, (), f"{i}.md", 1, 2, None, ()) for i in range(30)]
    class Wiki:
        def gather(self, *args, **kwargs): return hits, {}
        def evidence(self, chosen):
            assert len(chosen) == 30
            return [{"chunk_id": h.chunk_id, "text": "原文"} for h in chosen]
    class AI:
        def complete_json(self, _system, prompt):
            assert json.loads(prompt)["finding_count"] == 20
            return {"findings": [{"type": "fact", "title": f"发现{i}", "body": "有依据的结论", "evidence_chunk_ids": [f"c{i+10}"]} for i in range(20)],
                    "directions": [{"title": f"方向{i}", "body": "可执行方向", "source_finding_indexes": [i]} for i in range(3)]}, {}
    workflow = ContentWorkflowService(repo, None, None, AI(), Wiki())
    nodes, *_ = workflow.quick_research(project["id"], "wiki", "研究问题", 20, True)
    assert len(nodes) == 23
    assert nodes[19]["metadata"]["evidence"][0]["chunk_id"] == "c29"

    # Both initial and subsequent 20-finding runs fit two subcolumns without overlaps.
    board = repo.get_canvas(project["id"])
    workflow.quick_research(project["id"], "wiki", "研究问题", 20, True)
    board = repo.get_canvas(project["id"])
    cards = [node for node in board["nodes"] if node["type"] != "frame"]
    for i, left in enumerate(cards):
        for right in cards[i + 1:]:
            overlaps = (left["x"] < right["x"] + right["width"] and right["x"] < left["x"] + left["width"]
                        and left["y"] < right["y"] + right["height"] and right["y"] < left["y"] + left["height"])
            assert not overlaps, (left["title"], right["title"])
