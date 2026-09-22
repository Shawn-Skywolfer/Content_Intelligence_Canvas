from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from app.container import get_container
from app.schemas.workspace import (
    ProviderConfigRequest,
    ProviderConfigResponse,
    ProviderModelDiscoveryRequest,
    SecuritySettingsRequest,
    SecuritySettingsResponse,
)


router = APIRouter(prefix="/api", tags=["settings"])


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
