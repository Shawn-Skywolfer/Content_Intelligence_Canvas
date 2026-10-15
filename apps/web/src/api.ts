const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? "http://localhost:8000" : "");

export type Source = { id: string; name: string; connector_type: string; root_path: string; enabled: boolean };
export type RefreshJob = {
  job_id: string; source_id: string; status: "running" | "completed" | "failed";
  phase: string; detail: string; current_path: string; processed: number; total: number;
  indexed: number; unchanged: number; warnings_count: number; elapsed_seconds: number;
  estimated_total_seconds: number | null; error: string | null;
  agent_context: { status: string; message?: string; summary?: string; model?: string } | null;
  report: { discovered: number; indexed: number; deleted: number; warnings: Array<{ path: string; error: string }> } | null;
};
export type Hit = {
  chunk_id: string; document_id: string; title: string; heading_path: string[]; excerpt: string;
  score: number; retrieval_reasons: string[]; source_path: string; start_line: number; end_line: number;
  declared_updated_at: string | null; original_references: string[]; debug: Record<string, unknown>;
};
export type ChunkDetail = {
  chunk_id: string; document_id: string; title: string; document_type: string; heading_path: string[];
  full_text: string; source_path: string; start_line: number; end_line: number; original_references: string[];
  context: Array<{ chunk_id: string; heading_path: string[]; text: string; start_line: number; end_line: number; is_current: boolean }>;
};
export type Project = {
  id: string; name: string; idea: string; brief: string; status: string; created_at: string; updated_at: string;
};
export type Evidence = {
  chunk_id?: string; title?: string; path?: string; heading?: string[]; excerpt?: string;
  start_line?: number; end_line?: number; references?: string[];
};
export type CanvasNode = {
  id: string; type: string; title: string; body: string; status: string; locked: boolean;
  summary?: string | null; summary_model?: string | null;
  x: number; y: number; width: number; height: number;
  metadata: Record<string, unknown> & { evidence?: Evidence[] }; created_by: string;
  parent_id?: string | null; project_id?: string; canvas_id?: string; created_at?: string; updated_at?: string;
};
export type CanvasEdge = {
  id: string; source_node_id: string; target_node_id: string; relation: string; metadata: Record<string, unknown>;
};
export type CanvasData = {
  id: string; project_id: string; viewport: Record<string, number>; updated_at: string;
  nodes: CanvasNode[]; edges: CanvasEdge[];
};
export type ContentAsset = {
  id: string; project_id: string; node_id?: string | null; format: string; title: string; body: string; evidence: Evidence[];
  status: string; version: number; created_at: string; updated_at: string;
};
export type ContentFormat = { id: string; name: string; positive_prompt: string; negative_prompt: string };
export type Provider = {
  id: string; name: string; protocol: string; base_url: string; model_name: string; enabled: boolean;
  is_external: boolean; temperature: number; max_tokens: number; timeout_seconds: number;
  extra: Record<string, unknown>; has_api_key: boolean; has_proxy_password: boolean; created_at: string; updated_at: string;
};
export type SearchOptions = {
  top_k: number; lexical_weight: number; semantic_weight: number; wikilink_enabled: boolean;
  wikilink_weight: number; max_per_document: number;
};
export type ResearchJob = {
  job_id: string; project_id: string; status: "running" | "completed" | "failed";
  progress: number; phase: string; detail: string; error?: string;
  result?: { nodes: CanvasNode[]; run_id: string; used_llm: boolean; message: string };
};
export type ResearchRun = {
  id: string; project_id: string; action: string; prompt: string;
  input_node_ids: string[]; output_node_ids: string[];
  status: "running" | "completed" | "failed";
  provider_name: string | null; model_name: string | null; error: string | null;
  created_at: string; completed_at: string | null;
};
export type ContentJob = {
  job_id: string; project_id: string; status: "running" | "completed" | "failed";
  progress: number; phase: string; detail: string; error?: string;
  result?: { asset: ContentAsset | null; node: CanvasNode; run_id: string; used_llm: boolean; message: string };
};
export type MagicJob = {
  job_id: string; project_id: string; node_ids: string[]; status: "running" | "completed" | "failed" | "cancelled";
  progress: number; phase: string; detail: string; error?: string | null; created_at: string;
  result?: { node: CanvasNode; run_id: string; used_llm: boolean; message: string } | null;
};
export type McpSearchConfig = { name: string; url: string; tool_name: string; enabled: boolean; has_api_key: boolean; api_key?: string; network_mode: "auto" | "direct" | "system_proxy" | "custom_proxy"; proxy_url: string; proxy_username: string; proxy_password?: string; has_proxy_password: boolean };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const raw = await response.text();
    let message = raw || `请求失败（${response.status}）`;
    try { message = JSON.parse(raw).detail || message; } catch { /* 保留原始错误 */ }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const downloadUrl = (path: string) => `${API_BASE}${path}`;

