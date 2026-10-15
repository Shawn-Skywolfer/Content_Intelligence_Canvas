from __future__ import annotations

from typing import Any
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from pydantic import ValidationError

from fastapi import APIRouter, HTTPException

from app.container import get_container
from app.schemas.workspace import (
    ProviderConfigRequest,
    ProviderConfigResponse,
    ProviderModelDiscoveryRequest,
    SecuritySettingsRequest,
    SecuritySettingsResponse,
    McpSearchConfig,
    ContentFormatsRequest,
)
from app.services.content_formats import list_content_formats
from app.services.knowledge.indexer import source_id_for_path


router = APIRouter(prefix="/api", tags=["settings"])


@router.get("/settings/mcp-search")
def get_mcp_search() -> dict[str, Any]:
    return get_container().mcp_search.config()


@router.put("/settings/mcp-search")
def save_mcp_search(request: McpSearchConfig) -> dict[str, Any]:
    try:
        return get_container().mcp_search.save(request.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/settings/mcp-search/test")
def test_mcp_search() -> dict[str, Any]:
    try:
        return get_container().mcp_search.test()
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def _provider_response(provider: dict[str, Any]) -> ProviderConfigResponse:
    safe_provider = dict(provider)
    safe_extra = dict(provider.get("extra") or {})
    proxy_password_ref = safe_extra.pop("proxy_password_ref", None)
    safe_extra.pop("proxy_password", None)
    safe_provider["extra"] = safe_extra
    return ProviderConfigResponse(
        **safe_provider,
        has_api_key=bool(provider.get("secret_ref")),
        has_proxy_password=bool(proxy_password_ref),
    )


@router.get("/providers", response_model=list[ProviderConfigResponse])
def list_providers() -> list[ProviderConfigResponse]:
    return [_provider_response(item) for item in get_container().workspace.list_providers()]


@router.get("/providers/active")
def active_provider() -> dict[str, str | None]:
    provider = get_container().workspace.active_provider()
    return {"provider_id": provider["id"] if provider else None,
            "model_name": provider["model_name"] if provider else None,
            "name": provider["name"] if provider else None,
            "network_mode": (provider.get("extra") or {}).get("network_mode", "auto") if provider else None}


@router.post("/providers/{provider_id}/activate")
def activate_provider(provider_id: str) -> dict[str, str]:
    repository = get_container().workspace
    provider = repository.get_provider(provider_id)
    if not provider or not provider["enabled"]:
        raise HTTPException(422, "模型不存在或未启用")
    repository.set_setting("active_provider_id", provider_id)
    return {"provider_id": provider_id, "model_name": provider["model_name"]}


@router.post("/providers", response_model=ProviderConfigResponse)
def save_provider(request: ProviderConfigRequest) -> ProviderConfigResponse:
    container = get_container()
    values = request.model_dump(exclude={"api_key"})
    existing = container.workspace.get_provider(request.id) if request.id else None
    if request.api_key:
        values["secret_ref"] = container.secrets.set(
            request.api_key,
            existing.get("secret_ref") if existing else None,
        )
    extra = dict(values.get("extra") or {})
    proxy_password = str(extra.pop("proxy_password", "") or "")
    existing_extra = existing.get("extra", {}) if existing else {}
    if proxy_password:
        extra["proxy_password_ref"] = container.secrets.set(
            proxy_password,
            existing_extra.get("proxy_password_ref"),
        )
    elif existing_extra.get("proxy_password_ref"):
        extra["proxy_password_ref"] = existing_extra["proxy_password_ref"]
    values["extra"] = extra
    provider = container.workspace.upsert_provider(values)
    return _provider_response(provider)


@router.post("/providers/{provider_id}/test")
def test_provider(provider_id: str) -> dict[str, Any]:
    provider = get_container().workspace.get_provider(provider_id)
    if not provider:
        raise HTTPException(404, "模型配置不存在")
    return get_container().ai.health_check(provider)


@router.post("/providers/{provider_id}/test/start")
def start_provider_test(provider_id: str) -> dict[str, Any]:
    provider = get_container().workspace.get_provider(provider_id)
    if not provider:
        raise HTTPException(404, "模型配置不存在")
    return get_container().provider_tests.start(provider)


@router.get("/providers/test/jobs/{job_id}")
def get_provider_test(job_id: str) -> dict[str, Any]:
    job = get_container().provider_tests.get(job_id)
    if not job:
        raise HTTPException(404, "模型测试任务不存在")
    return job


@router.get("/providers/{provider_id}/quota")
def query_provider_quota(provider_id: str) -> dict[str, Any]:
    provider = get_container().workspace.get_provider(provider_id)
    if not provider:
        raise HTTPException(404, "模型配置不存在")
    try:
        return get_container().ai.query_quota(provider)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(502, str(exc)) from exc


@router.delete("/providers/{provider_id}", status_code=204)
def delete_provider(provider_id: str) -> None:
    container = get_container()
    provider = container.workspace.get_provider(provider_id)
    if not provider:
        raise HTTPException(404, "模型配置不存在")
    if container.workspace.delete_provider(provider_id):
        container.secrets.delete(provider.get("secret_ref"))
        container.secrets.delete((provider.get("extra") or {}).get("proxy_password_ref"))


@router.get("/settings/export")
def export_settings() -> dict[str, Any]:
    container = get_container()
    providers = []
    for provider in container.workspace.list_providers():
        item = _provider_response(provider).model_dump()
        item["api_key"] = container.secrets.get(provider.get("secret_ref")) or ""
        item["extra"]["proxy_password"] = container.secrets.get((provider.get("extra") or {}).get("proxy_password_ref")) or ""
        providers.append(item)
    mcp = container.mcp_search.config()
    saved_mcp = container.workspace.get_setting("mcp_search", {}) or {}
    mcp["api_key"] = container.secrets.get(saved_mcp.get("secret_ref")) or ""
    mcp["proxy_password"] = container.secrets.get(saved_mcp.get("proxy_password_ref")) or ""
    active = container.workspace.active_provider()
    return {
        "backup_type": "content-intelligence-canvas-settings", "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "includes_plaintext_secrets": True,
        "providers": providers, "active_provider_id": active["id"] if active else None,
        "knowledge_sources": [{"name": s["name"], "root_path": s["root_path"]} for s in container.manifest.list_sources()],
        "mcp_search": mcp,
        "security": {"protect_internal_data": container.workspace.get_setting("protect_internal_data", True)},
        "content_formats": list_content_formats(container.workspace),
    }


@router.post("/settings/import")
def import_settings(backup: dict[str, Any]) -> dict[str, Any]:
    if backup.get("backup_type") != "content-intelligence-canvas-settings" or backup.get("version") != 1:
        raise HTTPException(422, "不是此应用支持的设置备份文件")
    try:
        raw_providers = backup["providers"]
        raw_sources = backup["knowledge_sources"]
        if not isinstance(raw_providers, list) or len(raw_providers) > 100 or not isinstance(raw_sources, list) or len(raw_sources) > 100:
            raise ValueError("配置数量超过限制")
        providers = [ProviderConfigRequest.model_validate(item) for item in raw_providers]
        formats = ContentFormatsRequest.model_validate({"formats": backup["content_formats"]}).formats
        mcp = McpSearchConfig.model_validate(backup["mcp_search"])
        mcp_parts = urlsplit(mcp.url)
        if mcp_parts.scheme not in {"http", "https"} or not mcp_parts.hostname:
            raise ValueError("搜索 MCP 地址无效")
        protect = backup["security"]["protect_internal_data"]
        if not isinstance(protect, bool):
            raise ValueError("内部数据保护设置无效")
        sources = [(str(item["name"]).strip(), Path(str(item["root_path"])).expanduser()) for item in raw_sources]
        if any(not name or len(name) > 100 for name, _ in sources):
            raise ValueError("知识源名称无效")
    except (KeyError, TypeError, ValueError, ValidationError) as exc:
        raise HTTPException(422, f"导入文件校验失败：{exc}") from exc
    container = get_container()
    for provider in providers:
        save_provider(provider)
    container.mcp_search.save(mcp.model_dump())
    container.workspace.set_setting("content_formats", [item.model_dump() for item in formats])
    container.workspace.set_setting("protect_internal_data", protect)
    missing_paths = []
    for name, path in sources:
        if path.is_dir():
            path = path.resolve()
            container.manifest.upsert_source(source_id_for_path(path), name, str(path))
        else:
            missing_paths.append(str(path))
    active_id = backup.get("active_provider_id")
    if active_id and container.workspace.get_provider(str(active_id)):
        container.workspace.set_setting("active_provider_id", str(active_id))
    return {"message": f"已导入 {len(providers)} 项模型配置及设置；未找到的知识库路径 {len(missing_paths)} 项", "missing_paths": missing_paths}


@router.post("/providers/discover-models")
def discover_models(request: ProviderModelDiscoveryRequest) -> dict[str, Any]:
    container = get_container()
    provider = container.workspace.get_provider(request.provider_id) if request.provider_id else None
    values: dict[str, Any] = {
        "base_url": request.base_url,
        "timeout_seconds": request.timeout_seconds,
        "api_key": request.api_key,
        "extra": {
            "network_mode": request.network_mode,
            "proxy_url": request.proxy_url,
            "proxy_username": request.proxy_username,
            "proxy_password": request.proxy_password,
        },
    }
    if provider and not request.api_key:
        values["secret_ref"] = provider.get("secret_ref")
    if provider and not request.proxy_password:
        existing_ref = (provider.get("extra") or {}).get("proxy_password_ref")
        if existing_ref:
            values["extra"]["proxy_password_ref"] = existing_ref
    try:
        return container.ai.list_models(values)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.get("/settings/security", response_model=SecuritySettingsResponse)
def get_security_settings() -> SecuritySettingsResponse:
    return SecuritySettingsResponse(
        protect_internal_data=get_container().workspace.get_setting("protect_internal_data", True)
    )


@router.put("/settings/security", response_model=SecuritySettingsResponse)
def save_security_settings(request: SecuritySettingsRequest) -> SecuritySettingsResponse:
    get_container().workspace.set_setting("protect_internal_data", request.protect_internal_data)
    return SecuritySettingsResponse(protect_internal_data=request.protect_internal_data)
