from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

from app.domain.knowledge import (
    HealthResult,
    KnowledgeDocument,
    KnowledgeDocumentRef,
)


class LocalVaultConnector:
    """Read-only Markdown connector rooted at a validated local directory."""

    def __init__(self, root: Path) -> None:
        self.root = root.expanduser().resolve()

    async def health_check(self) -> HealthResult:
        if not self.root.exists():
            return HealthResult(False, "Wiki folder does not exist")
        if not self.root.is_dir():
            return HealthResult(False, "Wiki path is not a folder")
        count = len(await self.list_documents())
        return HealthResult(True, "OK", {"markdown_files": count, "root": str(self.root)})

    async def list_documents(self) -> list[KnowledgeDocumentRef]:
        if not self.root.is_dir():
            return []

        def scan() -> list[KnowledgeDocumentRef]:
            refs: list[KnowledgeDocumentRef] = []
            for path in sorted(self.root.rglob("*.md")):
                if not path.is_file() or path.is_symlink():
                    continue
                resolved = path.resolve()
                if not resolved.is_relative_to(self.root):
                    continue
                stat = resolved.stat()
                refs.append(
                    KnowledgeDocumentRef(
                        relative_path=resolved.relative_to(self.root).as_posix(),
                        absolute_path=resolved,
                        mtime_ns=stat.st_mtime_ns,
                        size=stat.st_size,
                    )
                )
            return refs

        return await asyncio.to_thread(scan)

    async def read_document(self, ref: KnowledgeDocumentRef) -> KnowledgeDocument:
        path = ref.absolute_path.resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("Document escapes configured Wiki root")

        def read() -> KnowledgeDocument:
            raw = path.read_bytes()
            text = raw.decode("utf-8-sig")
            revision = hashlib.sha256(raw).hexdigest()
            return KnowledgeDocument(ref=ref, text=text, revision=revision)

        return await asyncio.to_thread(read)

    async def get_revision(self, ref: KnowledgeDocumentRef) -> str:
        return (await self.read_document(ref)).revision

