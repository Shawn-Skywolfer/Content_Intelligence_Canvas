from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app.domain.knowledge import KnowledgeDocument, KnowledgeDocumentRef, KnowledgeHit
from app.services.knowledge.chunker import HeadingAwareChunker
from app.services.knowledge.parser import WikiMarkdownParser
from app.services.knowledge.wiki_reasoning import WikiReasoningService


def test_model_plans_and_answers_from_actual_wiki() -> None:
    root = os.environ.get("CIC_REAL_WIKI")
    if not root:
        pytest.skip("Set CIC_REAL_WIKI to the user's extracted Wiki")
    file = Path(root) / "aidc-power-supply.md"
    assert file.is_file()
    document = KnowledgeDocument(
        ref=KnowledgeDocumentRef(file.name, file, file.stat().st_mtime_ns, file.stat().st_size),
        text=file.read_text(encoding="utf-8"),
        revision="test",
    )
    chunks = HeadingAwareChunker().chunk(WikiMarkdownParser().parse("local", document))
    assert chunks

    class Store:
        def get_chunk(self, chunk_id):
            return {"text": next(item.text for item in chunks if item.chunk_id == chunk_id)}

    class Retrieval:
        def __init__(self):
            self.queries = []

        def search(self, _source_id, query, top_k, **_options):
            self.queries.append(query)
            matches = [chunk for chunk in chunks if "800v" in chunk.text.lower()]
            return [KnowledgeHit(
                chunk_id=item.chunk_id, document_id=item.document_id, title=item.title,
                heading_path=item.heading_path, excerpt=item.text[:700], score=1,
                retrieval_reasons=("fts",), source_path=item.source_path,
                start_line=item.start_line, end_line=item.end_line,
                declared_updated_at=item.declared_updated_at, original_references=item.references,
            ) for item in matches[:top_k]]

    class Model:
        def __init__(self):
            self.read_text = ""

        def complete_json(self, _system, prompt):
            data = json.loads(prompt)
            trace = {"provider": "测试", "model": "模拟模型"}
            if "wiki_evidence" not in data:
                return {"queries": ["AIDC 800V DC 供电架构"]}, trace
            self.read_text = "\n".join(item["text"] for item in data["wiki_evidence"])
            return {"answer": "Wiki 对 800V DC 的描述见原文。[证据1]", "evidence_chunk_ids": [data["wiki_evidence"][0]["chunk_id"]]}, trace

    retrieval = Retrieval()
    model = Model()
    service = WikiReasoningService(retrieval, Store(), model)
    hits, _ = service.gather("local", "AIDC 为什么讨论 800V DC？")
    answer, references, trace = service.answer("AIDC 为什么讨论 800V DC？", hits)
    assert retrieval.queries == ["AIDC 为什么讨论 800V DC？", "AIDC 800V DC 供电架构"]
    assert "800V" in model.read_text
    assert references[0].chunk_id in {chunk.chunk_id for chunk in chunks}
    assert "[证据1]" in answer
    assert trace["model"] == "模拟模型"


def test_cannot_show_fabricated_evidence() -> None:
    class Model:
        def complete_json(self, _system, _prompt):
            return {"answer": "不存在的断言。[证据1]", "evidence_chunk_ids": ["fabricated"]}, {"provider": "测试", "model": "模拟模型"}

    service = WikiReasoningService(None, None, Model())
    with pytest.raises(ValueError, match="不存在的 Wiki 证据"):
        service.answer("问题", [])
