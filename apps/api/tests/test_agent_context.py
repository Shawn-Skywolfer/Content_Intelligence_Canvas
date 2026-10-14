from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app.adapters.knowledge.local_vault import LocalVaultConnector
from app.services.knowledge.agent_context import AgentContextService
from app.services.knowledge.wiki_reasoning import WikiReasoningService


class Manifest:
    def __init__(self, root: Path) -> None:
        self.root = root

    def get_source(self, source_id: str):
        return {"root_path": str(self.root)} if source_id == "wiki" else None


def make_wiki(root: Path) -> None:
    folder = root / "_agent_context"
    folder.mkdir()
    (folder / "overview.md").write_text("# 总览\nAIDC 的核心判断", encoding="utf-8")
    (folder / "domain-map.md").write_text("# 领域图\n供电与散热相互影响", encoding="utf-8")
    (folder / "relations.md").write_text("# 关系\n800V 供电关系", encoding="utf-8")
    (folder / "claims.md").write_text("# 事实清单", encoding="utf-8")
    (root / "power.md").write_text("# 供电\n原始证据：800V", encoding="utf-8")


def test_refresh_reads_both_guides_before_scanning_original_entries(tmp_path: Path) -> None:
    make_wiki(tmp_path)
    calls = []

    class Model:
        def complete_json(self, _system, prompt):
            calls.append(json.loads(prompt))
            return {"summary": "供电与散热需要联合理解", "domains": ["供电", "散热"]}, {"provider": "mock", "model": "demo"}

    service = AgentContextService(Manifest(tmp_path), Model())
    report = service.prepare_refresh("wiki")
    refs = asyncio.run(LocalVaultConnector(tmp_path).list_documents())
    assert report["status"] == "read"
    assert list(calls[0]["agent_context"]) == ["overview.md", "domain-map.md"]
    assert [item.relative_path for item in refs] == ["power.md"]


def test_research_reads_relations_only_on_demand_and_searches_original_entries(tmp_path: Path) -> None:
    make_wiki(tmp_path)
    model_inputs = []

    class Model:
        def complete_json(self, _system, prompt):
            data = json.loads(prompt)
            model_inputs.append(data)
            if len(model_inputs) == 1:
                return {"queries": ["AIDC 供电"], "read_relations": True}, {"model": "mock"}
            return {"queries": ["800V 供电关系"]}, {"model": "mock"}

    class Retrieval:
        def __init__(self):
            self.queries = []

        def search(self, _source_id, query, top_k, **_options):
            self.queries.append(query)
            return [type("Hit", (), {"chunk_id": "power", "source_path": "power.md"})()]

    model = Model()
    retrieval = Retrieval()
    context = AgentContextService(Manifest(tmp_path), model)
    hits, trace = WikiReasoningService(retrieval, None, model, context).gather("wiki", "800V 如何影响供电？")
    assert list(model_inputs[0]["agent_context"]) == ["overview.md", "domain-map.md"]
    assert "relations.md" in model_inputs[1]["agent_context"]
    assert retrieval.queries == ["800V 如何影响供电？", "AIDC 供电", "800V 供电关系"]
    assert hits[0].source_path == "power.md"
    assert trace["agent_context"]["relations.md"].startswith("# 关系")


def test_missing_guide_is_reported_and_research_does_not_skip_it(tmp_path: Path) -> None:
    make_wiki(tmp_path)
    (tmp_path / "_agent_context" / "domain-map.md").unlink()

    class Model:
        def complete_json(self, *_args):
            raise AssertionError("不能跳过缺失的全局上下文")

    service = AgentContextService(Manifest(tmp_path), Model())
    report = service.prepare_refresh("wiki")
    assert report["status"] == "failed"
    assert "domain-map.md" in report["message"]
    with pytest.raises(ValueError, match="domain-map.md"):
        WikiReasoningService(None, None, Model(), service).gather("wiki", "问题")


def test_refresh_reports_model_failure_without_exposing_raw_documents(tmp_path: Path) -> None:
    make_wiki(tmp_path)

    class Model:
        def complete_json(self, *_args):
            raise RuntimeError("模型服务暂不可用")

    result = AgentContextService(Manifest(tmp_path), Model()).prepare_refresh("wiki")
    assert result == {"status": "failed", "message": "模型服务暂不可用"}
