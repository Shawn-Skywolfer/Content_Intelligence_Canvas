import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import CanvasView from "./CanvasView";
import {
  api, CanvasData, CanvasEdge, CanvasNode, ChunkDetail, ContentAsset, downloadUrl,
  Evidence, Hit, Project, Provider, SearchOptions, Source,
} from "./api";

type View = "home" | "search" | "research" | "canvas" | "content" | "settings";

const NAV: Array<{ id: View; label: string; icon: string }> = [
  { id: "home", label: "项目", icon: "项" },
  { id: "search", label: "知识检索", icon: "检" },
  { id: "research", label: "快速研究", icon: "研" },
  { id: "canvas", label: "内容白板", icon: "板" },
  { id: "content", label: "内容资产", icon: "产" },
  { id: "settings", label: "设置", icon: "设" },
];

const NODE_LABELS: Record<string, string> = {
  idea: "想法", brief: "简报", note: "笔记", knowledge: "知识", fact: "事实",
  signal: "信号", internal_knowledge: "内部知识", insight: "洞察", challenge: "质疑",
  creative_pattern: "创意模式", content_concept: "内容概念", output: "内容输出", frame: "分组",
};
const STATUS_LABELS: Record<string, string> = {
  exploring: "探索中", candidate: "候选", approved: "已批准", locked: "已锁定",
};
const REASON_LABELS: Record<string, string> = {
  fts: "关键词", semantic: "语义", wikilink: "知识关联", title_or_heading_match: "标题匹配",
  entity_title_match: "实体匹配", reference_section_penalty: "参考区降权",
};
const FORMAT_LABELS: Record<string, string> = {
  wechat: "微信公众号", video_script: "视频号/短视频脚本", poster_campaign: "海报/营销活动",
};
const PROVIDER_PRESETS = {
  deepseek: { name: "DeepSeek", base_url: "https://api.deepseek.com", model_name: "deepseek-flash" },
  aihubmix: { name: "AIHubMix", base_url: "https://aihubmix.com/v1", model_name: "" },
  custom: { name: "自定义模型", base_url: "", model_name: "" },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function MarkdownText({ text }: { text: string }) {
  return <div className="markdown-text">{text.split("\n").map((line, index) => {
    if (line.startsWith("### ")) return <h4 key={index}>{line.slice(4)}</h4>;
    if (line.startsWith("## ")) return <h3 key={index}>{line.slice(3)}</h3>;
    if (line.startsWith("# ")) return <h2 key={index}>{line.slice(2)}</h2>;
    if (line.startsWith("- ")) return <div className="md-list" key={index}>• {line.slice(2)}</div>;
    if (line.startsWith("> ")) return <blockquote key={index}>{line.slice(2)}</blockquote>;
    return line ? <p key={index}>{line}</p> : <br key={index} />;
  })}</div>;
}

export default function App() {
  const [view, setView] = useState<View>("home");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [canvas, setCanvas] = useState<CanvasData | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [assets, setAssets] = useState<ContentAsset[]>([]);
  const [status, setStatus] = useState("正在连接本地工作台…");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const saveSequence = useRef(0);

  const activeProject = projects.find((item) => item.id === projectId) ?? null;

  useEffect(() => {
    Promise.all([api.health(), api.listProjects(), api.listSources()])
      .then(([, projectItems, sourceItems]) => {
        setProjects(projectItems);
        setSources(sourceItems);
        if (projectItems[0]) setProjectId(projectItems[0].id);
        setStatus("工作台已就绪");
      })
      .catch((error) => setStatus(`无法连接后端：${errorText(error)}`));
  }, []);

  useEffect(() => {
    if (!projectId) { setCanvas(null); setAssets([]); return; }
    Promise.all([api.getCanvas(projectId), api.listAssets(projectId)])
      .then(([canvasData, assetItems]) => { setCanvas(canvasData); setAssets(assetItems); setSelectedIds([]); })
      .catch((error) => setStatus(errorText(error)));
  }, [projectId]);

  useEffect(() => {
    if (!dirty || !canvas || !projectId) return;
    const sequence = ++saveSequence.current;
    const timer = window.setTimeout(() => {
      api.saveCanvas(projectId, canvas).then((saved) => {
        if (sequence === saveSequence.current) { setCanvas(saved); setDirty(false); setStatus("白板已自动保存"); }
      }).catch((error) => setStatus(`自动保存失败：${errorText(error)}`));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [canvas, dirty, projectId]);

  function changeCanvas(next: CanvasData) { setCanvas(next); setDirty(true); }

  async function refreshCanvas() {
    if (!projectId) return;
    const [canvasData, assetItems] = await Promise.all([api.getCanvas(projectId), api.listAssets(projectId)]);
    setCanvas(canvasData); setAssets(assetItems); setDirty(false);
  }

  async function createProject(idea: string, name: string, brief: string) {
    setBusy(true);
    try {
      const project = await api.createProject(idea, name, brief);
      setProjects((current) => [project, ...current]);
      setProjectId(project.id);
      setView("research");
      setStatus("项目已创建，可直接开始快速研究");
    } catch (error) { setStatus(errorText(error)); }
    finally { setBusy(false); }
  }

  const content = (() => {
    if (view === "home") return <HomeView projects={projects} activeId={projectId} busy={busy} onCreate={createProject} onOpen={(id) => { setProjectId(id); setView("canvas"); }} />;
    if (view === "search") return <SearchView sources={sources} project={activeProject} onAdded={refreshCanvas} setStatus={setStatus} />;
    if (view === "research") return <ResearchView sources={sources} project={activeProject} busy={busy} setBusy={setBusy} setStatus={setStatus} onDone={async () => { await refreshCanvas(); setView("canvas"); }} />;
    if (view === "canvas") return <CanvasView project={activeProject} canvas={canvas} selectedIds={selectedIds} setSelectedIds={setSelectedIds} onChange={changeCanvas} onRefresh={refreshCanvas} setStatus={setStatus} />;
    if (view === "content") return <ContentView project={activeProject} canvas={canvas} assets={assets} selectedIds={selectedIds} setSelectedIds={setSelectedIds} busy={busy} setBusy={setBusy} setStatus={setStatus} onDone={refreshCanvas} />;
    return <SettingsView sources={sources} setSources={setSources} setStatus={setStatus} />;
  })();

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">智</span><div><strong>内容智能白板</strong><small>可信知识驱动的内容工作台</small></div></div>
      <nav aria-label="主要导航">{NAV.map((item) => <button className={view === item.id ? "active" : ""} key={item.id} onClick={() => setView(item.id)}>
        <span aria-hidden="true">{item.icon}</span><b>{item.label}</b>
      </button>)}</nav>
      <div className="sidebar-project">
        <label>当前项目</label>
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">尚未选择</option>
          {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
        </select>
      </div>
      <div className="system-status"><i className={status.includes("失败") || status.includes("无法") ? "bad" : ""} />{status}</div>
    </aside>
    <main className="workspace">{content}</main>
  </div>;
}

function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{actions && <div className="header-actions">{actions}</div>}</header>;
}

function EmptyProject() {
  return <div className="empty-state"><strong>请先创建或选择一个项目</strong><p>项目会保存想法、研究、白板节点和最终内容资产。</p></div>;
}

function HomeView({ projects, activeId, busy, onCreate, onOpen }: {
  projects: Project[]; activeId: string; busy: boolean;
  onCreate: (idea: string, name: string, brief: string) => void; onOpen: (id: string) => void;
}) {
  const [idea, setIdea] = useState(""); const [name, setName] = useState(""); const [brief, setBrief] = useState("");
  return <>
    <PageHeader eyebrow="项目入口" title="今天想探索什么内容？" description="从一句粗想法开始，内部知识库会成为后续研究、白板共创和内容输出的证据底座。" />
    <section className="hero-create card">
      <textarea value={idea} onChange={(event) => setIdea(event.target.value)} placeholder="例如：人工智能数据中心的电力问题，正在带来哪些新的内容机会？" />
      <div className="create-details"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="项目名称（可选）" /><input value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="受众、目标或限制条件（可选）" /></div>
      <button className="primary large" disabled={busy || idea.trim().length < 2} onClick={() => onCreate(idea, name, brief)}>创建项目并开始探索</button>
    </section>
    <section className="section-block"><div className="section-title"><h2>最近项目</h2><span>{projects.length} 个长期内容资产</span></div>
      <div className="project-grid">{projects.length ? projects.map((project) => <button className={`project-card ${activeId === project.id ? "current" : ""}`} key={project.id} onClick={() => onOpen(project.id)}>
        <span className="project-state">{project.status === "active" ? "进行中" : project.status}</span><h3>{project.name}</h3><p>{project.idea}</p><small>更新于 {new Date(project.updated_at).toLocaleString("zh-CN")}</small>
      </button>) : <div className="empty-state"><strong>还没有项目</strong><p>上方输入一句想法即可创建。</p></div>}</div>
    </section>
  </>;
}

function SearchView({ sources, project, onAdded, setStatus }: { sources: Source[]; project: Project | null; onAdded: () => Promise<void>; setStatus: (value: string) => void }) {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [query, setQuery] = useState(project?.idea ?? "");
  const [hits, setHits] = useState<Hit[]>([]); const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, ChunkDetail>>({}); const [showConfig, setShowConfig] = useState(false);
  const [options, setOptions] = useState<SearchOptions>({ top_k: 10, lexical_weight: 1, semantic_weight: 1, wikilink_enabled: true, wikilink_weight: .75, max_per_document: 2 });
  useEffect(() => { if (!sourceId && sources[0]) setSourceId(sources[0].id); }, [sources, sourceId]);
  useEffect(() => { if (!query && project) setQuery(project.idea); }, [project, query]);
  async function search(event?: FormEvent) { event?.preventDefault(); if (!sourceId || !query.trim()) return; setBusy(true); setStatus("正在进行混合检索…");
    try { const result = await api.search(sourceId, query, options); setHits(result.hits); setStatus(`找到 ${result.hits.length} 条相关证据`); }
    catch (error) { setStatus(errorText(error)); } finally { setBusy(false); }
  }
  async function toggleDetail(hit: Hit) { if (expanded[hit.chunk_id]) { const next = { ...expanded }; delete next[hit.chunk_id]; setExpanded(next); return; }
    try { const detail = await api.chunkDetail(hit.chunk_id); setExpanded((current) => ({ ...current, [hit.chunk_id]: detail })); } catch (error) { setStatus(errorText(error)); }
  }
  async function addToCanvas(hit: Hit) { if (!project) { setStatus("请先创建项目，再把证据加入白板"); return; }
    try { await api.createNode(project.id, { type: "knowledge", title: hit.title, body: hit.excerpt, status: "candidate", x: 420, y: 160 + Math.random() * 360, metadata: { evidence: [{ chunk_id: hit.chunk_id, title: hit.title, path: hit.source_path, heading: hit.heading_path, excerpt: hit.excerpt, start_line: hit.start_line, end_line: hit.end_line, references: hit.original_references }] } }); await onAdded(); setStatus("已加入内容白板"); }
    catch (error) { setStatus(errorText(error)); }
  }
  return <>
    <PageHeader eyebrow="内部知识检索" title="从知识库找到可验证的证据" description="关键词、语义向量与知识链接共同召回；每条结果都可展开完整正文和相邻上下文。" actions={<button className="secondary" onClick={() => setShowConfig(!showConfig)}>检索配置</button>} />
    <section className="search-box card"><div className="field"><label>知识源</label><select value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">请选择知识源</option>{sources.map((source) => <option value={source.id} key={source.id}>{source.name}</option>)}</select></div>
      <form onSubmit={search} className="search-row"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入要查证的问题、观点、产品或概念" /><button className="primary" disabled={busy || !sourceId}>开始检索</button></form>
      {showConfig && <div className="config-grid">
        <label>结果数量<input type="number" min="1" max="30" value={options.top_k} onChange={(e) => setOptions({ ...options, top_k: Number(e.target.value) })} /></label>
        <label>关键词权重<input type="number" step="0.1" min="0" max="3" value={options.lexical_weight} onChange={(e) => setOptions({ ...options, lexical_weight: Number(e.target.value) })} /></label>
        <label>语义权重<input type="number" step="0.1" min="0" max="3" value={options.semantic_weight} onChange={(e) => setOptions({ ...options, semantic_weight: Number(e.target.value) })} /></label>
        <label>单文档上限<input type="number" min="1" max="5" value={options.max_per_document} onChange={(e) => setOptions({ ...options, max_per_document: Number(e.target.value) })} /></label>
        <label className="check"><input type="checkbox" checked={options.wikilink_enabled} onChange={(e) => setOptions({ ...options, wikilink_enabled: e.target.checked })} />启用知识链接扩展</label>
        <label>关联权重<input type="number" step="0.05" min="0" max="2" value={options.wikilink_weight} onChange={(e) => setOptions({ ...options, wikilink_weight: Number(e.target.value) })} /></label>
      </div>}
    </section>
    <section className="result-list">{hits.map((hit, index) => <article className="result-card" key={hit.chunk_id}>
      <div className="rank">{String(index + 1).padStart(2, "0")}</div><div className="result-main"><div className="result-head"><div><h2>{hit.title}</h2><p>{hit.source_path} · 第 {hit.start_line}–{hit.end_line} 行</p></div><strong>{hit.score.toFixed(4)}</strong></div>
      <p className="heading-path">{hit.heading_path.join(" › ") || "文档开头"}</p><p className="result-excerpt">{hit.excerpt}</p>
      <div className="tag-row">{hit.retrieval_reasons.map((reason) => <span key={reason}>{REASON_LABELS[reason] ?? reason}</span>)}</div>
      <div className="card-actions"><button className="secondary" onClick={() => toggleDetail(hit)}>{expanded[hit.chunk_id] ? "收起完整内容" : "展开完整内容"}</button><button className="primary ghost" onClick={() => addToCanvas(hit)}>加入白板</button></div>
      {expanded[hit.chunk_id] && <div className="full-detail"><div className="detail-meta"><strong>完整证据段落</strong><span>{expanded[hit.chunk_id].document_type}</span></div><MarkdownText text={expanded[hit.chunk_id].full_text} />
        <details><summary>查看前后文（{expanded[hit.chunk_id].context.length} 段）</summary>{expanded[hit.chunk_id].context.map((part) => <div className={part.is_current ? "context current" : "context"} key={part.chunk_id}><small>第 {part.start_line}–{part.end_line} 行</small><MarkdownText text={part.text} /></div>)}</details>
        {!!expanded[hit.chunk_id].original_references.length && <div className="references"><strong>原始参考来源</strong>{expanded[hit.chunk_id].original_references.map((url) => <a href={url} target="_blank" rel="noreferrer" key={url}>{url}</a>)}</div>}
      </div>}</div></article>)}</section>
  </>;
}

function ResearchView({ sources, project, busy, setBusy, setStatus, onDone }: { sources: Source[]; project: Project | null; busy: boolean; setBusy: (value: boolean) => void; setStatus: (value: string) => void; onDone: () => Promise<void> }) {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? ""); const [query, setQuery] = useState(project?.idea ?? ""); const [count, setCount] = useState(6); const [useLlm, setUseLlm] = useState(true);
  useEffect(() => { if (!sourceId && sources[0]) setSourceId(sources[0].id); }, [sourceId, sources]);
  useEffect(() => { if (project) setQuery(project.idea); }, [project]);
  if (!project) return <><PageHeader eyebrow="快速研究" title="只基于内部知识库形成研究发现" description="默认不联网，事实、信号、内部知识和洞察会分层进入白板。" /><EmptyProject /></>;
  const activeProject = project;
  async function run() { if (!sourceId || !query.trim()) return; setBusy(true); setStatus("正在检索并归纳内部知识…");
    try { const result = await api.quickResearch(activeProject.id, sourceId, query, count, useLlm); setStatus(result.message); await onDone(); }
    catch (error) { setStatus(errorText(error)); } finally { setBusy(false); }
  }
  return <><PageHeader eyebrow="快速研究" title="从问题到研究发现与创意方向" description="系统先检索真实知识库，再生成 4–8 条高价值研究发现和三条可继续发展的内容方向。" />
    <section className="research-layout"><div className="card research-form"><div className="field"><label>研究问题</label><textarea value={query} onChange={(e) => setQuery(e.target.value)} /></div><div className="field"><label>内部知识源</label><select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>{sources.map((source) => <option value={source.id} key={source.id}>{source.name}</option>)}</select></div>
      <div className="inline-fields"><label>研究发现数量<input type="number" min="3" max="8" value={count} onChange={(e) => setCount(Number(e.target.value))} /></label><label className="check"><input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} />使用已配置大模型归纳</label></div>
      <button className="primary large" disabled={busy || !sourceId} onClick={run}>{busy ? "正在研究…" : "开始快速研究"}</button></div>
      <div className="research-notes"><div><span>01</span><h3>内部优先</h3><p>快速模式只读取已启用知识库，不主动联网。</p></div><div><span>02</span><h3>保留证据</h3><p>每条研究发现都保存文件、标题层级、段落与参考来源。</p></div><div><span>03</span><h3>进入白板</h3><p>生成新节点与关联边，不覆盖已有思考。</p></div></div>
    </section></>;
}

function LegacyCanvasView({ project, canvas, selectedIds, setSelectedIds, onChange, onRefresh, setStatus }: {
  project: Project | null; canvas: CanvasData | null; selectedIds: string[]; setSelectedIds: (ids: string[]) => void;
  onChange: (canvas: CanvasData) => void; onRefresh: () => Promise<void>; setStatus: (value: string) => void;
}) {
  const [zoom, setZoom] = useState(0.82); const [magic, setMagic] = useState(""); const [magicType, setMagicType] = useState("insight"); const [busy, setBusy] = useState(false);
  const drag = useRef<{ id: string; startX: number; startY: number; x: number; y: number } | null>(null);
  const selected = canvas?.nodes.filter((node) => selectedIds.includes(node.id)) ?? [];
  const primary = selected.length === 1 ? selected[0] : null;
  useEffect(() => {
    function move(event: PointerEvent) { if (!drag.current || !canvas) return; const item = drag.current; const dx = (event.clientX - item.startX) / zoom; const dy = (event.clientY - item.startY) / zoom; onChange({ ...canvas, nodes: canvas.nodes.map((node) => node.id === item.id ? { ...node, x: item.x + dx, y: item.y + dy } : node) }); }
    function up() { drag.current = null; }
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [canvas, onChange, zoom]);
  if (!project) return <><PageHeader eyebrow="内容白板" title="把研究变成可持续积累的内容资产" description="节点、证据、分支和内容输出都保存在同一个项目中。" /><EmptyProject /></>;
  if (!canvas) return <div className="empty-state">正在加载白板…</div>;
  const activeProject = project;
  const board = canvas;
  function startDrag(event: ReactPointerEvent, node: CanvasNode) { if ((event.target as HTMLElement).closest("button,input,textarea,select")) return; event.currentTarget.setPointerCapture(event.pointerId); if (event.ctrlKey || event.metaKey) setSelectedIds(selectedIds.includes(node.id) ? selectedIds.filter((id) => id !== node.id) : [...selectedIds, node.id]); else if (!selectedIds.includes(node.id)) setSelectedIds([node.id]); drag.current = { id: node.id, startX: event.clientX, startY: event.clientY, x: node.x, y: node.y }; }
  function updateLocal(id: string, values: Partial<CanvasNode>) { onChange({ ...board, nodes: board.nodes.map((node) => node.id === id ? { ...node, ...values } : node) }); }
  async function addNote() { try { await api.createNode(activeProject.id, { type: "note", title: "新笔记", body: "双击或在右侧检查器中编辑。", x: 280, y: 180 }); await onRefresh(); } catch (error) { setStatus(errorText(error)); } }
  function connectSelected() { if (selected.length !== 2) return; const edge: CanvasEdge = { id: `edg_${crypto.randomUUID()}`, source_node_id: selected[0].id, target_node_id: selected[1].id, relation: "context", metadata: {} }; onChange({ ...board, edges: [...board.edges, edge] }); setStatus("已创建节点关系，正在自动保存"); }
  async function createGroup() { if (selected.length < 2) return; const x = Math.min(...selected.map((n) => n.x)) - 40; const y = Math.min(...selected.map((n) => n.y)) - 70; const width = Math.max(...selected.map((n) => n.x + n.width)) - x + 40; const height = Math.max(...selected.map((n) => n.y + n.height)) - y + 40; try { await api.createNode(activeProject.id, { type: "frame", title: "内容分组", body: "", x, y, width, height, metadata: { member_ids: selectedIds } }); await onRefresh(); } catch (error) { setStatus(errorText(error)); } }
  async function runMagic() { if (!magic.trim() || !selectedIds.length) return; setBusy(true); try { const result = await api.magic(activeProject.id, selectedIds, magic, magicType); setStatus(result.message); setMagic(""); await onRefresh(); setSelectedIds(result.nodes.map((node) => node.id)); } catch (error) { setStatus(errorText(error)); } finally { setBusy(false); } }
  async function concept() { if (!selectedIds.length) return; setBusy(true); try { const result = await api.createConcept(activeProject.id, selectedIds); setStatus(result.message); await onRefresh(); setSelectedIds(result.nodes.map((node) => node.id)); } catch (error) { setStatus(errorText(error)); } finally { setBusy(false); } }
  async function removeNode() { if (!primary) return; try { await api.deleteNode(activeProject.id, primary.id); setSelectedIds([]); await onRefresh(); setStatus("节点已删除"); } catch (error) { setStatus(errorText(error)); } }
  const byId = new Map(board.nodes.map((node) => [node.id, node]));
  return <div className="canvas-page"><PageHeader eyebrow="内容白板" title={activeProject.name} description="拖拽布局、连接观点、锁定结论；大模型加工始终生成新节点。" actions={<><button className="secondary" onClick={addNote}>新建笔记</button><button className="secondary" disabled={selected.length !== 2} onClick={connectSelected}>连接两项</button><button className="secondary" disabled={selected.length < 2} onClick={createGroup}>创建分组</button></>} />
    <div className="canvas-workspace"><section className="board-wrap"><div className="board-toolbar"><button onClick={() => setZoom(Math.max(.45, zoom - .1))}>缩小</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(Math.min(1.3, zoom + .1))}>放大</button><span className="autosave">自动保存已开启</span></div><div className="board-scroll" onClick={(e) => { if (e.target === e.currentTarget) setSelectedIds([]); }}><div className="board-size" style={{ width: 2800 * zoom, height: 1900 * zoom }}><div className="board" style={{ transform: `scale(${zoom})` }}>
      <svg className="edge-layer" width="2800" height="1900"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>{board.edges.map((edge) => { const source = byId.get(edge.source_node_id); const target = byId.get(edge.target_node_id); if (!source || !target) return null; return <line key={edge.id} x1={source.x + source.width} y1={source.y + source.height / 2} x2={target.x} y2={target.y + target.height / 2} markerEnd="url(#arrow)" />; })}</svg>
      {[...board.nodes].sort((a, b) => Number(b.type === "frame") - Number(a.type === "frame")).map((node) => <article key={node.id} style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }} onPointerDown={(event) => startDrag(event, node)} className={`canvas-node node-${node.type} ${selectedIds.includes(node.id) ? "selected" : ""} ${node.locked ? "locked" : ""}`}>
        <div className="node-head"><span>{NODE_LABELS[node.type] ?? node.type}</span>{node.locked && <b>已锁定</b>}</div><h3>{node.title}</h3>{node.type !== "frame" && <p>{node.body}</p>}<div className="node-foot"><span>{STATUS_LABELS[node.status] ?? node.status}</span>{(node.metadata.evidence?.length ?? 0) > 0 && <span>{node.metadata.evidence?.length} 条证据</span>}</div>
      </article>)}</div></div></div></section>
      <aside className="inspector">{primary ? <><div className="inspector-title"><div><small>{NODE_LABELS[primary.type] ?? primary.type}</small><h2>节点检查器</h2></div><button className="icon-button danger" onClick={removeNode}>删除</button></div>
        <label>标题<input disabled={primary.locked} value={primary.title} onChange={(e) => updateLocal(primary.id, { title: e.target.value })} /></label><label>正文<textarea disabled={primary.locked} value={primary.body} onChange={(e) => updateLocal(primary.id, { body: e.target.value })} /></label><label>状态<select disabled={primary.locked} value={primary.status} onChange={(e) => updateLocal(primary.id, { status: e.target.value })}><option value="exploring">探索中</option><option value="candidate">候选</option><option value="approved">已批准</option></select></label>
        <label className="switch-row"><span><strong>锁定节点</strong><small>锁定后大模型和自动重跑不能覆盖内容</small></span><input type="checkbox" checked={primary.locked} onChange={(e) => updateLocal(primary.id, { locked: e.target.checked, status: e.target.checked ? "locked" : primary.status === "locked" ? "candidate" : primary.status })} /></label>
        {!!primary.metadata.evidence?.length && <div className="evidence-panel"><h3>证据</h3>{primary.metadata.evidence.map((item, index) => <details key={`${item.chunk_id}-${index}`}><summary>{item.title || item.path}</summary><small>{item.path}｜{item.heading?.join(" › ")}</small><p>{item.excerpt}</p>{item.references?.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}</details>)}</div>}
      </> : <div className="inspector-empty"><strong>{selected.length > 1 ? `已选择 ${selected.length} 个节点` : "选择一个节点"}</strong><p>{selected.length > 1 ? "可以连接、分组、生成内容概念或用智能加工栏处理。" : "在白板中选择节点，可编辑、锁定并查看证据。"}</p></div>}</aside>
    </div>
    {!!selectedIds.length && <div className="magic-bar"><span>已选择 {selectedIds.length} 项</span><select value={magicType} onChange={(e) => setMagicType(e.target.value)}><option value="insight">生成洞察</option><option value="challenge">保存质疑</option><option value="creative_pattern">保存创意模式</option><option value="note">生成笔记</option></select><input value={magic} onChange={(e) => setMagic(e.target.value)} placeholder="例如：找出这些信息里的矛盾，并形成一个核心判断" onKeyDown={(e) => { if (e.key === "Enter") runMagic(); }} /><button className="secondary" disabled={busy} onClick={concept}>形成内容概念</button><button className="primary" disabled={busy || !magic.trim()} onClick={runMagic}>{busy ? "处理中…" : "用大模型加工"}</button></div>}
  </div>;
}

