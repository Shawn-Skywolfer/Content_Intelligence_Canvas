from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator


class CreateKnowledgeSourceRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    root_path: str = Field(min_length=1)


class KnowledgeSourceResponse(BaseModel):
    id: str
    name: str
    connector_type: str
    root_path: str
    enabled: bool


class SearchRequest(BaseModel):
    source_id: str
    query: str = Field(min_length=2, max_length=500)
    top_k: int = Field(default=10, ge=1, le=30)
    lexical_weight: float = Field(default=1.0, ge=0, le=3)
    semantic_weight: float = Field(default=1.0, ge=0, le=3)
    wikilink_enabled: bool = True
    wikilink_weight: float = Field(default=0.75, ge=0, le=2)
    max_per_document: int = Field(default=2, ge=1, le=5)

    @field_validator("query")
    @classmethod
    def normalize_query(cls, value: str) -> str:
        return " ".join(value.split())


class SearchHitResponse(BaseModel):
    chunk_id: str
    document_id: str
    title: str
    heading_path: list[str]
    excerpt: str
    score: float
    retrieval_reasons: list[str]
    source_path: str
    start_line: int
    end_line: int
    declared_updated_at: str | None
    original_references: list[str]
    debug: dict[str, Any]


class SearchResponse(BaseModel):
    query: str
    hits: list[SearchHitResponse]
    answer: str
    provider_name: str
    model_name: str


class ContextChunkResponse(BaseModel):
    chunk_id: str
    heading_path: list[str]
    text: str
    start_line: int
    end_line: int
    is_current: bool


class ChunkDetailResponse(BaseModel):
    chunk_id: str
    document_id: str
    title: str
    document_type: str
    heading_path: list[str]
    full_text: str
    source_path: str
    start_line: int
    end_line: int
    original_references: list[str]
    context: list[ContextChunkResponse]
