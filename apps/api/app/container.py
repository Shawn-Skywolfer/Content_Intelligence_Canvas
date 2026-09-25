from __future__ import annotations

from functools import lru_cache

from app.config import Settings
from app.repositories.knowledge_manifest import KnowledgeManifestRepository
from app.repositories.lance_chunk_store import LanceChunkStore
from app.repositories.workspace import WorkspaceRepository
from app.services.ai.gateway import AIProviderGateway
from app.services.ai.secret_store import LocalSecretStore
from app.services.knowledge.chunker import HeadingAwareChunker
from app.services.knowledge.indexer import WikiIndexService
from app.services.knowledge.parser import WikiMarkdownParser
from app.services.knowledge.wiki_reasoning import WikiReasoningService
from app.services.retrieval.embedding import LocalHashEmbeddingProvider
from app.services.retrieval.hybrid import HybridRetrievalService
from app.services.workflow import ContentWorkflowService


class AppContainer:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        self.embeddings = LocalHashEmbeddingProvider(settings.retrieval.embedding_dimensions)
        self.manifest = KnowledgeManifestRepository(settings.data_dir / "app.db")
        self.workspace = WorkspaceRepository(settings.data_dir / "app.db")
        self.secrets = LocalSecretStore(settings.data_dir / "secrets.json")
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
        self.ai = AIProviderGateway(self.workspace, self.secrets)
        self.wiki_reasoning = WikiReasoningService(self.retrieval, self.chunk_store, self.ai)
        self.workflow = ContentWorkflowService(
            self.workspace, self.retrieval, self.chunk_store, self.ai, self.wiki_reasoning
        )


@lru_cache(maxsize=1)
def get_container() -> AppContainer:
    return AppContainer(Settings.from_env())
