from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass
from pathlib import Path

from app.adapters.knowledge.local_vault import LocalVaultConnector
from app.domain.knowledge import EmbeddingProvider
from app.repositories.knowledge_manifest import KnowledgeManifestRepository
from app.repositories.lance_chunk_store import LanceChunkStore
from app.services.knowledge.chunker import HeadingAwareChunker
from app.services.knowledge.parser import WikiMarkdownParser


def source_id_for_path(path: Path) -> str:
    normalized = str(path.expanduser().resolve()).casefold().encode("utf-8")
    return "src_" + hashlib.sha256(normalized).hexdigest()[:20]


@dataclass(slots=True)
class IndexReport:
    source_id: str
    discovered: int = 0
    indexed: int = 0
    changed: int = 0
    unchanged: int = 0
    deleted: int = 0
    chunks_written: int = 0
    unresolved_wikilinks: list[dict[str, str]] | None = None
    warnings: list[dict[str, str]] | None = None

    def to_dict(self) -> dict:
        return asdict(self)


class WikiIndexService:
    def __init__(
        self,
        manifest: KnowledgeManifestRepository,
        store: LanceChunkStore,
        parser: WikiMarkdownParser,
        chunker: HeadingAwareChunker,
        embeddings: EmbeddingProvider,
    ) -> None:
        self.manifest = manifest
        self.store = store
        self.parser = parser
        self.chunker = chunker
        self.embeddings = embeddings

    async def refresh(self, name: str, vault_path: Path) -> IndexReport:
        connector = LocalVaultConnector(vault_path)
        health = await connector.health_check()
        if not health.healthy:
            raise ValueError(health.message)

        source_id = source_id_for_path(vault_path)
        self.manifest.upsert_source(source_id, name, str(vault_path.expanduser().resolve()))
        refs = await connector.list_documents()
        existing = self.manifest.documents_for_source(source_id)
        current_paths = {ref.relative_path for ref in refs}
        report = IndexReport(source_id=source_id, discovered=len(refs), warnings=[], unresolved_wikilinks=[])
        parsed_by_path = {}

        for ref in refs:
            previous = existing.get(ref.relative_path)
            if previous and previous["mtime_ns"] == ref.mtime_ns and previous["size"] == ref.size:
                report.unchanged += 1
                continue
            try:
                raw_document = await connector.read_document(ref)
                if previous and previous["revision_hash"] == raw_document.revision:
                    report.unchanged += 1
                    continue
                parsed = self.parser.parse(source_id, raw_document)
                chunks = self.chunker.chunk(parsed)
                vectors = self.embeddings.embed([chunk.text for chunk in chunks])
                self.store.replace_document(parsed.document_id, chunks, vectors)
                self.manifest.upsert_document(parsed, ref.size)
                parsed_by_path[ref.relative_path] = parsed
                report.indexed += 1
                report.changed += int(previous is not None)
                report.chunks_written += len(chunks)
            except Exception as exc:  # per-file tolerance is deliberate
                report.warnings.append({"path": ref.relative_path, "error": str(exc)})

        for deleted_path in sorted(set(existing) - current_paths):
            document_id = self.manifest.delete_document(source_id, deleted_path)
            if document_id:
                self.store.delete_document(document_id)
                report.deleted += 1

        all_docs = self.manifest.documents_for_source(source_id)
        stems = {Path(path).with_suffix("").as_posix() for path in all_docs}
        stem_names = {Path(path).stem for path in all_docs}
        for path, item in all_docs.items():
            for target in item["wikilinks"]:
                if target not in stems and Path(target).name not in stem_names:
                    report.unresolved_wikilinks.append({"source": path, "target": target})
        return report

