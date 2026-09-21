from __future__ import annotations

import hashlib
import math
from collections import Counter
from collections.abc import Sequence

from app.services.retrieval.tokenizer import tokenize


class LocalHashEmbeddingProvider:
    """Deterministic offline baseline using signed feature hashing."""

    def __init__(self, dimensions: int = 768) -> None:
        self._dimensions = dimensions

    @property
    def dimensions(self) -> int:
        return self._dimensions

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        vector = [0.0] * self.dimensions
        counts = Counter(tokenize(text))
        for token, frequency in counts.items():
            digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
            value = int.from_bytes(digest, "big")
            index = value % self.dimensions
            sign = 1.0 if (value >> 63) == 0 else -1.0
            vector[index] += sign * (1.0 + math.log(frequency))
        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]

