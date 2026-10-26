import { useState } from "react";
import { api, Evidence, WikiOriginal } from "./api";
import MarkdownContent from "./MarkdownContent";

export default function WikiEvidence({ item, sourceId }: { item: Evidence; sourceId?: string }) {
  const [original, setOriginal] = useState<WikiOriginal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setBusy(true); setError("");
    try { setOriginal(await api.wikiOriginal({ ...item, source_id: item.source_id || sourceId })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <details className="wiki-evidence"><summary>{item.title || item.path || "Wiki 引用"}</summary><small>{item.path}｜{item.heading?.join(" › ")}</small>
    {item.excerpt && <MarkdownContent>{item.excerpt}</MarkdownContent>}
    <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>{busy ? "正在读取 Wiki 原文…" : original ? "重新读取原始词条" : "查看完整 Wiki 原始词条"}</button>
    {error && <p className="settings-error" role="status">{error}</p>}
    {original && <div className="wiki-original"><p><strong>完整词条 · {original.content_chars} 字符</strong><br />{original.path}</p><MarkdownContent>{original.text}</MarkdownContent></div>}
    {item.references?.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}
  </details>;
}