function ContentView({ project, canvas, assets, selectedIds, setSelectedIds, busy, setBusy, setStatus, onDone }: {
  project: Project | null; canvas: CanvasData | null; assets: ContentAsset[]; selectedIds: string[]; setSelectedIds: (ids: string[]) => void;
  busy: boolean; setBusy: (value: boolean) => void; setStatus: (value: string) => void; onDone: () => Promise<void>;
}) {
  const [format, setFormat] = useState<"wechat" | "video_script" | "poster_campaign">("wechat"); const [title, setTitle] = useState(""); const [duration, setDuration] = useState(90); const [useLlm, setUseLlm] = useState(true); const [openAsset, setOpenAsset] = useState<string | null>(assets[0]?.id ?? null);
  if (!project || !canvas) return <><PageHeader eyebrow="内容资产" title="从同一内容概念生成多形态内容" description="微信公众号、视频号和营销活动共享核心观点与证据，但各自采用独立叙事结构。" /><EmptyProject /></>;
  const activeProject = project;
  const eligible = canvas.nodes.filter((node) => node.type !== "frame");
  async function generate() { if (!selectedIds.length) { setStatus("请至少选择一个白板节点或内容概念"); return; } setBusy(true);
    try { const result = await api.generateContent(activeProject.id, selectedIds, format, title, duration, useLlm); setStatus(result.message); setOpenAsset(result.asset.id); await onDone(); }
    catch (error) { setStatus(errorText(error)); } finally { setBusy(false); }
  }
  return <><PageHeader eyebrow="内容资产" title="生成、审阅并导出内容" description="事实内容保留知识库证据；项目导出不包含任何模型接口密钥。" actions={<><a className="button secondary" href={downloadUrl(`/api/projects/${activeProject.id}/export?format=markdown`)}>导出项目（Markdown）</a><a className="button secondary" href={downloadUrl(`/api/projects/${activeProject.id}/export?format=json`)}>导出项目（JSON）</a></>} />
    <div className="content-layout"><section className="card generator"><h2>生成新内容</h2><label>输出形态<select value={format} onChange={(e) => setFormat(e.target.value as typeof format)}><option value="wechat">微信公众号</option><option value="video_script">视频号 / 短视频脚本</option><option value="poster_campaign">海报 / 营销活动</option></select></label><label>标题（可选）<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="留空则自动生成" /></label>{format === "video_script" && <label>视频时长（秒）<input type="number" min="15" max="600" value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></label>}
      <label className="check"><input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} />使用已配置大模型</label><h3>选择内容依据</h3><div className="node-picker">{eligible.map((node) => <label key={node.id}><input type="checkbox" checked={selectedIds.includes(node.id)} onChange={(e) => setSelectedIds(e.target.checked ? [...selectedIds, node.id] : selectedIds.filter((id) => id !== node.id))} /><span><b>{NODE_LABELS[node.type] ?? node.type}</b>{node.title}</span></label>)}</div><button className="primary large" disabled={busy || !selectedIds.length} onClick={generate}>{busy ? "正在生成…" : `生成${FORMAT_LABELS[format]}`}</button></section>
      <section className="asset-list"><div className="section-title"><h2>已生成内容</h2><span>{assets.length} 项</span></div>{assets.length ? assets.map((asset) => <article className={`asset-card ${openAsset === asset.id ? "open" : ""}`} key={asset.id}><button className="asset-summary" onClick={() => setOpenAsset(openAsset === asset.id ? null : asset.id)}><div><span>{FORMAT_LABELS[asset.format] ?? asset.format}</span><h3>{asset.title}</h3><small>版本 {asset.version} · {asset.evidence.length} 条证据</small></div><b>{openAsset === asset.id ? "收起" : "展开"}</b></button>{openAsset === asset.id && <div className="asset-body"><MarkdownText text={asset.body} /><div className="asset-actions"><a className="button primary ghost" href={downloadUrl(`/api/assets/${asset.id}/export`)}>导出（Markdown）</a></div></div>}</article>) : <div className="empty-state"><strong>还没有内容资产</strong><p>选择白板节点后，可生成三种独立叙事形态。</p></div>}</section></div>
  </>;
}

