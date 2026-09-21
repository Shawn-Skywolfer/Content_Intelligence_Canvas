import asyncio
import os
from pathlib import Path

import pytest

from app.config import RetrievalConfig
from app.repositories.knowledge_manifest import KnowledgeManifestRepository
from app.repositories.lance_chunk_store import LanceChunkStore
from app.services.knowledge.chunker import HeadingAwareChunker
from app.services.knowledge.indexer import WikiIndexService
from app.services.knowledge.parser import WikiMarkdownParser
from app.services.retrieval.embedding import LocalHashEmbeddingProvider
from app.services.retrieval.hybrid import HybridRetrievalService


@pytest.mark.integration
def test_real_wiki_quality(tmp_path: Path) -> None:
    value = os.getenv("CIC_REAL_WIKI")
    if not value:
        pytest.skip("Set CIC_REAL_WIKI to run the real-Wiki integration test")
    wiki = Path(value)
    config = RetrievalConfig()
    embeddings = LocalHashEmbeddingProvider(config.embedding_dimensions)
    manifest = KnowledgeManifestRepository(tmp_path / "app.db")
    store = LanceChunkStore(tmp_path / "lancedb", embeddings.dimensions)
    indexer = WikiIndexService(
        manifest,
        store,
        WikiMarkdownParser(),
        HeadingAwareChunker(config.max_chunk_chars, config.min_chunk_chars),
        embeddings,
    )
    report = asyncio.run(indexer.refresh("test", wiki))
    retrieval = HybridRetrievalService(manifest, store, embeddings, config)
    second_report = asyncio.run(indexer.refresh("test", wiki))
    hits = retrieval.search(report.source_id, "system", 10)
    assert report.discovered > 0
    assert not report.warnings
    assert report.chunks_written > 0
    assert second_report.indexed == 0
    assert second_report.unchanged == second_report.discovered
    assert hits
    assert any(hit.heading_path and hit.original_references for hit in hits)
    assert any("wikilink" in hit.retrieval_reasons for hit in hits)
