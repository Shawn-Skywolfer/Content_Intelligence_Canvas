from __future__ import annotations

import math
from collections import Counter
from collections.abc import Sequence

from app.services.retrieval.tokenizer import tokenize


def bm25_scores(query: str, documents: Sequence[str], k1: float = 1.5, b: float = 0.75) -> list[float]:
    tokenized = [tokenize(document) for document in documents]
    query_terms = set(tokenize(query))
    if not tokenized or not query_terms:
        return [0.0] * len(documents)
    avg_len = sum(len(tokens) for tokens in tokenized) / len(tokenized) or 1.0
    frequencies = [Counter(tokens) for tokens in tokenized]
    document_frequency = {
        term: sum(1 for counts in frequencies if term in counts) for term in query_terms
    }
    scores: list[float] = []
    n = len(tokenized)
    for tokens, counts in zip(tokenized, frequencies, strict=True):
        score = 0.0
        length_norm = 1.0 - b + b * len(tokens) / avg_len
        for term in query_terms:
            tf = counts.get(term, 0)
            if not tf:
                continue
            df = document_frequency[term]
            idf = math.log(1.0 + (n - df + 0.5) / (df + 0.5))
            score += idf * (tf * (k1 + 1.0)) / (tf + k1 * length_norm)
        scores.append(score)
    return scores

