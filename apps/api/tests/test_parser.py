from pathlib import Path

from app.domain.knowledge import KnowledgeDocument, KnowledgeDocumentRef
from app.services.knowledge.parser import WikiMarkdownParser, infer_document_type


def make_document(text: str, path: str = "demo-test.md") -> KnowledgeDocument:
    ref = KnowledgeDocumentRef(path, Path("/tmp") / path, 123, len(text.encode()))
    return KnowledgeDocument(ref, text, "revision")


def test_extracts_title_metadata_links_and_references() -> None:
    text = """# Demo Concept (DC)

> **领域**：Demo Domain | **最后更新**: 2026-09-13

See [[topic-related|Related Topic]] and [[topic-secondary#定义]].
[Source](https://example.com/report.pdf)
"""
    parsed = WikiMarkdownParser().parse("src_test", make_document(text))
    assert parsed.title == "Demo Concept (DC)"
    assert parsed.metadata == {"领域": "Demo Domain", "最后更新": "2026-09-13"}
    assert parsed.wikilinks == ("topic-related", "topic-secondary")
    assert parsed.references == ("https://example.com/report.pdf",)
    assert parsed.document_type == "topic"


def test_type_inference_is_tolerant() -> None:
    assert infer_document_type("nested/product-x.md") == "product"
    assert infer_document_type("source-report.md") == "source"
    assert infer_document_type("other.md") == "topic"