function SettingsView({ sources, setSources, setStatus }: { sources: Source[]; setSources: (sources: Source[]) => void; setStatus: (value: string) => void }) {
  const [providers, setProviders] = useState<Provider[]>([]); const [selectedProvider, setSelectedProvider] = useState(""); const [protect, setProtect] = useState(true); const [sourceName, setSourceName] = useState("本地知识库"); const [sourcePath, setSourcePath] = useState(""); const [busy, setBusy] = useState(false); const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [form, setForm] = useState({ name: "自定义模型", protocol: "openai_compatible", base_url: "", api_key: "", model_name: "", enabled: true, is_external: true, temperature: .3, max_tokens: 3000, timeout_seconds: 60, network_mode: "auto", proxy_url: "", proxy_username: "", proxy_password: "" });
  useEffect(() => { Promise.all([api.listProviders(), api.getSecurity()]).then(([items, security]) => { setProviders(items); setProtect(security.protect_internal_data); if (items[0]) { setSelectedProvider(items[0].id); setFormFromProvider(items[0]); } }).catch((error) => setStatus(errorText(error))); }, []);
  function setFormFromProvider(provider: Provider) { setAvailableModels([]); setForm({ name: provider.name, protocol: provider.protocol, base_url: provider.base_url, api_key: "", model_name: provider.model_name, enabled: provider.enabled, is_external: provider.is_external, temperature: provider.temperature, max_tokens: provider.max_tokens, timeout_seconds: provider.timeout_seconds, network_mode: typeof provider.extra.network_mode === "string" ? provider.extra.network_mode : "auto", proxy_url: typeof provider.extra.proxy_url === "string" ? provider.extra.proxy_url : "", proxy_username: typeof provider.extra.proxy_username === "string" ? provider.extra.proxy_username : "", proxy_password: "" }); }
  function applyProviderPreset(key: keyof typeof PROVIDER_PRESETS) { const preset = PROVIDER_PRESETS[key]; setSelectedProvider(""); setAvailableModels([]); setForm({ ...form, ...preset, protocol: "openai_compatible", api_key: "", enabled: true, is_external: true }); }
  async function saveProvider(event: FormEvent) { event.preventDefault(); setBusy(true); try { const { network_mode, proxy_url, proxy_username, proxy_password, ...providerForm } = form; const saved = await api.saveProvider({ ...(selectedProvider ? { id: selectedProvider } : {}), ...providerForm, api_key: form.api_key || null, extra: { network_mode, proxy_url: proxy_url || null, proxy_username: proxy_username || null, proxy_password: proxy_password || null } }); const items = await api.listProviders(); setProviders(items); setSelectedProvider(saved.id); setFormFromProvider(saved); setStatus("大模型与企业代理配置已保存，密钥和代理密码未写入普通数据库"); } catch (error) { setStatus(errorText(error)); } finally { setBusy(false); } }
  async function testProvider() { if (!selectedProvider) return; setBusy(true); setStatus("正在执行最小真实模型调用…"); try { const result = await api.testProvider(selectedProvider); setStatus(String(result.message ?? "连接测试完成")); } catch (error) { setStatus(errorText(error)); } finally { setBusy(false); } }
  async function discoverModels() { if (!form.base_url) return; setBusy(true); setStatus("正在从供应商获取模型列表…"); try { const result = await api.discoverModels({ ...(selectedProvider ? { provider_id: selectedProvider } : {}), base_url: form.base_url, api_key: form.api_key || null, timeout_seconds: form.timeout_seconds, network_mode: form.network_mode, proxy_url: form.proxy_url || null, proxy_username: form.proxy_username || null, proxy_password: form.proxy_password || null }); setAvailableModels(result.models); if (result.models.length && !result.models.includes(form.model_name)) setForm((current) => ({ ...current, model_name: result.models[0] })); setStatus(result.message); } catch (error) { setStatus(errorText(error)); } finally { setBusy(false); } }
  async function addSource(event: FormEvent) { event.preventDefault(); setBusy(true); try { const source = await api.createSource(sourceName, sourcePath); const items = await api.listSources(); setSources(items); setSourcePath(""); setStatus(`知识源“${source.name}”已添加，请刷新索引`); } catch (error) { setStatus(errorText(error)); } finally { setBusy(false); } }
  async function refreshSource(id: string) { setBusy(true); setStatus("正在扫描并增量更新知识库索引…"); try { const report = await api.refresh(id); setStatus(`索引完成：扫描 ${report.discovered ?? 0} 个文件，写入 ${report.chunks_written ?? 0} 个分块`); } catch (error) { setStatus(errorText(error)); } finally { setBusy(false); } }
  async function saveProtect(value: boolean) { setProtect(value); try { await api.saveSecurity(value); setStatus(value ? "内部数据保护已开启" : "内部数据保护已关闭，请确认模型服务的数据边界"); } catch (error) { setStatus(errorText(error)); } }
  return <><PageHeader eyebrow="设置" title="知识源、大模型与数据边界" description="支持任意 OpenAI 兼容模型服务；未配置模型时，核心流程仍可使用本地模板运行。" />
    <div className="settings-grid"><section className="card settings-card"><div className="section-title"><h2>本地知识源</h2><span>只读，不修改源文件</span></div><form onSubmit={addSource}><label>知识源名称<input value={sourceName} onChange={(e) => setSourceName(e.target.value)} /></label><label>本地知识库文件夹路径<input value={sourcePath} onChange={(e) => setSourcePath(e.target.value)} placeholder="例如 D:\\Knowledge\\wiki" /></label><button className="primary" disabled={busy || !sourcePath.trim()}>添加知识源</button></form><div className="source-list">{sources.map((source) => <div key={source.id}><div><strong>{source.name}</strong><small>{source.root_path}</small></div><button className="secondary" disabled={busy} onClick={() => refreshSource(source.id)}>刷新索引</button></div>)}</div></section>
      <section className="card settings-card">
        <div className="section-title"><h2>自定义大模型</h2><button className="text-button" onClick={() => applyProviderPreset("custom")}>新建配置</button></div>
        <div className="provider-presets"><button type="button" onClick={() => applyProviderPreset("deepseek")}><strong>DeepSeek</strong><small>官方 OpenAI 兼容接口</small></button><button type="button" onClick={() => applyProviderPreset("aihubmix")}><strong>AIHubMix</strong><small>聚合模型供应商</small></button><button type="button" onClick={() => applyProviderPreset("custom")}><strong>其他供应商</strong><small>任意兼容接口</small></button></div>
        {providers.length > 0 && <label>已保存配置<select value={selectedProvider} onChange={(e) => { setSelectedProvider(e.target.value); const provider = providers.find((item) => item.id === e.target.value); if (provider) setFormFromProvider(provider); }}><option value="">新建配置</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model_name}</option>)}</select></label>}
        <form onSubmit={saveProvider} className="provider-form">
          <label>配置名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>接口协议<select value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })}><option value="openai_compatible">OpenAI 兼容接口</option><option value="custom">自定义兼容接口</option></select></label>
          <label>接口基础地址<input value={form.base_url} onChange={(e) => { setAvailableModels([]); setForm({ ...form, base_url: e.target.value }); }} placeholder="例如 https://api.deepseek.com 或 https://aihubmix.com/v1" /></label>
          <label>接口密钥<input type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder={selectedProvider ? "留空则使用已保存密钥" : "输入供应商 API Key"} /></label>
          <div className="network-settings"><label>网络连接方式<select value={form.network_mode} onChange={(e) => setForm({ ...form, network_mode: e.target.value })}><option value="auto">自动检测（推荐）</option><option value="direct">直接连接</option><option value="system_proxy">Windows 系统代理</option><option value="custom_proxy">企业代理手动设置</option></select></label>{form.network_mode === "custom_proxy" && <div className="proxy-fields"><label>企业代理地址<input value={form.proxy_url} onChange={(e) => setForm({ ...form, proxy_url: e.target.value })} placeholder="例如 http://proxy.company.com:8080" /></label><label>代理用户名（可选）<input value={form.proxy_username} onChange={(e) => setForm({ ...form, proxy_username: e.target.value })} placeholder="域账号或代理账号" /></label><label>代理密码（可选）<input type="password" value={form.proxy_password} onChange={(e) => setForm({ ...form, proxy_password: e.target.value })} placeholder={selectedProvider ? "留空则使用已保存密码" : "输入代理密码"} /></label></div>}<p>自动模式会优先使用有效的 Windows 系统代理，失败后再尝试直连；企业代理支持地址及账号密码，并使用 Windows 系统证书库验证 HTTPS。</p></div>
          <div className="model-discovery"><label>模型名称<input list="provider-model-options" value={form.model_name} onChange={(e) => setForm({ ...form, model_name: e.target.value })} placeholder="可手动输入，或点击右侧获取模型" /><datalist id="provider-model-options">{availableModels.map((model) => <option key={model} value={model} />)}</datalist></label><button type="button" className="secondary" disabled={busy || !form.base_url || (!form.api_key && !selectedProvider)} onClick={discoverModels}>{busy ? "获取中…" : "刷新模型"}</button></div>
          {!!availableModels.length && <div className="model-chips">{availableModels.slice(0, 24).map((model) => <button type="button" key={model} className={form.model_name === model ? "active" : ""} onClick={() => setForm({ ...form, model_name: model })}>{model}</button>)}</div>}
          <div className="config-grid"><label>温度<input type="number" min="0" max="2" step="0.1" value={form.temperature} onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })} /></label><label>最大输出<input type="number" min="128" value={form.max_tokens} onChange={(e) => setForm({ ...form, max_tokens: Number(e.target.value) })} /></label><label>超时秒数<input type="number" min="5" max="300" value={form.timeout_seconds} onChange={(e) => setForm({ ...form, timeout_seconds: Number(e.target.value) })} /></label></div>
          <label className="check"><input type="checkbox" checked={form.is_external} onChange={(e) => setForm({ ...form, is_external: e.target.checked })} />这是外部模型服务</label>
          <div className="form-actions"><button className="primary" disabled={busy || !form.base_url || !form.model_name}>保存配置</button><button type="button" className="secondary" disabled={busy || !selectedProvider} onClick={testProvider}>测试连接</button></div>
        </form>
      </section>
      <section className="card settings-card security-card"><div><h2>内部数据保护</h2><p>开启时，内部知识库、研究发现和白板内容不会发送给标记为“外部”的模型。系统会自动降级为本地模板。</p></div><label className="big-switch"><input type="checkbox" checked={protect} onChange={(e) => saveProtect(e.target.checked)} /><span>{protect ? "已开启" : "已关闭"}</span></label></section>
    </div></>;
}
