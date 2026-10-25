from __future__ import annotations

from pathlib import Path
from typing import Any

from app.services.ai.cancellation import check_cancelled
from app.services.knowledge.source_path import clean_local_path


class WikiOriginalReader:
    """Resolve citation identities to complete, current Wiki entries, never snippets."""

    def __init__(self, manifest, chunks):
        self.manifest, self.chunks = manifest, chunks
        self._chunk_cache = {}
        self._text_cache = {}

    def read(self, references: list[dict[str, Any]]) -> list[dict[str, Any]]:
        sources = {s["id"]: s for s in self.manifest.list_sources()}
        result: dict[tuple[str, str], dict[str, Any]] = {}
        for ref in references:
            check_cancelled()
            chunk_id = str(ref.get("chunk_id") or "")
            if chunk_id and self.chunks and chunk_id not in self._chunk_cache:
                self._chunk_cache[chunk_id] = self.chunks.get_chunk(chunk_id)
            chunk = self._chunk_cache.get(chunk_id)
            source_id = str((chunk or {}).get("source_id") or ref.get("source_id") or "")
            path = str((chunk or {}).get("source_path") or ref.get("path") or "")
            if not path and ref.get("optional_candidate"):
                # Old builds recorded uncited retrieval candidates with no stable path.
                continue
            if not path:
                raise ValueError(f"Wiki 引用 {chunk_id or '未知'} 已失效，无法定位原始词条；请刷新知识库后重新研究")
            if source_id:
                source = sources.get(source_id)
                if not source or not source["enabled"]:
                    raise ValueError(f"Wiki 词条 {path} 的知识源已移除或停用，请恢复知识源后重试")
            else:
                # Legacy citations have no source ID. Resolve only an unambiguous manifest match.
                candidates = [s for s in sources.values() if s["enabled"] and path in self.manifest.documents_for_source(s["id"])]
                if len(candidates) != 1:
                    raise ValueError(f"Wiki 词条 {path} 无法唯一定位知识源（{len(candidates)} 个匹配），请重新研究以更新引用")
                source = candidates[0]
                source_id = str(source["id"])
            root = Path(clean_local_path(str(source["root_path"]))).expanduser().resolve()
            target = (root / path).resolve()
            if not target.is_relative_to(root) or target.suffix.lower() not in {".md", ".markdown"}:
                raise ValueError(f"Wiki 引用路径不在指定知识库内，拒绝读取：{path}")
            relative = target.relative_to(root).as_posix()
            identity = (source_id, relative)
            if identity not in result:
                try:
                    if identity not in self._text_cache:
                        self._text_cache[identity] = target.read_text(encoding="utf-8-sig")
                    text = self._text_cache[identity]
                except (OSError, UnicodeError) as exc:
                    raise ValueError(f"无法读取 Wiki 原始词条 {relative}：{type(exc).__name__}。请检查文件和知识库路径") from exc
                if not text.strip():
                    raise ValueError(f"Wiki 原始词条 {relative} 为空，无法作为内容生成依据")
                result[identity] = {"chunk_id": chunk_id, "source_id": source_id, "path": relative,
                                    "title": str((chunk or {}).get("title") or ref.get("title") or target.stem),
                                    "text": text, "content_chars": len(text), "read_mode": "full_document",
                                    "related_chunk_ids": [], "referenced_by_node_ids": [],
                                    "references": list((chunk or {}).get("references") or ref.get("references") or [])}
            doc = result[identity]
            if chunk_id and chunk_id not in doc["related_chunk_ids"]:
                doc["related_chunk_ids"].append(chunk_id)
            for node_id in ref.get("referenced_by_node_ids", []):
                if node_id not in doc["referenced_by_node_ids"]:
                    doc["referenced_by_node_ids"].append(node_id)
        return list(result.values())