export const api = {
  health: () => request<{ status: string; phase: string }>("/api/health"),
  listSources: () => request<Source[]>("/api/knowledge-sources"),
  createSource: (name: string, root_path: string) => request<Source>("/api/knowledge-sources", {
    method: "POST", body: JSON.stringify({ name, root_path }),
  }),
  deleteSource: (sourceId: string) => request<void>(`/api/knowledge-sources/${sourceId}`, { method: "DELETE" }),
  selectFolder: () => request<{ path: string }>("/api/system/select-folder", { method: "POST" }),
  refresh: (sourceId: string) => request<Record<string, unknown>>(`/api/knowledge-sources/${sourceId}/refresh`, { method: "POST" }),
  startRefresh: (sourceId: string) => request<RefreshJob>(`/api/knowledge-sources/${sourceId}/refresh/start`, { method: "POST" }),
  getRefreshJob: (jobId: string) => request<RefreshJob>(`/api/knowledge-sources/refresh/jobs/${jobId}`),
  latestRefresh: (sourceId: string) => request<RefreshJob | null>(`/api/knowledge-sources/${sourceId}/refresh/latest`),
  search: (sourceId: string, query: string, options: SearchOptions) => request<{ query: string; hits: Hit[]; answer: string; provider_name: string; model_name: string }>("/api/knowledge/search", {
    method: "POST", body: JSON.stringify({ source_id: sourceId, query, ...options }),
  }),
  chunkDetail: (chunkId: string) => request<ChunkDetail>(`/api/knowledge/chunks/${chunkId}`),

  listProjects: () => request<Project[]>("/api/projects"),
  createProject: (idea: string, name = "", brief = "") => request<Project>("/api/projects", {
    method: "POST", body: JSON.stringify({ idea, name, brief }),
  }),
  updateProject: (projectId: string, values: Partial<Project>) => request<Project>(`/api/projects/${projectId}`, {
    method: "PATCH", body: JSON.stringify(values),
  }),
  deleteProject: (projectId: string) => request<void>(`/api/projects/${projectId}`, { method: "DELETE" }),
  getCanvas: (projectId: string) => request<CanvasData>(`/api/projects/${projectId}/canvas`),
  saveCanvas: (projectId: string, canvas: CanvasData) => request<CanvasData>(`/api/projects/${projectId}/canvas`, {
    method: "PUT", body: JSON.stringify({ nodes: canvas.nodes, edges: canvas.edges, viewport: canvas.viewport, base_updated_at: canvas.updated_at }),
  }),
  createNode: (projectId: string, node: Partial<CanvasNode>) => request<CanvasNode>(`/api/projects/${projectId}/nodes`, {
    method: "POST", body: JSON.stringify(node),
  }),
  updateNode: (projectId: string, nodeId: string, values: Partial<CanvasNode>) => request<CanvasNode>(`/api/projects/${projectId}/nodes/${nodeId}`, {
    method: "PATCH", body: JSON.stringify(values),
  }),
  summarizeNode: (projectId: string, nodeId: string, force = false) => request<CanvasNode>(`/api/projects/${projectId}/nodes/${nodeId}/summary`, {
    method: "POST", body: JSON.stringify({ force }),
  }),
  deleteNode: (projectId: string, nodeId: string) => request<void>(`/api/projects/${projectId}/nodes/${nodeId}`, { method: "DELETE" }),
  quickResearch: (projectId: string, sourceId: string, query: string, findingCount: number, useLlm: boolean) =>
    request<{ nodes: CanvasNode[]; run_id: string; used_llm: boolean; message: string }>(`/api/projects/${projectId}/research/quick`, {
      method: "POST", body: JSON.stringify({ source_id: sourceId, query, finding_count: findingCount, use_llm: useLlm }),
    }),
  startQuickResearch: (projectId: string, sourceId: string, query: string, findingCount: number, useLlm: boolean) =>
    request<ResearchJob>(`/api/projects/${projectId}/research/quick/start`, {
      method: "POST", body: JSON.stringify({ source_id: sourceId, query, finding_count: findingCount, use_llm: useLlm }),
    }),
  researchJob: (jobId: string) => request<ResearchJob>(`/api/research/jobs/${jobId}`),
  listRuns: (projectId: string) => request<ResearchRun[]>(`/api/projects/${projectId}/runs`),
  deleteResearchRun: (projectId: string, runId: string) =>
    request<void>(`/api/projects/${projectId}/research/runs/${runId}`, { method: "DELETE" }),
  magic: (projectId: string, nodeIds: string[], instruction: string, outputType = "insight", negativePrompt = "") =>
    request<{ nodes: CanvasNode[]; run_id: string; used_llm: boolean; message: string }>(`/api/projects/${projectId}/magic`, {
      method: "POST", body: JSON.stringify({ node_ids: nodeIds, instruction, output_type: outputType, negative_prompt: negativePrompt }),
    }),
  startMagic: (projectId: string, nodeIds: string[], instruction: string, outputType: string, negativePrompt: string, webSearch: boolean, format: string, durationSeconds: number, upstreamDepth = 6) =>
    request<MagicJob>(`/api/projects/${projectId}/magic/start`, {
      method: "POST", body: JSON.stringify({ node_ids: nodeIds, instruction, output_type: outputType, negative_prompt: negativePrompt, web_search: webSearch, format, duration_seconds: durationSeconds, upstream_depth: upstreamDepth }),
    }),
  listMagicJobs: (projectId: string) => request<MagicJob[]>(`/api/projects/${projectId}/magic/jobs`),
  cancelMagicJob: (jobId: string) => request<MagicJob>(`/api/magic/jobs/${jobId}/cancel`, { method: "POST" }),
  generateIntoNode: (projectId: string, nodeId: string, instruction: string, useLlm = true) =>
    request<{ nodes: CanvasNode[]; run_id: string; used_llm: boolean; message: string }>(`/api/projects/${projectId}/nodes/${nodeId}/generate`, {
      method: "POST", body: JSON.stringify({ instruction, use_llm: useLlm }),
    }),
  createConcept: (projectId: string, nodeIds: string[], title = "", useLlm = true) =>
    request<{ nodes: CanvasNode[]; run_id: string; used_llm: boolean; message: string }>(`/api/projects/${projectId}/concept`, {
      method: "POST", body: JSON.stringify({ node_ids: nodeIds, title, use_llm: useLlm }),
    }),
  listAssets: (projectId: string) => request<ContentAsset[]>(`/api/projects/${projectId}/assets`),
  updateAsset: (projectId: string, assetId: string, title: string, body: string) => request<ContentAsset>(`/api/projects/${projectId}/assets/${assetId}`, {
    method: "PATCH", body: JSON.stringify({ title, body }),
  }),
  deleteAsset: (projectId: string, assetId: string) => request<void>(`/api/projects/${projectId}/assets/${assetId}`, { method: "DELETE" }),
  listContentFormats: () => request<ContentFormat[]>("/api/content-formats"),
  saveContentFormats: (formats: ContentFormat[]) => request<ContentFormat[]>("/api/content-formats", {
    method: "PUT", body: JSON.stringify({ formats }),
  }),
  generateContent: (projectId: string, nodeIds: string[], format: string, title = "", durationSeconds = 90, useLlm = true, instruction = "", saveAsAsset = true, negativePrompt = "") =>
    request<{ asset: ContentAsset | null; node: CanvasNode; run_id: string; used_llm: boolean; message: string }>(`/api/projects/${projectId}/content/generate`, {
      method: "POST", body: JSON.stringify({ node_ids: nodeIds, format, title, duration_seconds: durationSeconds, use_llm: useLlm, instruction, negative_prompt: negativePrompt, save_as_asset: saveAsAsset }),
    }),
  startContentGeneration: (projectId: string, nodeIds: string[], format: string, title = "", durationSeconds = 90, useLlm = true, instruction = "", saveAsAsset = false, negativePrompt = "") =>
    request<ContentJob>(`/api/projects/${projectId}/content/generate/start`, {
      method: "POST", body: JSON.stringify({ node_ids: nodeIds, format, title, duration_seconds: durationSeconds, use_llm: useLlm, instruction, negative_prompt: negativePrompt, save_as_asset: saveAsAsset }),
    }),
  contentJob: (jobId: string) => request<ContentJob>(`/api/content/jobs/${jobId}`),
  saveNodeAsAsset: (projectId: string, nodeId: string) =>
    request<{ asset: ContentAsset; node: CanvasNode; message: string }>(`/api/projects/${projectId}/nodes/${nodeId}/save-asset`, { method: "POST" }),

  listProviders: () => request<Provider[]>("/api/providers"),
  activeProvider: () => request<{ provider_id: string | null; model_name: string | null }>("/api/providers/active"),
  activateProvider: (id: string) => request<{ provider_id: string; model_name: string }>(`/api/providers/${id}/activate`, { method: "POST" }),
  saveProvider: (provider: Record<string, unknown>) => request<Provider>("/api/providers", {
    method: "POST", body: JSON.stringify(provider),
  }),
  testProvider: (providerId: string) => request<Record<string, unknown>>(`/api/providers/${providerId}/test`, { method: "POST" }),
  discoverModels: (values: { provider_id?: string; base_url: string; api_key?: string | null; timeout_seconds: number; network_mode: string; proxy_url?: string | null; proxy_username?: string | null; proxy_password?: string | null }) =>
    request<{ models: string[]; count: number; latency_ms: number; message: string }>("/api/providers/discover-models", {
      method: "POST", body: JSON.stringify(values),
    }),
  getSecurity: () => request<{ protect_internal_data: boolean }>("/api/settings/security"),
  getMcpSearch: () => request<McpSearchConfig>("/api/settings/mcp-search"),
  saveMcpSearch: (config: McpSearchConfig) => request<McpSearchConfig>("/api/settings/mcp-search", { method: "PUT", body: JSON.stringify(config) }),
  testMcpSearch: () => request<{ tools: string[]; message: string; latency_ms: number; endpoint: string; search_tool: string; search_tool_available: boolean; network_mode: string }>("/api/settings/mcp-search/test", { method: "POST" }),
  saveSecurity: (protect_internal_data: boolean) => request<{ protect_internal_data: boolean }>("/api/settings/security", {
    method: "PUT", body: JSON.stringify({ protect_internal_data }),
  }),
};
