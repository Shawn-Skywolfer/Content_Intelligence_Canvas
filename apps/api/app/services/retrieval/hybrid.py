from __future__ import annotations

import math
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from app.config import RetrievalConfig
from app.domain.knowledge import EmbeddingProvider, KnowledgeHit
from app.repositories.knowledge_manifest import KnowledgeManifestRepository
from app.repositories.lance_chunk_store import LanceChunkStore
from app.services.retrieval.bm25 import bm25_scores
from app.services.retrieval.tokenizer import unique_terms

ENTITY_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.+-]{2,}")


def _cosine(left: list[float], right: list[float]) -> float:
    # Stored and query vectors are normalized, but keep this safe for custom providers.
    numerator = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(value * value for value in left)) or 1.0
    right_norm = math.sqrt(sum(value * value for value in right)) or 1.0
    return numerator / (left_norm * right_norm)


class HybridRetrievalService:
    def __init__(
        self,
        manifest: KnowledgeManifestRepository,
        store: LanceChunkStore,
        embeddings: EmbeddingProvider,
        config: RetrievalConfig,
    ) -> None:
        self.manifest = manifest
        self.store = store
        self.embeddings = embeddings
        self.config = config

    def search(
        self,
        source_id: str,
        query: str,
        top_k: int | None = None,
        *,
        lexical_weight: float = 1.0,
        semantic_weight: float = 1.0,
        wikilink_enabled: bool = True,
        wikilink_weight: float | None = None,
        max_per_document: int = 2,
    ) -> list[KnowledgeHit]:
        rows = self.store.all_for_source(source_id)
        if not rows:
            return []
        query_vector = self.embeddings.embed([query])[0]
        lexical_scores = bm25_scores(query, [row["text"] for row in rows])
        vector_scores = [_cosine(query_vector, list(row["vector"])) for row in rows]

        lexical_ranked = sorted(range(len(rows)), key=lambda i: lexical_scores[i], reverse=True)
        vector_ranked = sorted(range(len(rows)), key=lambda i: vector_scores[i], reverse=True)
        lexical_ranked = [i for i in lexical_ranked if lexical_scores[i] > 0][: self.config.lexical_top_k]
        vector_ranked = vector_ranked[: self.config.vector_top_k]

        fused: dict[int, float] = defaultdict(float)
        reasons: dict[int, set[str]] = defaultdict(set)
        ranks: dict[int, dict[str, int]] = defaultdict(dict)
        for label, ranking, weight in (
            ("fts", lexical_ranked, lexical_weight),
            ("semantic", vector_ranked, semantic_weight),
        ):
            for rank, row_index in enumerate(ranking, start=1):
                fused[row_index] += weight / (self.config.rrf_k + rank)
                reasons[row_index].add(label)
                ranks[row_index][label] = rank

        # Entity/title affinity is applied before graph expansion so the primary
        # Seed pages are selected before graph expansion so the user's named entity wins.
        query_terms = unique_terms(query)
        entities = ENTITY_RE.findall(query.lower())
        for index in list(fused):
            title_lower = rows[index]["title"].lower()
            title_terms = unique_terms(rows[index]["title"])
            heading_terms = unique_terms(" ".join(rows[index]["heading_path"]))
            title_overlap = len(query_terms & title_terms) / max(1, len(query_terms))
            heading_overlap = len(query_terms & heading_terms) / max(1, len(query_terms))
            fused[index] += 0.05 * title_overlap + 0.003 * heading_overlap
            if title_overlap or heading_overlap:
                reasons[index].add("title_or_heading_match")
            entity_matches = sum(1 for entity in entities if entity in title_lower)
            if entity_matches:
                fused[index] += 0.025 * entity_matches
                reasons[index].add("entity_title_match")
            heading_text = " ".join(rows[index]["heading_path"]).lower()
            if any(label in heading_text for label in ("参考文献", "sources", "references")):
                fused[index] -= 0.008
                reasons[index].add("reference_section_penalty")

        candidate_indices = sorted(fused, key=fused.get, reverse=True)[: self.config.fusion_candidates]
        if wikilink_enabled:
            self._expand_wikilinks(
                query,
                rows,
                lexical_scores,
                vector_scores,
                candidate_indices,
                fused,
                reasons,
                ranks,
                wikilink_weight,
            )

        limit = top_k or self.config.output_top_k
        final_indices: list[int] = []
        per_document: dict[str, int] = defaultdict(int)
        for index in sorted(fused, key=fused.get, reverse=True):
            document_id = rows[index]["document_id"]
            if per_document[document_id] >= max_per_document:
                continue
            final_indices.append(index)
            per_document[document_id] += 1
            if len(final_indices) >= limit:
                break
        hits: list[KnowledgeHit] = []
        for index in final_indices:
            row = rows[index]
            excerpt = row["text"][:700].strip()
            hits.append(
                KnowledgeHit(
                    chunk_id=row["chunk_id"],
                    document_id=row["document_id"],
                    title=row["title"],
                    heading_path=tuple(row["heading_path"]),
                    excerpt=excerpt,
                    score=round(fused[index], 6),
                    retrieval_reasons=tuple(sorted(reasons[index])),
                    source_path=row["source_path"],
                    start_line=int(row["start_line"]),
                    end_line=int(row["end_line"]),
                    declared_updated_at=row["declared_updated_at"],
                    original_references=tuple(row["references"]),
                    debug={
                        "lexical_rank": ranks[index].get("fts"),
                        "vector_rank": ranks[index].get("semantic"),
                        "bm25_score": round(lexical_scores[index], 6),
                        "vector_score": round(vector_scores[index], 6),
                        "linked_from": ranks[index].get("linked_from"),
                    },
                )
            )
        return hits

    def _expand_wikilinks(
        self,
        query: str,
        rows: list[dict[str, Any]],
        lexical_scores: list[float],
        vector_scores: list[float],
        candidates: list[int],
        fused: dict[int, float],
        reasons: dict[int, set[str]],
        ranks: dict[int, dict[str, Any]],
        wikilink_weight: float | None = None,
    ) -> None:
        documents = self.manifest.documents_for_source(rows[0]["source_id"])
        target_to_doc: dict[str, str] = {}
        doc_links: dict[str, list[str]] = {}
        for path, document in documents.items():
            document_id = document["document_id"]
            target_to_doc[Path(path).with_suffix("").as_posix()] = document_id
            target_to_doc[Path(path).stem] = document_id
            doc_links[document_id] = list(document["wikilinks"])

        indices_by_document: dict[str, list[int]] = defaultdict(list)
        for index, row in enumerate(rows):
            indices_by_document[row["document_id"]].append(index)

        seed_docs: list[str] = []
        for index in candidates:
            document_id = rows[index]["document_id"]
            if document_id not in seed_docs:
                seed_docs.append(document_id)
            if len(seed_docs) >= self.config.link_seed_documents:
                break

        for seed_rank, seed_doc in enumerate(seed_docs, start=1):
            targets = doc_links.get(seed_doc, [])[: self.config.link_pages_per_seed]
            seed_indices = [index for index in candidates if rows[index]["document_id"] == seed_doc]
            seed_score = max((fused[index] for index in seed_indices), default=0.0)
            seed_title = next((row["title"] for row in rows if row["document_id"] == seed_doc), seed_doc)
            for target in targets:
                linked_doc = target_to_doc.get(target) or target_to_doc.get(Path(target).name)
                if not linked_doc:
                    continue
                linked_indices = indices_by_document.get(linked_doc, [])
                if not linked_indices:
                    continue
                best = max(
                    linked_indices,
                    key=lambda i: lexical_scores[i] + max(0.0, vector_scores[i]),
                )
                relevance = max(0.0, vector_scores[best]) + min(1.0, lexical_scores[best] / 8.0)
                if relevance <= 0:
                    continue
                # Anchor graph expansion to the seed's fused relevance. This makes a
                # genuinely related page visible even when it shares little query text.
                link_score = (
                    (wikilink_weight if wikilink_weight is not None else self.config.link_score_weight)
                    * seed_score / seed_rank
                    + 0.004 * relevance / seed_rank
                )
                fused[best] = max(fused.get(best, 0.0), link_score)
                reasons[best].add("wikilink")
                ranks[best]["linked_from"] = seed_title
