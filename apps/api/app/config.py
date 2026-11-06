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


from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", populate_by_name=True)
    data_dir: Path = Field(default=Path("data"), validation_alias=AliasChoices("DATA_DIR", "CIC_DATA_DIR"))
    web_origin: str = Field(default="http://localhost:5173", validation_alias=AliasChoices("CORS_ORIGINS", "CIC_WEB_ORIGIN"))
    service_prefix: str = Field(default="", validation_alias=AliasChoices("SERVICE_PREFIX", "API_BASE", "SERVER_SERVICE_NAME"))
    retrieval: RetrievalConfig = Field(default_factory=RetrievalConfig)

    @field_validator("data_dir")
    @classmethod
    def resolve_data(cls, value: Path) -> Path:
        return value.expanduser().resolve()

    @field_validator("service_prefix")
    @classmethod
    def check_prefix(cls, value: str) -> str:
        import re
        prefix = value.strip("/")
        if prefix and not re.fullmatch(r"[A-Za-z]+", prefix):
            raise ValueError("服务前缀只能包含英文字母")
        return "/" + prefix if prefix else ""

    @property
    def web_origins(self) -> list[str]:
        return [item.strip().rstrip("/") for item in self.web_origin.split(",") if item.strip()]

    @property
    def uploaded_wikis_dir(self) -> Path:
        return self.data_dir / "uploads" / "wiki"

    def ensure_dirs(self) -> None:
        for child in ("", "uploads", "logs", "run"):
            (self.data_dir / child).mkdir(parents=True, exist_ok=True)

    @classmethod
    def from_env(cls) -> "Settings":
        return cls()
