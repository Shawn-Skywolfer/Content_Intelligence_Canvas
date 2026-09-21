from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from pathlib import Path
from typing import Sequence

from app.services.retrieval.hybrid import HybridRetrievalService


@dataclass(frozen=True, slots=True)
class EvaluationCase:
    name: str
    query: str
    expected_paths: tuple[str, ...]
    required_any_at_5: tuple[str, ...]


def load_cases(path: Path) -> tuple[EvaluationCase, ...]:
    """Load acceptance cases from a local, user-owned file."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    return tuple(
        EvaluationCase(
            name=item["name"],
            query=item["query"],
            expected_paths=tuple(item.get("expected_paths", [])),
            required_any_at_5=tuple(item.get("required_any_at_5", [])),
        )
        for item in payload
    )


def evaluate(
    retrieval: HybridRetrievalService,
    source_id: str,
    cases: Sequence[EvaluationCase],
) -> dict:
    results = []
    total_recall_10 = 0.0
    hit5_count = 0
    wikilink_cases = 0
    for case in cases:
        hits = retrieval.search(source_id, case.query, top_k=10)
        paths = [hit.source_path for hit in hits]
        unique_paths = list(dict.fromkeys(paths))
        matched = [path for path in case.expected_paths if path in unique_paths[:10]]
        recall_10 = len(matched) / len(case.expected_paths)
        hit5 = any(path in unique_paths[:5] for path in case.required_any_at_5)
        has_wikilink = any("wikilink" in hit.retrieval_reasons for hit in hits)
        total_recall_10 += recall_10
        hit5_count += int(hit5)
        wikilink_cases += int(has_wikilink)
        results.append(
            {
                "case": asdict(case),
                "hit_at_5": hit5,
                "recall_at_10": round(recall_10, 3),
                "has_wikilink_expansion": has_wikilink,
                "ranked_paths": unique_paths,
                "hits": [
                    {
                        "path": hit.source_path,
                        "heading": list(hit.heading_path),
                        "score": hit.score,
                        "reasons": list(hit.retrieval_reasons),
                        "debug": hit.debug,
                    }
                    for hit in hits
                ],
            }
        )
    count = len(cases)
    return {
        "summary": {
            "cases": count,
            "hit_at_5_rate": round(hit5_count / count, 3),
            "mean_expected_recall_at_10": round(total_recall_10 / count, 3),
            "wikilink_expansion_case_rate": round(wikilink_cases / count, 3),
        },
        "results": results,
    }
