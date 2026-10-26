from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from app.domain.knowledge import ParsedWikiDocument


class KnowledgeManifestRepository:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connect() as db:
            db.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS knowledge_sources (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    connector_type TEXT NOT NULL,
                    root_path TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS knowledge_documents (
                    source_id TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    document_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    document_type TEXT NOT NULL,
                    revision_hash TEXT NOT NULL,
                    mtime_ns INTEGER NOT NULL,
                    size INTEGER NOT NULL,
                    metadata_json TEXT NOT NULL,
                    wikilinks_json TEXT NOT NULL,
                    references_json TEXT NOT NULL,
                    indexed_at TEXT NOT NULL,
                    PRIMARY KEY (source_id, relative_path)
                );
                CREATE INDEX IF NOT EXISTS ix_documents_id ON knowledge_documents(document_id);
                """
            )

    def upsert_source(self, source_id: str, name: str, root_path: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as db:
            db.execute(
                """
                INSERT INTO knowledge_sources(id, name, connector_type, root_path, created_at, updated_at)
                VALUES (?, ?, 'local_vault', ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  name=excluded.name, root_path=excluded.root_path, updated_at=excluded.updated_at
                """,
                (source_id, name, root_path, now, now),
            )

    def get_source(self, source_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM knowledge_sources WHERE id = ?", (source_id,)).fetchone()
            return dict(row) if row else None

    def list_sources(self) -> list[dict[str, Any]]:
        with self._connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM knowledge_sources ORDER BY created_at")]

    def delete_source(self, source_id: str) -> list[str]:
        """Remove a source manifest and return its indexed document ids."""
        with self._connect() as db:
            rows = db.execute(
                "SELECT document_id FROM knowledge_documents WHERE source_id = ?", (source_id,)
            ).fetchall()
            db.execute("DELETE FROM knowledge_documents WHERE source_id = ?", (source_id,))
            db.execute("DELETE FROM knowledge_sources WHERE id = ?", (source_id,))
        return [str(row["document_id"]) for row in rows]

    def documents_for_source(self, source_id: str) -> dict[str, dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM knowledge_documents WHERE source_id = ?", (source_id,)
            ).fetchall()
        result: dict[str, dict[str, Any]] = {}
        for row in rows:
            item = dict(row)
            item["metadata"] = json.loads(item.pop("metadata_json"))
            item["wikilinks"] = json.loads(item.pop("wikilinks_json"))
            item["references"] = json.loads(item.pop("references_json"))
            result[item["relative_path"]] = item
        return result

    def upsert_document(self, document: ParsedWikiDocument, size: int) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as db:
            db.execute(
                """
                INSERT INTO knowledge_documents(
                  source_id, relative_path, document_id, title, document_type,
                  revision_hash, mtime_ns, size, metadata_json, wikilinks_json,
                  references_json, indexed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_id, relative_path) DO UPDATE SET
                  document_id=excluded.document_id, title=excluded.title,
                  document_type=excluded.document_type, revision_hash=excluded.revision_hash,
                  mtime_ns=excluded.mtime_ns, size=excluded.size,
                  metadata_json=excluded.metadata_json, wikilinks_json=excluded.wikilinks_json,
                  references_json=excluded.references_json, indexed_at=excluded.indexed_at
                """,
                (
                    document.source_id,
                    document.relative_path,
                    document.document_id,
                    document.title,
                    document.document_type,
                    document.revision,
                    document.mtime_ns,
                    size,
                    json.dumps(document.metadata, ensure_ascii=False),
                    json.dumps(document.wikilinks, ensure_ascii=False),
                    json.dumps(document.references, ensure_ascii=False),
                    now,
                ),
            )

    def delete_document(self, source_id: str, relative_path: str) -> str | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT document_id FROM knowledge_documents WHERE source_id=? AND relative_path=?",
                (source_id, relative_path),
            ).fetchone()
            db.execute(
                "DELETE FROM knowledge_documents WHERE source_id=? AND relative_path=?",
                (source_id, relative_path),
            )
        return str(row["document_id"]) if row else None
