import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app.api import knowledge as knowledge_api
from app.domain.knowledge import KnowledgeHit, KnowledgeDocument, KnowledgeDocumentRef
from app.services.knowledge.parser import WikiMarkdownParser
from app.repositories.knowledge_manifest import KnowledgeManifestRepository
from app.repositories.workspace import WorkspaceRepository
from app.services.knowledge.originals import WikiOriginalReader
from app.services.workflow import ContentWorkflowService


def fixture(tmp_path):
    manifest = KnowledgeManifestRepository(tmp_path / "manifest.db")
    chunks = {}
    texts = {}
    for source_id in ("a", "b"):
        folder = tmp_path / source_id
        folder.mkdir()
        text = f"# {source_id} 的原始 Wiki\n" + "完整论证与限定条件。\n" * 900 + f"\n末尾关键事实-{source_id}"
        (folder / "same.md").write_text(text, encoding="utf-8")
        texts[source_id] = text
        manifest.upsert_source(source_id, source_id, str(folder))
        file = folder / "same.md"
        parsed = WikiMarkdownParser().parse(source_id, KnowledgeDocument(
            KnowledgeDocumentRef("same.md", file, file.stat().st_mtime_ns, file.stat().st_size), text, "fixture"))
        manifest.upsert_document(parsed, file.stat().st_size)
        chunks[source_id] = {"chunk_id": source_id, "source_id": source_id, "source_path": "same.md", "title": source_id, "text": "仅一个短段落"}
    return manifest, SimpleNamespace(get_chunk=chunks.get), texts


def test_reader_loads_complete_current_entries_and_deduplicates_per_source(tmp_path):
    manifest, chunks, texts = fixture(tmp_path)
    reader = WikiOriginalReader(manifest, chunks)
    result = reader.read([{"chunk_id": "a", "referenced_by_node_ids": ["n1"]}, {"chunk_id": "a", "referenced_by_node_ids": ["n2"]}, {"chunk_id": "b"}])
    assert len(result) == 2
    assert result[0]["text"] == texts["a"] and result[1]["text"] == texts["b"]
    assert result[0]["referenced_by_node_ids"] == ["n1", "n2"]
    assert result[0]["read_mode"] == "full_document"
    # A refresh may invalidate chunk hashes. Stable source + relative path still resolves latest text.
    changed = "# 更新后的完整词条\n新的事实与限制"
    (tmp_path / "a" / "same.md").write_text(changed, encoding="utf-8")
    assert WikiOriginalReader(manifest, chunks).read([{"chunk_id": "stale-hash", "source_id": "a", "path": "same.md"}])[0]["text"] == changed


def test_missing_or_disabled_original_fails_instead_of_using_excerpt(tmp_path):
    manifest, chunks, _ = fixture(tmp_path)
    reader = WikiOriginalReader(manifest, chunks)
    (tmp_path / "a" / "same.md").unlink()
    with pytest.raises(ValueError, match="无法读取 Wiki 原始词条"):
        reader.read([{"chunk_id": "a", "excerpt": "不能替代原文"}])
    manifest.delete_source("b")
    with pytest.raises(ValueError, match="知识源已移除或停用"):
        reader.read([{"chunk_id": "b"}])


def test_references_cannot_escape_vault_or_ambiguously_choose_same_filename(tmp_path):
    manifest, chunks, _ = fixture(tmp_path)
    reader = WikiOriginalReader(manifest, chunks)
    secret = tmp_path / "outside.md"
    secret.write_text("不应该读取", encoding="utf-8")
    with pytest.raises(ValueError, match="拒绝读取"):
        reader.read([{"source_id": "a", "path": "../outside.md"}])
    with pytest.raises(ValueError, match="无法唯一定位"):
        reader.read([{"path": "same.md", "excerpt": "不能随便选一个库"}])


