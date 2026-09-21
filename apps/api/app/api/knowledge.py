from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.container import get_container
from app.schemas.knowledge import (
    CreateKnowledgeSourceRequest,
    KnowledgeSourceResponse,
    SearchHitResponse,
    SearchRequest,
    SearchResponse,
)
from app.services.knowledge.indexer import source_id_for_path

router = APIRouter(prefix="/api", tags=["knowledge"])


@router.get("/knowledge-sources", response_model=list[KnowledgeSourceResponse])
def list_sources() -> list[KnowledgeSourceResponse]:
    sources = get_container().manifest.list_sources()
    return [
        KnowledgeSourceResponse(
            id=item["id"],
            name=item["name"],
            connector_type=item["connector_type"],
            root_path=item["root_path"],
            enabled=bool(item["enabled"]),
        )
        for item in sources
    ]


@router.post("/knowledge-sources", response_model=KnowledgeSourceResponse)
def create_source(request: CreateKnowledgeSourceRequest) -> KnowledgeSourceResponse:
    path = Path(request.root_path).expanduser().resolve()
    if not path.is_dir():
        raise HTTPException(422, "root_path must be an existing local directory")
    source_id = source_id_for_path(path)
    get_container().manifest.upsert_source(source_id, request.name, str(path))
    return KnowledgeSourceResponse(
        id=source_id,
        name=request.name,
        connector_type="local_vault",
        root_path=str(path),
        enabled=True,
    )


@router.post("/knowledge-sources/{source_id}/refresh")
async def refresh_source(source_id: str) -> dict:
    source = get_container().manifest.get_source(source_id)
    if not source:
        raise HTTPException(404, "Knowledge source not found")
    try:
        report = await get_container().indexer.refresh(source["name"], Path(source["root_path"]))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return report.to_dict()


@router.post("/knowledge/search", response_model=SearchResponse)
def search(request: SearchRequest) -> SearchResponse:
    if not get_container().manifest.get_source(request.source_id):
        raise HTTPException(404, "Knowledge source not found")
    hits = get_container().retrieval.search(request.source_id, request.query, request.top_k)
    return SearchResponse(
        query=request.query,
        hits=[SearchHitResponse(**{
            "chunk_id": hit.chunk_id,
            "document_id": hit.document_id,
            "title": hit.title,
            "heading_path": list(hit.heading_path),
            "excerpt": hit.excerpt,
            "score": hit.score,
            "retrieval_reasons": list(hit.retrieval_reasons),
            "source_path": hit.source_path,
            "start_line": hit.start_line,
            "end_line": hit.end_line,
            "declared_updated_at": hit.declared_updated_at,
            "original_references": list(hit.original_references),
            "debug": hit.debug,
        }) for hit in hits],
    )

