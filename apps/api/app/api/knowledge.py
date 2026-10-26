from __future__ import annotations

import asyncio
import base64
import json
import tempfile
import os
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
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
from app.services.knowledge.originals import WikiOriginalReader
from pydantic import BaseModel, Field

from app.services.knowledge.source_path import clean_local_path, repair_source_path

router = APIRouter(prefix="/api", tags=["knowledge"])


@router.get("/knowledge-sources", response_model=list[KnowledgeSourceResponse])
def list_sources() -> list[KnowledgeSourceResponse]:
    manifest = get_container().manifest
    sources = [repair_source_path(manifest, item) for item in manifest.list_sources()]
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
    cleaned = clean_local_path(request.root_path)
    path = Path(cleaned).expanduser()
    if not cleaned or not path.is_absolute():
        raise HTTPException(422, "请填写完整的本地知识库目录，或点击“浏览文件夹”选择")
    path = path.resolve()
    if not path.is_dir():
        raise HTTPException(422, f"知识库目录不存在或无法访问：{path}。请检查路径，或点击“浏览文件夹”选择目录")
    source_id = source_id_for_path(path)
    get_container().manifest.upsert_source(source_id, request.name, str(path))
    return KnowledgeSourceResponse(
        id=source_id,
        name=request.name,
        connector_type="local_vault",
        root_path=str(path),
        enabled=True,
    )


