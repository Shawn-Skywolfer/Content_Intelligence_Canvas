import { useEffect, useState } from "react";
import ReactMarkdown from "./MarkdownContent";
import { api, ContentAsset, ContentFormat, downloadUrl, Project } from "./api";

export default function AssetView({ project, assets, onChanged, onOpenNode, setStatus }: {
  project: Project | null;
  assets: ContentAsset[];
  onChanged: () => Promise<void>;
  onOpenNode: (id: string) => void;
  setStatus: (value: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [formats, setFormats] = useState<ContentFormat[]>([]);
  useEffect(() => { api.listContentFormats().then(setFormats).catch((error) => setStatus(String(error))); }, []);
  useEffect(() => { setOpenId(null); setEditId(null); }, [project?.id]);

  if (!project) return <div className="empty-state"><strong>请先选择项目</strong><p>每个项目单独管理已确认的最终内容。</p></div>;

  function beginEdit(asset: ContentAsset) { setOpenId(asset.id); setEditId(asset.id); setTitle(asset.title); setBody(asset.body); }
  async function save(asset: ContentAsset) {
    if (!title.trim() || !body.trim()) { setStatus("标题和正文不能为空"); return; }
    setBusy(true);
    try { await api.updateAsset(project!.id, asset.id, title, body); await onChanged(); setEditId(null); setStatus("内容资产已保存为新版本，对应白板节点已同步"); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function remove(asset: ContentAsset) {
    if (!window.confirm(`确定删除内容资产“${asset.title}”吗？白板中的输出节点会保留为草稿。`)) return;
    setBusy(true);
    try { await api.deleteAsset(project!.id, asset.id); await onChanged(); setOpenId(null); setEditId(null); setStatus("内容资产已删除，白板节点仍然保留"); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <>
    <header className="page-header"><div><p className="eyebrow">内容资产</p><h1>{project.name} · 最终内容</h1><p>仅管理从白板输出节点确认保存的稿件。可继续编辑、导出或删除，修改会同步到白板。</p></div><div className="header-actions"><a className="button secondary" href={downloadUrl(`/api/projects/${project.id}/export?format=markdown`)}>导出整个项目</a></div></header>
    <section className="section-block"><div className="section-title"><h2>已保存内容</h2><span>{assets.length} 项 · 按项目隔离</span></div>
      {assets.length ? <div className="asset-manager-list">{assets.map((asset) => <article className={`asset-card ${openId === asset.id ? "open" : ""}`} key={asset.id}>
        <button className="asset-summary" onClick={() => { setOpenId(openId === asset.id ? null : asset.id); setEditId(null); }}><div><span>{formats.find((item) => item.id === asset.format)?.name ?? asset.format}</span><h3>{asset.title}</h3><small>版本 {asset.version} · {asset.evidence.length} 条证据 · 更新于 {new Date(asset.updated_at).toLocaleString("zh-CN")}</small></div><b>{openId === asset.id ? "收起" : "展开"}</b></button>
        {openId === asset.id && <div className="asset-body">{editId === asset.id ? <div className="asset-editor"><label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} /></label><label>Markdown 正文<textarea value={body} onChange={(event) => setBody(event.target.value)} /></label></div> : <div className="asset-markdown"><ReactMarkdown>{asset.body}</ReactMarkdown></div>}
          <div className="asset-actions">{editId === asset.id ? <><button className="primary" disabled={busy || !title.trim() || !body.trim()} onClick={() => save(asset)}>{busy ? "保存中…" : "保存新版本"}</button><button className="secondary" disabled={busy} onClick={() => setEditId(null)}>取消</button></> : <><button className="secondary" onClick={() => beginEdit(asset)}>二次修改</button><a className="button secondary" href={downloadUrl(`/api/assets/${asset.id}/export`)}>导出 Markdown</a>{asset.node_id && <button className="secondary" onClick={() => onOpenNode(asset.node_id!)}>查看白板节点</button>}<button className="text-button danger" disabled={busy} onClick={() => remove(asset)}>删除资产</button></>}</div>
        </div>}</article>)}</div> : <div className="empty-state"><strong>这个项目还没有内容资产</strong><p>在白板选择节点，通过 AI 共创生成输出；编辑确认后，在节点详情点击“保存到内容资产”。</p></div>}
    </section>
  </>;
}
