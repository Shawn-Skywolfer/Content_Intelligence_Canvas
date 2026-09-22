from __future__ import annotations

import json
import threading
import uuid
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Response

from app.container import get_container
from app.schemas.workspace import (
    CanvasNode,
    CanvasResponse,
    CanvasSaveRequest,
    ConceptRequest,
    ContentAssetResponse,
    ContentGenerateRequest,
    MagicRequest,
    NodeGenerateRequest,
    NodeCreateRequest,
    NodeUpdateRequest,
    ProjectCreateRequest,
    ProjectResponse,
    ProjectUpdateRequest,
    QuickResearchRequest,
    WorkflowResponse,
)


router = APIRouter(prefix="/api", tags=["workspace"])
_research_jobs: dict[str, dict[str, Any]] = {}
_research_lock = threading.Lock()
_content_jobs: dict[str, dict[str, Any]] = {}
_content_lock = threading.Lock()


def _set_research_job(job_id: str, **values: Any) -> None:
    with _research_lock:
        if job_id in _research_jobs:
            _research_jobs[job_id].update(values)


def _run_research_job(job_id: str, project_id: str, request: QuickResearchRequest) -> None:
    try:
        def progress(percent: int, phase: str, detail: str) -> None:
            _set_research_job(job_id, progress=percent, phase=phase, detail=detail)

        nodes, run_id, used_llm, message = get_container().workflow.quick_research(
            project_id,
            request.source_id,
            request.query,
            request.finding_count,
            request.use_llm,
            progress,
        )
        _set_research_job(
            job_id,
            status="completed",
            progress=100,
            phase="研究完成",
            detail=message,
            result={"nodes": nodes, "run_id": run_id, "used_llm": used_llm, "message": message},
        )
    except Exception as exc:
        _set_research_job(
            job_id, status="failed", phase="研究失败", detail=str(exc), error=str(exc)
        )


def _set_content_job(job_id: str, **values: Any) -> None:
    with _content_lock:
        if job_id in _content_jobs:
            _content_jobs[job_id].update(values)


def _run_content_job(job_id: str, project_id: str, request: ContentGenerateRequest) -> None:
    try:
        def progress(percent: int, phase: str, detail: str) -> None:
            _set_content_job(job_id, progress=percent, phase=phase, detail=detail)

        asset, node, run_id, used_llm, message = get_container().workflow.generate_content(
            project_id,
            request.node_ids,
            request.format,
            request.title,
            request.duration_seconds,
            request.use_llm,
            request.instruction,
            request.save_as_asset,
            progress,
        )
        _set_content_job(
            job_id,
            status="completed",
            progress=100,
            phase="内容生成完成",
            detail=message,
            result={
                "asset": asset, "node": node, "run_id": run_id,
                "used_llm": used_llm, "message": message,
            },
        )
    except Exception as exc:
        _set_content_job(
            job_id, status="failed", phase="内容生成失败", detail=str(exc), error=str(exc)
        )