def test_downstream_output_reads_originals_across_lineage_and_enforces_unconnected_brief(tmp_path):
    manifest, chunks, texts = fixture(tmp_path)
    repo = WorkspaceRepository(tmp_path / "app.db")
    brief = "面向储能技术决策者；只写中文；不得夸大；比较可靠性与 TCO。"
    project = repo.create_project("项目", "供电方案", brief)
    a = repo.create_node(project["id"], {"type": "fact", "title": "第一份研究", "body": "派生摘要一", "metadata": {"research_source_id": "a", "evidence": [{"chunk_id": "a", "path": "same.md", "excerpt": "短摘录"}]}})
    b = repo.create_node(project["id"], {"type": "insight", "title": "第二份研究", "body": "派生摘要二", "metadata": {"source_node_ids": [a["id"]], "research_source_id": "b", "evidence": [{"chunk_id": "b", "path": "same.md"}]}})
    selected = repo.create_node(project["id"], {"title": "二次加工", "body": "只保留的摘要", "summary": "卡片摘要", "metadata": {"source_node_ids": [b["id"]]}})
    # Cyclic provenance must terminate, and an unrelated project's lineage must not be read.
    repo.update_node(project["id"], a["id"], {"metadata": {**a["metadata"], "source_node_ids": [b["id"]]}})
    prompts = []
    def model(system, prompt):
        payload = json.loads(prompt)
        prompts.append(payload)
        assert payload["project_brief"] == brief
        assert "默认硬约束" in system and "明确指出覆盖简报的具体条款" in system
        originals = {item["source_id"]: item for item in payload["wiki_evidence"]}
        assert originals["a"]["text"] == texts["a"]
        assert originals["b"]["text"] == texts["b"]
        assert all(item["read_mode"] == "full_document" for item in originals.values())
        return "# 依据原文生成的完整草稿", {"provider": "test", "model": "test"}
    hit = KnowledgeHit("a", "doc-a", "a", (), "新检索也只有摘要", 1, (), "same.md", 1, 2, None, ())
    wiki = SimpleNamespace(gather=Mock(return_value=([hit], {})))
    workflow = ContentWorkflowService(repo, SimpleNamespace(manifest=manifest), chunks, SimpleNamespace(complete=model, complete_json=lambda *args: ({"compliant": True, "violations": []}, {})), wiki)
    output, *_ = workflow.magic(project["id"], [selected["id"]], "润色并生成", "note", upstream_depth=0)
    assert prompts[-1]["inherited_upstream_context"] == []
    assert {r["source_id"] for r in output["metadata"]["evidence"]} == {"a", "b"}
    assert len(output["metadata"]["wiki_original_documents"]) == 2
    # Even if source nodes/edges are deleted later, persisted citations remain sufficient.
    repo.delete_node(project["id"], selected["id"])
    repo.delete_node(project["id"], a["id"])
    repo.delete_node(project["id"], b["id"])
    _, final, *_ = workflow.generate_content(project["id"], [output["id"]], "wechat", "最终内容", 90, True, save_as_asset=False, upstream_depth=0)
    assert final["metadata"]["project_brief_applied"] == brief
    assert final["metadata"]["brief_check"]["status"] == "passed"
    assert len(prompts) == 2


def test_original_endpoint_returns_full_markdown_and_clear_failure(tmp_path, monkeypatch):
    manifest, chunks, texts = fixture(tmp_path)
    monkeypatch.setattr(knowledge_api, "get_container", lambda: SimpleNamespace(manifest=manifest, chunk_store=chunks))
    result = knowledge_api.wiki_original(knowledge_api.WikiOriginalRequest(chunk_id="a"))
    assert result["text"] == texts["a"]
    with pytest.raises(HTTPException) as exc:
        knowledge_api.wiki_original(knowledge_api.WikiOriginalRequest(source_id="a", path="missing.md"))
    assert exc.value.status_code == 422 and "无法读取" in exc.value.detail


def test_no_new_search_hits_still_reads_valid_inherited_originals(tmp_path):
    from app.services.knowledge.wiki_reasoning import WikiNoEvidenceError
    manifest, chunks, texts = fixture(tmp_path)
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("项目", "供电", "面向客户解释适用边界")
    node = repo.create_node(project["id"], {"title": "供电研究", "body": "相关结论", "metadata": {"evidence": [{"chunk_id": "a"}]}})
    def no_hits(_source, question, **_kwargs):
        plan = json.loads(question)
        assert plan["nodes"][0]["title"] == "供电研究"
        assert plan["project_brief"] == "面向客户解释适用边界"
        raise WikiNoEvidenceError("Wiki 中没有找到可用材料")
    workflow = ContentWorkflowService(repo, SimpleNamespace(manifest=manifest), chunks, None, SimpleNamespace(gather=no_hits))
    evidence = workflow._wiki_context("润色", [node])
    assert evidence[0]["text"] == texts["a"]


def test_expired_uncited_legacy_candidate_does_not_block_stable_original_citations(tmp_path):
    manifest, chunks, texts = fixture(tmp_path)
    reader = WikiOriginalReader(manifest, chunks)
    result = reader.read([{"chunk_id": "a"}, {"chunk_id": "old-unused-candidate", "optional_candidate": True}])
    assert len(result) == 1 and result[0]["text"] == texts["a"]
    with pytest.raises(ValueError, match="已失效"):
        reader.read([{"chunk_id": "missing-actual-citation"}])
