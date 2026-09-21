from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class RetrievalConfig:
    lexical_top_k: int = 20
    vector_top_k: int = 20
    fusion_candidates: int = 30
    output_top_k: int = 10
    rrf_k: int = 60
    link_seed_documents: int = 1
    link_pages_per_seed: int = 12
    link_score_weight: float = 0.75
    embedding_dimensions: int = 768
    max_chunk_chars: int = 1800
    min_chunk_chars: int = 80


@dataclass(frozen=True, slots=True)
class Settings:
    data_dir: Path
    web_origin: str
    retrieval: RetrievalConfig

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            data_dir=Path(os.getenv("CIC_DATA_DIR", "data")).expanduser().resolve(),
            web_origin=os.getenv("CIC_WEB_ORIGIN", "http://localhost:5173"),
            retrieval=RetrievalConfig(),
        )
