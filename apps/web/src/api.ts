const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? "http://localhost:8000" : "");

export type Source = { id: string; name: string; connector_type: string; root_path: string; enabled: boolean };
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
  id: string; project_id: string; format: string; title: string; body: string; evidence: Evidence[];
  status: string; version: number; created_at: string; updated_at: string;
};
export type Provider = {
  id: string; name: string; protocol: string; base_url: string; model_name: string; enabled: boolean;
  is_external: boolean; temperature: number; max_tokens: number; timeout_seconds: number;
  extra: Record<string, unknown>; has_api_key: boolean; created_at: string; updated_at: string;
};
export type SearchOptions = {
  top_k: number; lexical_weight: number; semantic_weight: number; wikilink_enabled: boolean;
  wikilink_weight: number; max_per_document: number;
};

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
  refresh: (sourceId: string) => request<Record<string, unknown>>(`/api/knowledge-sources/${sourceId}/refresh`, { method: "POST" }),
  search: (sourceId: string, query: string, options: SearchOptions) => request<{ query: string; hits: Hit[] }>("/api/knowledge/search", {
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
  getCanvas: (projectId: string) => request<CanvasData>(`/api/projects/${projectId}/canvas`),
  saveCanvas: (projectId: string, canvas: CanvasData) => request<CanvasData>(`/api/projects/${projectId}/canvas`, {
    method: "PUT", body: JSON.stringify({ nodes: canvas.nodes, edges: canvas.edges, viewport: canvas.viewport }),
  }),
  createNode: (projectId: string, node: Partial<CanvasNode>) => request<CanvasNode>(`/api/projects/${projectId}/nodes`, {
    method: "POST", body: JSON.stringify(node),
  }),
  updateNode: (projectId: string, nodeId: string, values: Partial<CanvasNode>) => request<CanvasNode>(`/api/projects/${projectId}/nodes/${nodeId}`, {
    method: "PATCH", body: JSON.stringify(values),
  }),
  deleteNode: (projectId: string, nodeId: string) => request<void>(`/api/projects/${projectId}/nodes/${nodeId}`, { method: "DELETE" }),
  quickResearch: (projectId: string, sourceId: string, query: string, findingCount: number, useLlm: boolean) =>
    request<{ nodes: CanvasNode[]; run_id: string; used_llm: boolean; message: string }>(`/api/projects/${projectId}/research/quick`, {
      method: "POST", body: JSON.stringify({ source_id: sourceId, query, finding_count: findingCount, use_llm: useLlm }),
    }),
  magic: (projectId: string, nodeIds: string[], instruction: string, outputType = "insight") =>
    request<{ nodes: CanvasNode[]; run_id: string; used_llm: boolean; message: string }>(`/api/projects/${projectId}/magic`, {
      method: "POST", body: JSON.stringify({ node_ids: nodeIds, instruction, output_type: outputType }),
    }),
  createConcept: (projectId: string, nodeIds: string[], title = "", useLlm = true) =>
    request<{ nodes: CanvasNode[]; run_id: string; used_llm: boolean; message: string }>(`/api/projects/${projectId}/concept`, {
      method: "POST", body: JSON.stringify({ node_ids: nodeIds, title, use_llm: useLlm }),
    }),
  listAssets: (projectId: string) => request<ContentAsset[]>(`/api/projects/${projectId}/assets`),
  generateContent: (projectId: string, nodeIds: string[], format: "wechat" | "video_script" | "poster_campaign", title = "", durationSeconds = 90, useLlm = true) =>
    request<{ asset: ContentAsset; node: CanvasNode; run_id: string; used_llm: boolean; message: string }>(`/api/projects/${projectId}/content/generate`, {
      method: "POST", body: JSON.stringify({ node_ids: nodeIds, format, title, duration_seconds: durationSeconds, use_llm: useLlm }),
    }),

  listProviders: () => request<Provider[]>("/api/providers"),
  saveProvider: (provider: Record<string, unknown>) => request<Provider>("/api/providers", {
    method: "POST", body: JSON.stringify(provider),
  }),
  testProvider: (providerId: string) => request<Record<string, unknown>>(`/api/providers/${providerId}/test`, { method: "POST" }),
  discoverModels: (values: { provider_id?: string; base_url: string; api_key?: string | null; timeout_seconds: number }) =>
    request<{ models: string[]; count: number; latency_ms: number; message: string }>("/api/providers/discover-models", {
      method: "POST", body: JSON.stringify(values),
    }),
  getSecurity: () => request<{ protect_internal_data: boolean }>("/api/settings/security"),
  saveSecurity: (protect_internal_data: boolean) => request<{ protect_internal_data: boolean }>("/api/settings/security", {
    method: "PUT", body: JSON.stringify({ protect_internal_data }),
  }),
};
