from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Sequence

import lancedb
import pyarrow as pa

from app.domain.knowledge import WikiChunk


class LanceChunkStore:
    TABLE_NAME = "wiki_chunks"

    def __init__(self, database_dir: Path, vector_dimensions: int) -> None:
        database_dir.mkdir(parents=True, exist_ok=True)
        self.db = lancedb.connect(str(database_dir))
        self.vector_dimensions = vector_dimensions

    def _schema(self) -> pa.Schema:
        return pa.schema(
            [
                pa.field("chunk_id", pa.string()),
                pa.field("document_id", pa.string()),
                pa.field("source_id", pa.string()),
                pa.field("title", pa.string()),
                pa.field("document_type", pa.string()),
                pa.field("heading_path_json", pa.string()),
                pa.field("text", pa.string()),
                pa.field("chunk_index", pa.int32()),
                pa.field("source_path", pa.string()),
                pa.field("start_line", pa.int32()),
                pa.field("end_line", pa.int32()),
                pa.field("wikilink_targets_json", pa.string()),
                pa.field("references_json", pa.string()),
                pa.field("declared_updated_at", pa.string()),
                pa.field("vector", pa.list_(pa.float32(), self.vector_dimensions)),
            ]
        )

    def _table(self):
        if self.TABLE_NAME not in self.db.list_tables().tables:
            return self.db.create_table(self.TABLE_NAME, schema=self._schema())
        return self.db.open_table(self.TABLE_NAME)

    def replace_document(self, document_id: str, chunks: Sequence[WikiChunk], vectors: Sequence[list[float]]) -> None:
        table = self._table()
        safe_id = document_id.replace("'", "''")
        table.delete(f"document_id = '{safe_id}'")
        if not chunks:
            return
        rows = [self._to_row(chunk, vector) for chunk, vector in zip(chunks, vectors, strict=True)]
        table.add(rows)

    def delete_document(self, document_id: str) -> None:
        if self.TABLE_NAME not in self.db.list_tables().tables:
            return
        safe_id = document_id.replace("'", "''")
        self.db.open_table(self.TABLE_NAME).delete(f"document_id = '{safe_id}'")

    def all_for_source(self, source_id: str) -> list[dict[str, Any]]:
        if self.TABLE_NAME not in self.db.list_tables().tables:
            return []
        safe_id = source_id.replace("'", "''")
        arrow = self.db.open_table(self.TABLE_NAME).search().where(
            f"source_id = '{safe_id}'", prefilter=True
        ).limit(100_000).to_arrow()
        return [self._from_row(row) for row in arrow.to_pylist()]

    def get_chunk(self, chunk_id: str) -> dict[str, Any] | None:
        if self.TABLE_NAME not in self.db.list_tables().tables:
            return None
        safe_id = chunk_id.replace("'", "''")
        arrow = self.db.open_table(self.TABLE_NAME).search().where(
            f"chunk_id = '{safe_id}'", prefilter=True
        ).limit(1).to_arrow()
        rows = arrow.to_pylist()
        return self._from_row(rows[0]) if rows else None

    def adjacent_chunks(self, document_id: str, chunk_index: int, radius: int = 1) -> list[dict[str, Any]]:
        if self.TABLE_NAME not in self.db.list_tables().tables:
            return []
        safe_id = document_id.replace("'", "''")
        lower = max(0, chunk_index - radius)
        upper = chunk_index + radius
        arrow = self.db.open_table(self.TABLE_NAME).search().where(
            f"document_id = '{safe_id}' AND chunk_index >= {lower} AND chunk_index <= {upper}",
            prefilter=True,
        ).limit(radius * 2 + 1).to_arrow()
        rows = [self._from_row(row) for row in arrow.to_pylist()]
        return sorted(rows, key=lambda item: item["chunk_index"])

    @staticmethod
    def _to_row(chunk: WikiChunk, vector: list[float]) -> dict[str, Any]:
        return {
            "chunk_id": chunk.chunk_id,
            "document_id": chunk.document_id,
            "source_id": chunk.source_id,
            "title": chunk.title,
            "document_type": chunk.document_type,
            "heading_path_json": json.dumps(chunk.heading_path, ensure_ascii=False),
            "text": chunk.text,
            "chunk_index": chunk.chunk_index,
            "source_path": chunk.source_path,
            "start_line": chunk.start_line,
            "end_line": chunk.end_line,
            "wikilink_targets_json": json.dumps(chunk.wikilink_targets, ensure_ascii=False),
            "references_json": json.dumps(chunk.references, ensure_ascii=False),
            "declared_updated_at": chunk.declared_updated_at or "",
            "vector": vector,
        }

    @staticmethod
    def _from_row(row: dict[str, Any]) -> dict[str, Any]:
        row["heading_path"] = tuple(json.loads(row.pop("heading_path_json")))
        row["wikilink_targets"] = tuple(json.loads(row.pop("wikilink_targets_json")))
        row["references"] = tuple(json.loads(row.pop("references_json")))
        row["declared_updated_at"] = row["declared_updated_at"] or None
        return row
