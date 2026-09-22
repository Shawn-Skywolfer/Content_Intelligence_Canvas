from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


NodeStatus = Literal["exploring", "candidate", "approved", "locked"]
NodeType = Literal[
    "idea", "brief", "note", "knowledge", "fact", "signal", "internal_knowledge",
    "insight", "challenge", "creative_pattern", "content_concept", "output", "frame",
]


class ProjectCreateRequest(BaseModel):
    name: str = Field(default="", max_length=120)
    idea: str = Field(min_length=2, max_length=2000)
    brief: str = Field(default="", max_length=5000)


class ProjectUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    idea: str | None = Field(default=None, max_length=2000)
    brief: str | None = Field(default=None, max_length=5000)
    status: str | None = None


class ProjectResponse(BaseModel):
    id: str
    name: str
    idea: str
    brief: str
    status: str
    created_at: str
    updated_at: str


class CanvasNode(BaseModel):
    id: str | None = None
    type: str = "note"
    title: str = "未命名节点"
    body: str = ""
    status: str = "exploring"
    locked: bool = False
    x: float = 0
    y: float = 0
    width: float = 360
    height: float = 220
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_by: str = "user"
    parent_id: str | None = None
    project_id: str | None = None
    canvas_id: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class CanvasEdge(BaseModel):
    id: str | None = None
    source_node_id: str
    target_node_id: str
    relation: str = "context"
    metadata: dict[str, Any] = Field(default_factory=dict)
    project_id: str | None = None
    canvas_id: str | None = None
    created_at: str | None = None


class CanvasSaveRequest(BaseModel):
    nodes: list[CanvasNode]
    edges: list[CanvasEdge]
    viewport: dict[str, float] = Field(default_factory=dict)


class CanvasResponse(BaseModel):
    id: str
    project_id: str
    viewport: dict[str, Any]
    updated_at: str
    nodes: list[CanvasNode]
    edges: list[CanvasEdge]


class NodeCreateRequest(CanvasNode):
    pass


class NodeUpdateRequest(BaseModel):
    type: str | None = None
    title: str | None = None
    body: str | None = None
    status: str | None = None
    locked: bool | None = None
    x: float | None = None
    y: float | None = None
    width: float | None = None
    height: float | None = None
    metadata: dict[str, Any] | None = None
    parent_id: str | None = None


class QuickResearchRequest(BaseModel):
    source_id: str
    query: str = Field(min_length=2, max_length=500)
    finding_count: int = Field(default=6, ge=3, le=8)
    use_llm: bool = True


class WorkflowResponse(BaseModel):
    nodes: list[CanvasNode]
    run_id: str
    used_llm: bool
    message: str


class MagicRequest(BaseModel):
    node_ids: list[str] = Field(min_length=1, max_length=20)
    instruction: str = Field(min_length=2, max_length=1000)
    output_type: str = "insight"


class NodeGenerateRequest(BaseModel):
    instruction: str = Field(min_length=2, max_length=2000)
    use_llm: bool = True


class ConceptRequest(BaseModel):
    node_ids: list[str] = Field(min_length=1, max_length=30)
    title: str = ""
    use_llm: bool = True


class ContentGenerateRequest(BaseModel):
    node_ids: list[str] = Field(min_length=1, max_length=30)
    format: Literal["wechat", "video_script", "poster_campaign"]
    title: str = ""
    duration_seconds: int = Field(default=90, ge=15, le=600)
    use_llm: bool = True
    instruction: str = Field(default="", max_length=2000)
    save_as_asset: bool = True


class ContentAssetResponse(BaseModel):
    id: str
    project_id: str
    format: str
    title: str
    body: str
    evidence: list[dict[str, Any]]
    status: str
    version: int
    created_at: str
    updated_at: str


class ProviderConfigRequest(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=100)
    protocol: Literal["openai_compatible", "custom"] = "openai_compatible"
    base_url: str = Field(min_length=5, max_length=500)
    api_key: str | None = Field(default=None, max_length=1000)
    model_name: str = Field(min_length=1, max_length=200)
    enabled: bool = True
    is_external: bool = True
    temperature: float = Field(default=0.3, ge=0, le=2)
    max_tokens: int = Field(default=3000, ge=128, le=128000)
    timeout_seconds: int = Field(default=60, ge=5, le=300)
    extra: dict[str, Any] = Field(default_factory=dict)

    @field_validator("base_url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if not value.startswith(("http://", "https://")):
            raise ValueError("Base URL 必须以 http:// 或 https:// 开头")
        return value


class ProviderConfigResponse(BaseModel):
    id: str
    name: str
    protocol: str
    base_url: str
    model_name: str
    enabled: bool
    is_external: bool
    temperature: float
    max_tokens: int
    timeout_seconds: int
    extra: dict[str, Any]
    has_api_key: bool
    has_proxy_password: bool
    created_at: str
    updated_at: str


class ProviderModelDiscoveryRequest(BaseModel):
    provider_id: str | None = None
    base_url: str = Field(min_length=5, max_length=500)
    api_key: str | None = Field(default=None, max_length=1000)
    timeout_seconds: int = Field(default=60, ge=5, le=300)
    network_mode: Literal["auto", "direct", "system_proxy", "custom_proxy"] = "auto"
    proxy_url: str | None = Field(default=None, max_length=500)
    proxy_username: str | None = Field(default=None, max_length=300)
    proxy_password: str | None = Field(default=None, max_length=1000)

    @field_validator("base_url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if not value.startswith(("http://", "https://")):
            raise ValueError("Base URL 必须以 http:// 或 https:// 开头")
        return value

    @field_validator("proxy_url")
    @classmethod
    def validate_proxy_url(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        value = value.strip()
        if not value.startswith(("http://", "https://")):
            raise ValueError("代理地址必须以 http:// 或 https:// 开头")
        return value


class SecuritySettingsRequest(BaseModel):
    protect_internal_data: bool


class SecuritySettingsResponse(BaseModel):
    protect_internal_data: bool
