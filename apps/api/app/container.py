from __future__ import annotations

from functools import lru_cache

from app.config import Settings
from app.repositories.knowledge_manifest import KnowledgeManifestRepository
from app.repositories.lance_chunk_store import LanceChunkStore
from app.services.knowledge.chunker import HeadingAwareChunker
from app.services.knowledge.indexer import WikiIndexService
from app.services.knowledge.parser import WikiMarkdownParser
from app.services.retrieval.embedding import LocalHashEmbeddingProvider
from app.services.retrieval.hybrid import HybridRetrievalService


class AppContainer:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        self.embeddings = LocalHashEmbeddingProvider(settings.retrieval.embedding_dimensions)
        self.manifest = KnowledgeManifestRepository(settings.data_dir / "app.db")
        self.chunk_store = LanceChunkStore(
            settings.data_dir / "lancedb", self.embeddings.dimensions
        )
        self.indexer = WikiIndexService(
            manifest=self.manifest,
            store=self.chunk_store,
            parser=WikiMarkdownParser(),
            chunker=HeadingAwareChunker(
                settings.retrieval.max_chunk_chars, settings.retrieval.min_chunk_chars
            ),
            embeddings=self.embeddings,
        )
        self.retrieval = HybridRetrievalService(
            self.manifest, self.chunk_store, self.embeddings, settings.retrieval
        )


@lru_cache(maxsize=1)
def get_container() -> AppContainer:
    return AppContainer(Settings.from_env())