def _project(project_id: str) -> dict[str, Any]:
    project = get_container().workspace.get_project(project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    return project


@router.get("/projects", response_model=list[ProjectResponse])
def list_projects() -> list[dict[str, Any]]:
    return get_container().workspace.list_projects()


@router.post("/projects", response_model=ProjectResponse)
def create_project(request: ProjectCreateRequest) -> dict[str, Any]:
    name = request.name.strip() or request.idea.strip()[:36]
    return get_container().workspace.create_project(name, request.idea.strip(), request.brief.strip())


@router.get("/projects/{project_id}", response_model=ProjectResponse)
def get_project(project_id: str) -> dict[str, Any]:
    return _project(project_id)


@router.patch("/projects/{project_id}", response_model=ProjectResponse)
def update_project(project_id: str, request: ProjectUpdateRequest) -> dict[str, Any]:
    _project(project_id)
    values = request.model_dump(exclude_none=True)
    return get_container().workspace.update_project(project_id, values) or _project(project_id)


@router.get("/projects/{project_id}/canvas", response_model=CanvasResponse)
def get_canvas(project_id: str) -> dict[str, Any]:
    _project(project_id)
    return get_container().workspace.get_canvas(project_id)


@router.put("/projects/{project_id}/canvas", response_model=CanvasResponse)
def save_canvas(project_id: str, request: CanvasSaveRequest) -> dict[str, Any]:
    _project(project_id)
    try:
        return get_container().workspace.replace_canvas(
            project_id,
            [node.model_dump(exclude_none=True) for node in request.nodes],
            [edge.model_dump(exclude_none=True) for edge in request.edges],
            request.viewport,
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/projects/{project_id}/nodes", response_model=CanvasNode)
def create_node(project_id: str, request: NodeCreateRequest) -> dict[str, Any]:
    _project(project_id)
    return get_container().workspace.create_node(project_id, request.model_dump(exclude_none=True))


@router.patch("/projects/{project_id}/nodes/{node_id}", response_model=CanvasNode)
def update_node(project_id: str, node_id: str, request: NodeUpdateRequest) -> dict[str, Any]:
    _project(project_id)
    try:
        node = get_container().workspace.update_node(
            project_id, node_id, request.model_dump(exclude_none=True)
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if not node:
        raise HTTPException(404, "节点不存在")
    return node


@router.delete("/projects/{project_id}/nodes/{node_id}", status_code=204)
def delete_node(project_id: str, node_id: str) -> Response:
    _project(project_id)
    try:
        deleted = get_container().workspace.delete_node(project_id, node_id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if not deleted:
        raise HTTPException(404, "节点不存在")
    return Response(status_code=204)


@router.post("/projects/{project_id}/research/quick", response_model=WorkflowResponse)
def quick_research(project_id: str, request: QuickResearchRequest) -> WorkflowResponse:
    _project(project_id)
    if not get_container().manifest.get_source(request.source_id):
        raise HTTPException(404, "知识源不存在")
    try:
        nodes, run_id, used_llm, message = get_container().workflow.quick_research(
            project_id,
            request.source_id,
            request.query,
            request.finding_count,
            request.use_llm,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return WorkflowResponse(nodes=nodes, run_id=run_id, used_llm=used_llm, message=message)


@router.post("/projects/{project_id}/research/quick/start")
def start_quick_research(project_id: str, request: QuickResearchRequest) -> dict[str, Any]:
    _project(project_id)
    if not get_container().manifest.get_source(request.source_id):
        raise HTTPException(404, "知识源不存在")
    job_id = f"job_{uuid.uuid4().hex}"
    with _research_lock:
        _research_jobs[job_id] = {
            "job_id": job_id,
            "project_id": project_id,
            "status": "running",
            "progress": 2,
            "phase": "准备研究",
            "detail": "正在启动本地研究任务",
        }
    threading.Thread(
        target=_run_research_job,
        args=(job_id, project_id, request),
        name=f"research-{job_id[-8:]}",
        daemon=True,
    ).start()
    return dict(_research_jobs[job_id])


@router.get("/research/jobs/{job_id}")
def get_research_job(job_id: str) -> dict[str, Any]:
    with _research_lock:
        job = _research_jobs.get(job_id)
        if not job:
            raise HTTPException(404, "研究任务不存在或应用已重启")
        return dict(job)


@router.post("/projects/{project_id}/magic", response_model=WorkflowResponse)
def magic_bar(project_id: str, request: MagicRequest) -> WorkflowResponse:
    _project(project_id)
    try:
        node, run_id, used_llm, message = get_container().workflow.magic(
            project_id, request.node_ids, request.instruction, request.output_type
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return WorkflowResponse(nodes=[node], run_id=run_id, used_llm=used_llm, message=message)


@router.post("/projects/{project_id}/nodes/{node_id}/generate", response_model=WorkflowResponse)
def generate_into_node(
    project_id: str, node_id: str, request: NodeGenerateRequest
) -> WorkflowResponse:
    _project(project_id)
    try:
        node, run_id, used_llm, message = get_container().workflow.generate_into_node(
            project_id, node_id, request.instruction, request.use_llm
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return WorkflowResponse(nodes=[node], run_id=run_id, used_llm=used_llm, message=message)


@router.post("/projects/{project_id}/concept", response_model=WorkflowResponse)
def create_concept(project_id: str, request: ConceptRequest) -> WorkflowResponse:
    _project(project_id)
    try:
        node, run_id, used_llm, message = get_container().workflow.create_concept(
            project_id, request.node_ids, request.title, request.use_llm
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return WorkflowResponse(nodes=[node], run_id=run_id, used_llm=used_llm, message=message)


@router.get("/projects/{project_id}/assets", response_model=list[ContentAssetResponse])
def list_assets(project_id: str) -> list[dict[str, Any]]:
    _project(project_id)
    return get_container().workspace.list_assets(project_id)


@router.post("/projects/{project_id}/content/generate")
def generate_content(project_id: str, request: ContentGenerateRequest) -> dict[str, Any]:
    _project(project_id)
    try:
        asset, node, run_id, used_llm, message = get_container().workflow.generate_content(
            project_id,
            request.node_ids,
            request.format,
            request.title,
            request.duration_seconds,
            request.use_llm,
            request.instruction,
            request.save_as_asset,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {
        "asset": asset,
        "node": node,
        "run_id": run_id,
        "used_llm": used_llm,
        "message": message,
    }


@router.post("/projects/{project_id}/content/generate/start")
def start_content_generation(
    project_id: str, request: ContentGenerateRequest
) -> dict[str, Any]:
    _project(project_id)
    job_id = f"content_{uuid.uuid4().hex}"
    with _content_lock:
        _content_jobs[job_id] = {
            "job_id": job_id,
            "project_id": project_id,
            "status": "running",
            "progress": 2,
            "phase": "准备生成",
            "detail": "正在读取选中的白板节点",
        }
    threading.Thread(
        target=_run_content_job,
        args=(job_id, project_id, request),
        name=f"content-{job_id[-8:]}",
        daemon=True,
    ).start()
    return dict(_content_jobs[job_id])


@router.get("/content/jobs/{job_id}")
def get_content_job(job_id: str) -> dict[str, Any]:
    with _content_lock:
        job = _content_jobs.get(job_id)
        if not job:
            raise HTTPException(404, "内容生成任务不存在或应用已重启")
        return dict(job)


@router.post("/projects/{project_id}/nodes/{node_id}/save-asset")
def save_node_as_asset(project_id: str, node_id: str) -> dict[str, Any]:
    _project(project_id)
    try:
        asset, node = get_container().workflow.save_output_as_asset(project_id, node_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"asset": asset, "node": node, "message": "内容已保存到内容资产"}


@router.get("/projects/{project_id}/runs")
def list_runs(project_id: str) -> list[dict[str, Any]]:
    _project(project_id)
    return get_container().workspace.list_runs(project_id)


@router.get("/projects/{project_id}/export")
def export_project(project_id: str, format: str = "markdown") -> Response:
    project = _project(project_id)
    canvas = get_container().workspace.get_canvas(project_id)
    assets = get_container().workspace.list_assets(project_id)
    safe_name = "".join(char if char.isalnum() or char in "-_" else "_" for char in project["name"])
    encoded_name = quote(safe_name)
    if format == "json":
        payload = {"project": project, "canvas": canvas, "assets": assets}
        return Response(
            json.dumps(payload, ensure_ascii=False, indent=2),
            media_type="application/json",
            headers={"Content-Disposition": f"attachment; filename=project.json; filename*=UTF-8''{encoded_name}.json"},
        )
    lines = [
        f"# {project['name']}",
        "",
        "## 原始想法",
        "",
        project["idea"],
        "",
        "## 内容简报",
        "",
        project["brief"] or "（未填写）",
        "",
        "## 白板节点",
        "",
    ]
    for node in canvas["nodes"]:
        lines.extend([f"### {node['title']}", "", f"类型：{node['type']}｜状态：{node['status']}", "", node["body"], ""])
        evidence = node.get("metadata", {}).get("evidence", [])
        if evidence:
            lines.extend(["Evidence：", ""])
            for item in evidence:
                lines.append(f"- `{item.get('path', '')}`｜{' › '.join(item.get('heading', []))}")
            lines.append("")
    if assets:
        lines.extend(["## 内容资产", ""])
        for asset in assets:
            lines.extend([f"### {asset['title']}", "", asset["body"], ""])
    return Response(
        "\n".join(lines),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=project.md; filename*=UTF-8''{encoded_name}.md"},
    )


@router.get("/assets/{asset_id}/export")
def export_asset(asset_id: str) -> Response:
    asset = get_container().workspace.get_asset(asset_id)
    if not asset:
        raise HTTPException(404, "内容资产不存在")
    evidence = "\n".join(
        f"- `{item.get('path', '')}`｜{' › '.join(item.get('heading', []))}"
        for item in asset["evidence"]
    )
    body = f"# {asset['title']}\n\n{asset['body']}\n\n## 证据\n\n{evidence or '（暂无）'}\n"
    return Response(
        body,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{asset_id}.md"'},
    )
