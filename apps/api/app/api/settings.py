from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from app.container import get_container
from app.schemas.workspace import (
    ProviderConfigRequest,
    ProviderConfigResponse,
    SecuritySettingsRequest,
    SecuritySettingsResponse,
)


router = APIRouter(prefix="/api", tags=["settings"])


def _provider_response(provider: dict[str, Any]) -> ProviderConfigResponse:
    return ProviderConfigResponse(
        **provider,
        has_api_key=bool(provider.get("secret_ref")),
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
    provider = container.workspace.upsert_provider(values)
    return _provider_response(provider)


@router.post("/providers/{provider_id}/test")
def test_provider(provider_id: str) -> dict[str, Any]:
    provider = get_container().workspace.get_provider(provider_id)
    if not provider:
        raise HTTPException(404, "模型配置不存在")
    return get_container().ai.health_check(provider)


@router.get("/settings/security", response_model=SecuritySettingsResponse)
def get_security_settings() -> SecuritySettingsResponse:
    return SecuritySettingsResponse(
        protect_internal_data=get_container().workspace.get_setting("protect_internal_data", True)
    )


@router.put("/settings/security", response_model=SecuritySettingsResponse)
def save_security_settings(request: SecuritySettingsRequest) -> SecuritySettingsResponse:
    get_container().workspace.set_setting("protect_internal_data", request.protect_internal_data)
    return SecuritySettingsResponse(protect_internal_data=request.protect_internal_data)