@router.post("/knowledge-sources/upload-zip", response_model=KnowledgeSourceResponse)
async def upload_wiki_zip(request: Request, name: str = "上传的知识库"):
    import io
    import shutil
    import stat
    import uuid
    import zipfile
    from pathlib import PurePosixPath
    from app.config import Settings
    chunks = bytearray()
    async for chunk in request.stream():
        chunks.extend(chunk)
        if len(chunks) > 50 * 1024 * 1024:
            raise HTTPException(413, "Wiki ZIP 不能超过 50 MB")
    target = Settings.from_env().data_dir / "uploaded-wikis" / uuid.uuid4().hex
    try:
        with zipfile.ZipFile(io.BytesIO(chunks)) as archive:
            entries = archive.infolist()
            if len(entries) > 10000 or sum(item.file_size for item in entries) > 200 * 1024 * 1024:
                raise HTTPException(413, "解压后不能超过 200 MB 或 10000 个条目")
            for item in entries:
                path = PurePosixPath(item.filename.replace("\\", "/"))
                if (path.is_absolute() or ".." in path.parts or ":" in str(path) or stat.S_ISLNK(item.external_attr >> 16)
                        or any(part.rstrip(" .") != part or part.split(".")[0].upper() in
                               {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
                               for part in path.parts)):
                    raise HTTPException(422, "ZIP 包含不安全的路径或符号链接")
            target.mkdir(parents=True)
            count = 0
            for item in entries:
                path = PurePosixPath(item.filename.replace("\\", "/"))
                if item.is_dir() or path.suffix.lower() != ".md":
                    continue
                output = target.joinpath(*path.parts)
                output.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as source, output.open("wb") as dest:
                    shutil.copyfileobj(source, dest)
                count += 1
            if not count:
                raise HTTPException(422, "ZIP 内没有 Markdown 词条")
        children = list(target.iterdir())
        root = children[0] if len(children) == 1 and children[0].is_dir() else target
        return create_source(CreateKnowledgeSourceRequest(name=name[:100], root_path=str(root)))
    except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
        shutil.rmtree(target, ignore_errors=True)
        raise HTTPException(422, "无法读取 Wiki ZIP，请检查文件是否损坏或加密") from exc
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise


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
    if os.getenv("CIC_SERVER_MODE") == "1":
        raise HTTPException(501, "服务器版不能浏览访问者电脑的文件夹，请上传 Wiki ZIP，或填写服务器上的知识库目录")
    if os.name != "nt":
        raise HTTPException(501, "文件夹浏览仅在 Windows 本地版中可用")
    return _pick_windows_folder()


def _pick_windows_folder() -> dict[str, str]:
    # Keep dialog output in a dedicated file: console warnings can never become a path.
    script = (
        "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; "
        "$d=New-Object System.Windows.Forms.FolderBrowserDialog; "
        "$d.Description='选择本地知识库文件夹'; $d.ShowNewFolderButton=$false; "
        "$selected=''; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){$selected=$d.SelectedPath}; "
        "$result=@{path=$selected}|ConvertTo-Json -Compress; "
        "[IO.File]::WriteAllText($env:CIC_FOLDER_PICKER_RESULT,$result,(New-Object Text.UTF8Encoding($false))); $d.Dispose()"
    )
    try:
        with tempfile.TemporaryDirectory(prefix="cic-folder-") as directory:
            result_path = Path(directory) / "selection.json"
            completed = subprocess.run(
                ["powershell.exe", "-NoProfile", "-STA", "-EncodedCommand", base64.b64encode(script.encode("utf-16-le")).decode("ascii")],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180,
                env={**os.environ, "CIC_FOLDER_PICKER_RESULT": str(result_path)},
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False,
            )
            if completed.returncode != 0:
                raise HTTPException(500, completed.stderr.strip() or "无法打开文件夹选择器")
            if not result_path.is_file():
                raise HTTPException(500, "文件夹选择器未返回有效结果，请重试或手动粘贴目录")
            result = json.loads(result_path.read_text(encoding="utf-8-sig"))
            if not isinstance(result, dict) or not isinstance(result.get("path"), str):
                raise HTTPException(500, "文件夹选择器返回格式错误")
            return {"path": clean_local_path(result["path"])}
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(500, f"无法读取文件夹选择结果：{exc}") from exc


@router.post("/knowledge-sources/{source_id}/refresh")
async def refresh_source(source_id: str) -> dict:
    container = get_container()
    source = container.manifest.get_source(source_id)
    if not source:
        raise HTTPException(404, "Knowledge source not found")
    source = repair_source_path(container.manifest, source)
    context_status = await asyncio.to_thread(container.agent_context.prepare_refresh, source_id)
    try:
        report = await container.indexer.refresh(source["name"], Path(source["root_path"]))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {**report.to_dict(), "agent_context": context_status}


@router.post("/knowledge-sources/{source_id}/refresh/start")
def start_refresh(source_id: str) -> dict:
    try:
        return get_container().refresh_jobs.start(source_id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/knowledge-sources/{source_id}/refresh/latest")
def latest_refresh(source_id: str) -> dict | None:
    if not get_container().manifest.get_source(source_id):
        raise HTTPException(404, "知识源不存在")
    return get_container().refresh_jobs.latest_for_source(source_id)


@router.get("/knowledge-sources/refresh/jobs/{job_id}")
def get_refresh_job(job_id: str) -> dict:
    job = get_container().refresh_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "刷新任务不存在或应用已重启")
    return job


@router.post("/knowledge/search", response_model=SearchResponse)
def search(request: SearchRequest) -> SearchResponse:
    if not get_container().manifest.get_source(request.source_id):
        raise HTTPException(404, "Knowledge source not found")
    reasoning = get_container().wiki_reasoning
    try:
        hits, planning_trace = reasoning.gather(
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
        answer, hits, trace = reasoning.answer(
            request.query, hits, top_k=request.top_k,
            agent_context=planning_trace.get("agent_context"),
        )
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


class WikiOriginalRequest(BaseModel):
    chunk_id: str = Field(default="", max_length=200)
    source_id: str | None = Field(default=None, max_length=200)
    path: str = Field(default="", max_length=4096)


@router.post("/knowledge/original")
def wiki_original(request: WikiOriginalRequest) -> dict:
    container = get_container()
    try:
        return WikiOriginalReader(container.manifest, container.chunk_store).read([request.model_dump()])[0]
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


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
