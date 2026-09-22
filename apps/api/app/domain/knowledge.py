from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, Sequence


@dataclass(frozen=True, slots=True)
class KnowledgeDocumentRef:
    relative_path: str
    absolute_path: Path
    mtime_ns: int
    size: int


@dataclass(frozen=True, slots=True)
class KnowledgeDocument:
    ref: KnowledgeDocumentRef
    text: str
    revision: str


@dataclass(frozen=True, slots=True)
class ParsedWikiDocument:
    document_id: str
    source_id: str
    relative_path: str
    title: str
    document_type: str
    metadata: dict[str, str]
    wikilinks: tuple[str, ...]
    references: tuple[str, ...]
    raw_text: str
    revision: str
    mtime_ns: int


@dataclass(frozen=True, slots=True)
class WikiChunk:
    chunk_id: str
    document_id: str
    source_id: str
    title: str
    document_type: str
    heading_path: tuple[str, ...]
    text: str
    chunk_index: int
    source_path: str
    start_line: int
    end_line: int
    wikilink_targets: tuple[str, ...]
    references: tuple[str, ...]
    declared_updated_at: str | None


@dataclass(frozen=True, slots=True)
class HealthResult:
    healthy: bool
    message: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class KnowledgeHit:
    chunk_id: str
    document_id: str
    title: str
    heading_path: tuple[str, ...]
    excerpt: str
    score: float
    retrieval_reasons: tuple[str, ...]
    source_path: str
    start_line: int
    end_line: int
    declared_updated_at: str | None
    original_references: tuple[str, ...]
    debug: dict[str, Any] = field(default_factory=dict)


class KnowledgeConnector(Protocol):
    async def list_documents(self) -> list[KnowledgeDocumentRef]: ...
    async def read_document(self, ref: KnowledgeDocumentRef) -> KnowledgeDocument: ...
    async def get_revision(self, ref: KnowledgeDocumentRef) -> str: ...
    async def health_check(self) -> HealthResult: ...


class EmbeddingProvider(Protocol):
    @property
    def dimensions(self) -> int: ...
    def embed(self, texts: Sequence[str]) -> list[list[float]]: ...

