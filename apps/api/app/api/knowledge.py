from __future__ import annotations

import os
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi import Response

from app.container import get_container
from app.schemas.knowledge import (
    ChunkDetailResponse,
    ContextChunkResponse,
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


@router.delete("/knowledge-sources/{source_id}", status_code=204)
def delete_source(source_id: str) -> Response:
    source = get_container().manifest.get_source(source_id)
    if not source:
        raise HTTPException(404, "知识源不存在")
    document_ids = get_container().manifest.delete_source(source_id)
    for document_id in document_ids:
        get_container().chunk_store.delete_document(document_id)
    return Response(status_code=204)


@router.post("/system/select-folder")
def select_folder() -> dict[str, str]:
    """Open a native Windows folder picker from the local portable application."""
    if os.name != "nt":
        raise HTTPException(501, "文件夹浏览仅在 Windows 本地版中可用")
    script = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "$d=New-Object System.Windows.Forms.FolderBrowserDialog; "
        "$d.Description='选择本地知识库文件夹'; $d.ShowNewFolderButton=$false; "
        "if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){"
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output $d.SelectedPath}"
    )
    try:
        completed = subprocess.run(
            ["powershell.exe", "-NoProfile", "-STA", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(500, f"无法打开文件夹选择器：{exc}") from exc
    if completed.returncode != 0:
        raise HTTPException(500, completed.stderr.strip() or "无法打开文件夹选择器")
    return {"path": completed.stdout.strip()}


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
    reasoning = get_container().wiki_reasoning
    try:
        hits, _ = reasoning.gather(
            request.source_id,
            request.query,
            top_k=request.top_k,
            search_options={
                "lexical_weight": request.lexical_weight,
                "semantic_weight": request.semantic_weight,
                "wikilink_enabled": request.wikilink_enabled,
                "wikilink_weight": request.wikilink_weight,
                "max_per_document": request.max_per_document,
            },
        )
        answer, hits, trace = reasoning.answer(request.query, hits, top_k=request.top_k)
    except PermissionError as exc:
        raise HTTPException(403, f"模型尚未获准读取内部 Wiki：{exc}。请在设置中确认数据保护选项") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"模型检索失败：{exc}") from exc
    return SearchResponse(
        query=request.query,
        answer=answer,
        provider_name=trace["provider"],
        model_name=trace["model"],
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


@router.get("/knowledge/chunks/{chunk_id}", response_model=ChunkDetailResponse)
def chunk_detail(chunk_id: str) -> ChunkDetailResponse:
    store = get_container().chunk_store
    row = store.get_chunk(chunk_id)
    if not row:
        raise HTTPException(404, "Knowledge chunk not found")
    context = store.adjacent_chunks(row["document_id"], int(row["chunk_index"]), radius=1)
    return ChunkDetailResponse(
        chunk_id=row["chunk_id"],
        document_id=row["document_id"],
        title=row["title"],
        document_type=row["document_type"],
        heading_path=list(row["heading_path"]),
        full_text=row["text"],
        source_path=row["source_path"],
        start_line=int(row["start_line"]),
        end_line=int(row["end_line"]),
        original_references=list(row["references"]),
        context=[
            ContextChunkResponse(
                chunk_id=item["chunk_id"],
                heading_path=list(item["heading_path"]),
                text=item["text"],
                start_line=int(item["start_line"]),
                end_line=int(item["end_line"]),
                is_current=item["chunk_id"] == row["chunk_id"],
            )
            for item in context
        ],
    )
