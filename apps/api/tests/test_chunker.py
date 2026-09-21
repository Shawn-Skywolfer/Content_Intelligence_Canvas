from pathlib import Path

from app.domain.knowledge import KnowledgeDocument, KnowledgeDocumentRef
from app.services.knowledge.chunker import HeadingAwareChunker
from app.services.knowledge.parser import WikiMarkdownParser


def test_heading_aware_chunks_keep_context_and_lines() -> None:
    text = """# Demo

> **最后更新**：2026-09-20

## 定义

第一段内容，关联 [[topic-a]]。

### 细节

第二段内容。

## 参考文献

[Source](https://example.com)
"""
    ref = KnowledgeDocumentRef("concept-demo.md", Path("/tmp/concept-demo.md"), 1, len(text))
    parsed = WikiMarkdownParser().parse("src", KnowledgeDocument(ref, text, "rev"))
    chunks = HeadingAwareChunker(max_chars=500).chunk(parsed)
    assert any(chunk.heading_path == ("定义",) for chunk in chunks)
    assert any(chunk.heading_path == ("定义", "细节") for chunk in chunks)
    assert any("topic-a" in chunk.wikilink_targets for chunk in chunks)
    assert all(chunk.start_line <= chunk.end_line for chunk in chunks)
    assert all(chunk.declared_updated_at == "2026-09-20" for chunk in chunks)


def test_long_section_splits_on_paragraphs() -> None:
    body = "\n\n".join(["段落" + str(i) + "。" * 40 for i in range(10)])
    text = f"# Demo\n\n## 长章节\n\n{body}\n"
    ref = KnowledgeDocumentRef("demo.md", Path("/tmp/demo.md"), 1, len(text))
    parsed = WikiMarkdownParser().parse("src", KnowledgeDocument(ref, text, "rev"))
    chunks = HeadingAwareChunker(max_chars=160, min_chars=10).chunk(parsed)
    assert len(chunks) > 1
    assert all(chunk.heading_path == ("长章节",) for chunk in chunks)
