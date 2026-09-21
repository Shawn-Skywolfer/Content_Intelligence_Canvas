const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

export type Source = {
  id: string;
  name: string;
  connector_type: string;
  root_path: string;
  enabled: boolean;
};

export type Hit = {
  chunk_id: string;
  title: string;
  heading_path: string[];
  excerpt: string;
  score: number;
  retrieval_reasons: string[];
  source_path: string;
  start_line: number;
  end_line: number;
  declared_updated_at: string | null;
  original_references: string[];
  debug: Record<string, unknown>;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error((await response.text()) || response.statusText);
  return response.json() as Promise<T>;
}

export const api = {
  listSources: () => request<Source[]>("/api/knowledge-sources"),
  createSource: (name: string, root_path: string) =>
    request<Source>("/api/knowledge-sources", {
      method: "POST",
      body: JSON.stringify({ name, root_path }),
    }),
  refresh: (sourceId: string) =>
    request<Record<string, unknown>>(`/api/knowledge-sources/${sourceId}/refresh`, {
      method: "POST",
    }),
  search: (sourceId: string, query: string) =>
    request<{ query: string; hits: Hit[] }>("/api/knowledge/search", {
      method: "POST",
      body: JSON.stringify({ source_id: sourceId, query, top_k: 10 }),
    }),
};

