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
    status: Literal["active", "archived"] | None = None


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
    summary: str | None = None
    summary_model: str | None = None
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
    base_updated_at: str | None = None


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


class NodeSummaryRequest(BaseModel):
    force: bool = False


class QuickResearchRequest(BaseModel):
    source_id: str
    query: str = Field(min_length=2, max_length=500)
    finding_count: int = Field(default=20, ge=3, le=20)
    use_llm: bool = True


class WorkflowResponse(BaseModel):
    nodes: list[CanvasNode]
    run_id: str
    used_llm: bool
    message: str


WEB_SEARCH_NODE_TYPES = frozenset({"insight", "challenge", "creative_pattern", "note"})


class MagicRequest(BaseModel):
    node_ids: list[str] = Field(min_length=1, max_length=20)
    instruction: str = Field(min_length=2, max_length=1000)
    output_type: Literal["insight", "challenge", "creative_pattern", "note", "output"] = "insight"
    negative_prompt: str = Field(default="", max_length=2000)
    web_search: bool = False
    format: str = "wechat"
    duration_seconds: int = Field(default=90, ge=15, le=600)
    upstream_depth: int = Field(default=6, ge=0, le=12)


class GlobalNetworkConfig(BaseModel):
    network_mode: Literal["auto", "direct", "system_proxy", "custom_proxy"] = "auto"
    proxy_url: str = Field(default="", max_length=2048)
    proxy_username: str = Field(default="", max_length=256)
    proxy_password: str = Field(default="", max_length=2048)
    clear_proxy_password: bool = False


class DeepSeekWebConfig(BaseModel):
    base_url: str = Field(default="https://api.deepseek.com", max_length=2048)
    api_key: str = Field(default="", max_length=2048)
    enabled: bool = False
    search_enabled: bool | None = None
    fetch_enabled: bool | None = None
    search_syntax: str = Field(default="", max_length=100)
    localization: str = Field(default="", max_length=45)
    count: int = Field(default=3, ge=1, le=50)
    need_content: bool = True
    fetch_top_k: int = Field(default=2, ge=0, le=5)
    max_content_chars: int = Field(default=8000, ge=1000, le=30000)
    timeout_seconds: int = Field(default=25, ge=5, le=90)
    network_mode: Literal["inherit", "auto", "direct", "system_proxy", "custom_proxy"] = "inherit"
    proxy_url: str = Field(default="", max_length=2048)
    proxy_username: str = Field(default="", max_length=256)
    proxy_password: str = Field(default="", max_length=2048)


class DeepSeekWebTestRequest(BaseModel):
    operation: Literal["search", "fetch", "both", "context"] = "context"
    query: str = Field(default="DeepSeek API 网页搜索 官方文档", min_length=1, max_length=128)
    url: str = Field(default="https://api-docs.deepseek.com/zh-cn/guides/search/", min_length=1, max_length=8192)


class McpSearchConfig(BaseModel):
    name: str = Field(default="Tavily", max_length=80)
    url: str = Field(default="https://mcp.tavily.com/mcp/", max_length=2048)
    api_key: str = Field(default="", max_length=2048)
    tool_name: str = Field(default="tavily_search", max_length=120)
    enabled: bool = False
    network_mode: Literal["inherit", "auto", "direct", "system_proxy", "custom_proxy"] = "inherit"
    proxy_url: str = Field(default="", max_length=2048)
    proxy_username: str = Field(default="", max_length=256)
    proxy_password: str = Field(default="", max_length=2048)


class NodeGenerateRequest(BaseModel):
    instruction: str = Field(min_length=2, max_length=2000)
    use_llm: bool = True


class ConceptRequest(BaseModel):
    node_ids: list[str] = Field(min_length=1, max_length=30)
    title: str = ""
    use_llm: bool = True


class ContentGenerateRequest(BaseModel):
    node_ids: list[str] = Field(min_length=1, max_length=30)
    format: str = Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_]*$")
    title: str = ""
    duration_seconds: int = Field(default=90, ge=15, le=600)
    use_llm: bool = True
    instruction: str = Field(default="", max_length=2000)
    negative_prompt: str = Field(default="", max_length=2000)
    save_as_asset: bool = True


class ContentFormatConfig(BaseModel):
    id: str = Field(min_length=2, max_length=64, pattern=r"^[a-z][a-z0-9_]*$")
    name: str = Field(min_length=1, max_length=60)
    positive_prompt: str = Field(default="", max_length=3000)
    negative_prompt: str = Field(default="", max_length=3000)


class ContentFormatsRequest(BaseModel):
    formats: list[ContentFormatConfig] = Field(min_length=1, max_length=20)


class ContentAssetUpdateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=50000)


class ContentAssetResponse(BaseModel):
    id: str
    project_id: str
    node_id: str | None = None
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
    max_tokens: int = Field(default=3000, ge=1, le=393216)
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
    network_mode: Literal["inherit", "auto", "direct", "system_proxy", "custom_proxy"] = "inherit"
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
