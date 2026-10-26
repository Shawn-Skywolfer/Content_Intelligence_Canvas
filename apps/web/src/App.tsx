import { Component, ErrorInfo, FormEvent, PointerEvent as ReactPointerEvent, ReactNode, useEffect, useRef, useState } from "react";
import MarkdownContent from "./MarkdownContent";
import { cleanSourcePath } from "./sourcePath";
import CanvasView from "./CanvasView";
import AssetView from "./AssetView";
import GlobalNetworkSettings from "./GlobalNetworkSettings";
import DeepSeekWebSettings from "./DeepSeekWebSettings";
import {
  api, CanvasData, CanvasEdge, CanvasNode, ContentAsset, ContentFormat,
  Project, Provider, ResearchJob, ResearchRun, Source, McpSearchConfig, RefreshJob,
} from "./api";

type View = "home" | "research" | "canvas" | "content" | "settings";

const NAV: Array<{ id: View; label: string; icon: string }> = [
  { id: "home", label: "项目", icon: "项" },
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
const PROVIDER_PRESETS = {
  deepseek: { name: "DeepSeek", base_url: "https://api.deepseek.com", model_name: "deepseek-flash" },
  aihubmix: { name: "AIHubMix", base_url: "https://aihubmix.com/v1", model_name: "" },
  custom: { name: "自定义模型", base_url: "", model_name: "" },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}

function normalizeCanvas(data: CanvasData): CanvasData {
  return {
    ...data,
    viewport: data.viewport && Number.isFinite(data.viewport.zoom) ? data.viewport : { x: 0, y: 0, zoom: 1 },
    nodes: (data.nodes ?? []).map((node, index) => ({
      ...node,
      title: node.title || "未命名节点",
      body: node.body || "",
      status: node.status || "exploring",
      locked: Boolean(node.locked),
      x: Number.isFinite(node.x) ? node.x : 120 + index * 30,
      y: Number.isFinite(node.y) ? node.y : 120 + index * 30,
      width: Number.isFinite(node.width) && node.width > 100 ? node.width : 360,
      height: Number.isFinite(node.height) && node.height > 80 ? node.height : 220,
      metadata: node.metadata && typeof node.metadata === "object" ? node.metadata : {},
    })),
    edges: (data.edges ?? []).filter((edge) => edge?.id && edge?.source_node_id && edge?.target_node_id).map((edge) => ({ ...edge, metadata: edge.metadata ?? {} })),
  };
}

class CanvasErrorBoundary extends Component<{ children: ReactNode; onRetry: () => Promise<void> }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) { return { error: error.message || "白板渲染异常" }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("白板渲染失败", error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="canvas-recovery"><strong>白板加载失败</strong><p>{this.state.error}</p><button className="primary" onClick={async () => { try { await this.props.onRetry(); this.setState({ error: "" }); } catch (error) { this.setState({ error: errorText(error) }); } }}>重新读取白板</button></div>;
  }
}

function MarkdownText({ text }: { text: string }) {
  return <MarkdownContent>{text}</MarkdownContent>;
}

export default function App() {
  const [view, setView] = useState<View>("home");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { const saved = window.localStorage.getItem("cic.sidebar.collapsed"); return saved === null ? window.innerWidth <= 930 : saved === "true"; }
    catch { return false; }
  });
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [canvas, setCanvas] = useState<CanvasData | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [assets, setAssets] = useState<ContentAsset[]>([]);
  const [status, setStatus] = useState("正在连接本地工作台…");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [canvasError, setCanvasError] = useState("");
  const saveSequence = useRef(0);
  const saveInFlight = useRef<Promise<CanvasData> | null>(null);

  const activeProject = projects.find((item) => item.id === projectId) ?? null;
  useEffect(() => { try { window.localStorage.setItem("cic.sidebar.collapsed", String(sidebarCollapsed)); } catch { /* 私密窗口仍可折叠 */ } }, [sidebarCollapsed]);

  useEffect(() => {
    Promise.all([api.health(), api.listProjects(), api.listSources()])
      .then(([, projectItems, sourceItems]) => {
        setProjects(projectItems);
        setSources(sourceItems);
        const active = projectItems.find((item) => item.status !== "archived");
        if (active) setProjectId(active.id);
        setStatus("工作台已就绪");
      })
      .catch((error) => setStatus(`无法连接后端：${errorText(error)}`));
  }, []);

  useEffect(() => {
    if (!projectId) { setCanvas(null); setAssets([]); return; }
    if (view !== "canvas" && view !== "content") return;
    if (canvas?.project_id === projectId && !canvasError) return;
    let active = true;
    setCanvasError("");
    Promise.all([api.getCanvas(projectId), api.listAssets(projectId)])
      .then(([canvasData, assetItems]) => { if (active) { setCanvas(normalizeCanvas(canvasData)); setAssets(assetItems); setSelectedIds([]); setCanvasError(""); } })
      .catch((error) => { if (active) { setCanvasError(errorText(error)); setStatus(`白板加载失败：${errorText(error)}`); } });
    return () => { active = false; };
  }, [projectId, view]);

  useEffect(() => {
    if (!dirty || !canvas || !projectId) return;
    const sequence = ++saveSequence.current;
    const timer = window.setTimeout(() => {
      const pending = api.saveCanvas(projectId, canvas);
      saveInFlight.current = pending;
      pending.then((saved) => {
        if (sequence === saveSequence.current) { setCanvas(normalizeCanvas(saved)); setDirty(false); setStatus("白板已自动保存"); }
      }).catch((error) => setStatus(`自动保存失败：${errorText(error)}`))
        .finally(() => { if (saveInFlight.current === pending) saveInFlight.current = null; });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [canvas, dirty, projectId]);

  function changeCanvas(next: CanvasData) { setCanvas(next); setDirty(true); }

  async function flushCanvas() {
    ++saveSequence.current;
    if (saveInFlight.current) await saveInFlight.current;
    if (dirty && canvas && canvas.project_id === projectId) {
      await api.saveCanvas(projectId, canvas);
      setDirty(false);
    }
  }

  async function refreshCanvas(skipPendingSave = false) {
    if (!projectId) return;
    ++saveSequence.current;
    if (!skipPendingSave) await flushCanvas();
    const [canvasData, assetItems] = await Promise.all([api.getCanvas(projectId), api.listAssets(projectId)]);
    setCanvas(normalizeCanvas(canvasData)); setAssets(assetItems); setDirty(false); setCanvasError("");
  }

  async function openCanvas(id: string) {
    if (id !== projectId) {
      try { await flushCanvas(); } catch (error) { setStatus(`切换项目前保存失败：${errorText(error)}`); return; }
      ++saveSequence.current; setCanvas(null); setAssets([]); setSelectedIds([]); setProjectId(id);
    }
    setView("canvas");
    if (id === projectId && canvasError) {
      try { await refreshCanvas(); } catch (error) { setCanvasError(errorText(error)); setStatus(`白板加载失败：${errorText(error)}`); }
    }
  }

  async function switchProject(id: string) {
    if (id === projectId) return;
    try { await flushCanvas(); ++saveSequence.current; setCanvas(null); setAssets([]); setSelectedIds([]); setProjectId(id); }
    catch (error) { setStatus(`切换项目前保存失败：${errorText(error)}`); }
  }

  async function openResearch() {
    try { await flushCanvas(); setProjects(await api.listProjects()); setView("research"); }
    catch (error) { setStatus(`打开快速研究失败：${errorText(error)}`); }
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

  async function archiveProject(project: Project) {
    try {
      if (project.id === projectId) await flushCanvas();
      const updated = await api.updateProject(project.id, { status: project.status === "archived" ? "active" : "archived" });
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      if (project.id === projectId && updated.status === "archived") { setProjectId(projects.find((item) => item.id !== project.id && item.status !== "archived")?.id ?? ""); setCanvas(null); setSelectedIds([]); setAssets([]); }
      setStatus(updated.status === "archived" ? `项目“${project.name}”已归档` : `项目“${project.name}”已恢复`);
    } catch (error) { setStatus(errorText(error)); }
  }

  async function deleteProject(project: Project) {
    if (!window.confirm(`确定永久删除项目“${project.name}”及其研究、白板和内容资产吗？此操作不能撤销。建议先导出项目备份。`)) return;
    try {
      ++saveSequence.current;
      if (saveInFlight.current) await saveInFlight.current;
      await api.deleteProject(project.id);
      const remaining = projects.filter((item) => item.id !== project.id);
      setProjects(remaining);
      if (project.id === projectId) { setProjectId(remaining.find((item) => item.status !== "archived")?.id ?? ""); setCanvas(null); setSelectedIds([]); setAssets([]); setDirty(false); }
      setStatus(`项目“${project.name}”已删除`);
    } catch (error) { setStatus(errorText(error)); }
  }

  const content = (() => {
    if (view === "home") return <HomeView projects={projects} activeId={projectId} busy={busy} onCreate={createProject} onOpen={openCanvas} onArchive={archiveProject} onDelete={deleteProject} />;
    if (view === "research") return <ResearchView sources={sources} project={activeProject} busy={busy} setBusy={setBusy} setStatus={setStatus} beforeRun={flushCanvas} onProjectChanged={(updated) => { setProjects((current) => current.map((item) => item.id === updated.id ? updated : item)); setCanvas(null); setDirty(false); }} onDone={async (nodeIds) => { await flushCanvas(); await refreshCanvas(true); setSelectedIds(nodeIds); setView("canvas"); }} />;
    if (view === "canvas") return canvasError ? <div className="canvas-recovery"><strong>白板加载失败</strong><p>{canvasError}</p><button className="primary" onClick={() => { void refreshCanvas().catch((error) => setCanvasError(errorText(error))); }}>重新读取白板</button></div> : <CanvasErrorBoundary key={projectId} onRetry={refreshCanvas}><CanvasView project={activeProject} canvas={canvas} selectedIds={selectedIds} setSelectedIds={setSelectedIds} onChange={changeCanvas} onRefresh={refreshCanvas} beforeGenerate={flushCanvas} setStatus={setStatus} /></CanvasErrorBoundary>;
    if (view === "content") return <AssetView project={activeProject} assets={assets} onChanged={() => refreshCanvas(true)} onOpenNode={(id) => { setSelectedIds([id]); void openCanvas(projectId); }} setStatus={setStatus} />;
    return <SettingsView sources={sources} setSources={setSources} setStatus={setStatus} />;
  })();

  return <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
    <aside className="sidebar" id="global-sidebar">
      <div className="sidebar-tools"><button type="button" className="sidebar-toggle" aria-label={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"} title={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed((value) => !value)}><span aria-hidden="true">{sidebarCollapsed ? "»" : "«"}</span></button></div>
      <div className="brand"><span className="brand-mark">智</span><div><strong>内容智能工作台</strong><small>可信知识驱动的内容工作台</small></div></div>
      <nav aria-label="主要导航">{NAV.map((item) => <button aria-label={item.label} title={sidebarCollapsed ? item.label : undefined} className={view === item.id ? "active" : ""} key={item.id} onClick={() => item.id === "research" ? void openResearch() : item.id === "canvas" && projectId ? openCanvas(projectId) : item.id === "content" ? void flushCanvas().then(() => setView(item.id)).catch((error) => setStatus(errorText(error))) : setView(item.id)}>
        <span aria-hidden="true">{item.icon}</span><b>{item.label}</b>
      </button>)}</nav>
      <div className="sidebar-project">
        <label>当前项目</label>
        <select value={projectId} onChange={(event) => { void switchProject(event.target.value); }}>
          <option value="">尚未选择</option>
          {projects.filter((project) => project.status !== "archived").map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
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

function HomeView({ projects, activeId, busy, onCreate, onOpen, onArchive, onDelete }: {
  projects: Project[]; activeId: string; busy: boolean;
  onCreate: (idea: string, name: string, brief: string) => void; onOpen: (id: string) => void;
  onArchive: (project: Project) => void; onDelete: (project: Project) => void;
}) {
  const [idea, setIdea] = useState(""); const [name, setName] = useState(""); const [brief, setBrief] = useState("");
  return <>
    <PageHeader eyebrow="项目入口" title="今天想探索什么内容？" description="从一句粗想法开始，内部知识库会成为后续研究、白板共创和内容输出的证据底座。" />
    <section className="hero-create card">
      <textarea value={idea} onChange={(event) => setIdea(event.target.value)} placeholder="例如：人工智能数据中心的电力问题，正在带来哪些新的内容机会？" />
      <div className="create-details"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="项目名称（可选）" /><input value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="受众、目标或限制条件（可选）" /></div>
      <button className="primary large" disabled={busy || idea.trim().length < 2} onClick={() => onCreate(idea, name, brief)}>创建项目并开始探索</button>
    </section>
    <section className="section-block"><div className="section-title"><h2>最近项目</h2><span>{projects.filter((item) => item.status !== "archived").length} 个进行中 · {projects.filter((item) => item.status === "archived").length} 个已归档</span></div>
      <div className="project-grid">{projects.filter((item) => item.status !== "archived").map((project) => <article className={`project-card ${activeId === project.id ? "current" : ""}`} key={project.id}>
        <button className="project-card-main" onClick={() => onOpen(project.id)}><span className="project-state">进行中</span><h3>{project.name}</h3><p>{project.idea}</p><small>更新于 {new Date(project.updated_at).toLocaleString("zh-CN")}</small></button>
        <div className="project-card-actions"><button className="secondary" onClick={() => onArchive(project)}>归档</button><button className="text-button danger" onClick={() => onDelete(project)}>删除</button></div>
      </article>)}{!projects.length && <div className="empty-state"><strong>还没有项目</strong><p>上方输入一句想法即可创建。</p></div>}</div>
      {projects.some((item) => item.status === "archived") && <details className="archived-projects"><summary>已归档项目（{projects.filter((item) => item.status === "archived").length}）</summary><div className="project-grid">{projects.filter((item) => item.status === "archived").map((project) => <article className="project-card" key={project.id}><span className="project-state">已归档</span><h3>{project.name}</h3><p>{project.idea}</p><div className="project-card-actions"><button className="secondary" onClick={() => onArchive(project)}>恢复项目</button><button className="text-button danger" onClick={() => onDelete(project)}>删除</button></div></article>)}</div></details>}
    </section>
  </>;
}

function ResearchView({ sources, project, busy, setBusy, setStatus, beforeRun, onProjectChanged, onDone }: { sources: Source[]; project: Project | null; busy: boolean; setBusy: (value: boolean) => void; setStatus: (value: string) => void; beforeRun: () => Promise<void>; onProjectChanged: (project: Project) => void; onDone: (nodeIds: string[]) => Promise<void> }) {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? ""); const [query, setQuery] = useState(project?.idea ?? ""); const [count, setCount] = useState("20");
  const [brief, setBrief] = useState(project?.brief ?? "");
  const [savingBrief, setSavingBrief] = useState(false);
  const [briefMessage, setBriefMessage] = useState("");
  const [job, setJob] = useState<ResearchJob | null>(null);
  const [history, setHistory] = useState<ResearchRun[]>([]);
  useEffect(() => { if (!sourceId && sources[0]) setSourceId(sources[0].id); }, [sourceId, sources]);
  useEffect(() => { if (project) { setQuery(project.idea); setBrief(project.brief); setBriefMessage(""); } }, [project?.id]);
  useEffect(() => {
    if (!project?.id) { setHistory([]); return; }
    let active = true;
    api.listRuns(project.id).then((runs) => {
      if (active) setHistory(runs.filter((run) => run.action === "quick_research"));
    }).catch((error) => { if (active) setStatus(`读取研究历史失败：${errorText(error)}`); });
    return () => { active = false; };
  }, [project?.id, setStatus]);
  if (!project) return <><PageHeader eyebrow="快速研究" title="只基于内部知识库形成研究发现" description="默认不联网，事实、信号、内部知识和洞察会分层进入白板。" /><EmptyProject /></>;
  const activeProject = project;
  async function persistBrief(flush = true) {
    if (flush) await beforeRun();
    const text = brief.trim();
    if (text !== activeProject.brief) {
      const updated = await api.updateProject(activeProject.id, { brief: text });
      onProjectChanged(updated); setBrief(updated.brief);
    }
    setBriefMessage(text ? "简报已保存并同步到白板，研究将使用这些创作要求" : "简报留空，将直接围绕研究问题展开");
  }
  async function saveBrief() {
    setSavingBrief(true); setBriefMessage("正在保存简报…");
    try { await persistBrief(); } catch (error) { setBriefMessage(`简报保存失败：${errorText(error)}`); }
    finally { setSavingBrief(false); }
  }
  async function deleteHistory(item: ResearchRun) {
    if (!window.confirm("仅删除这条研究历史记录？已生成的白板节点和证据会保留。")) return;
    try { await api.deleteResearchRun(activeProject.id, item.id); setHistory((current) => current.filter((run) => run.id !== item.id)); setStatus("已删除研究记录，白板节点保留"); }
    catch (error) { setStatus(`删除研究记录失败：${errorText(error)}`); }
  }
  async function run() { if (!sourceId || !query.trim()) return; setBusy(true); setStatus("研究任务已启动，可在进度框查看当前阶段");
    try {
      if (!count.trim() || !Number.isInteger(Number(count)) || Number(count) < 3 || Number(count) > 20) throw new Error("研究发现数量请输入 3–20 的整数");
      await beforeRun();
      await persistBrief(false);
      let current = await api.startQuickResearch(activeProject.id, sourceId, query, Number(count), true);
      setJob(current);
      while (current.status === "running") {
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        current = await api.researchJob(current.job_id);
        setJob(current);
      }
      if (current.status === "failed") throw new Error(current.error || current.detail || "研究任务失败");
      setStatus(current.result?.message || "研究完成");
      api.listRuns(activeProject.id)
        .then((runs) => setHistory(runs.filter((item) => item.action === "quick_research")))
        .catch((error) => setStatus(`读取研究历史失败：${errorText(error)}`));
      await onDone(current.result?.nodes.map((node) => node.id) ?? []);
    }
    catch (error) { setStatus(errorText(error)); } finally { setBusy(false); }
  }
  return <><PageHeader eyebrow="快速研究" title="从问题到研究发现与创意方向" description="模型先理解 Wiki，再生成最多 20 条有据可查的研究发现，以及三条内容方向。" />
    <section className="research-layout"><div className="card research-form"><div className="field"><label>研究问题</label><textarea value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <div className="research-brief"><div className="section-title"><h3>内容简报</h3><button type="button" className="text-button" disabled={busy || savingBrief || !!brief.trim()} onClick={() => setBrief("目标受众：\n传播目标：\n输出形式：\n核心关注：\n语气与限制：")}>插入简报模板</button></div><label>受众、目标与创作要求（可选）<textarea value={brief} maxLength={5000} rows={6} disabled={busy || savingBrief} onChange={(event) => { setBrief(event.target.value); setBriefMessage("简报有修改，开始研究时会自动保存，也可单独保存"); }} placeholder={"例如：面向 AIDC 客户的技术决策者，形成公众号文章。重点比较供电可靠性与 TCO，语气客观，所有数据注明来源。"} /></label><p>保存后会显示在白板「01 输入与简报」的「内容简报」节点；开始研究时自动保存，并作为研究与后续内容创作的要求。</p><button type="button" className="secondary" disabled={busy || savingBrief} onClick={saveBrief}>{savingBrief ? "正在保存…" : "保存简报"}</button>{briefMessage && <p role="status" className="brief-feedback">{briefMessage}</p>}</div>
      <div className="field"><label>内部知识源</label><select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>{sources.map((source) => <option value={source.id} key={source.id}>{source.name}</option>)}</select></div>
      <div className="inline-fields"><label>研究发现数量<input type="number" min="3" max="20" aria-describedby="research-count-hint" value={count} onChange={(e) => setCount(e.target.value)} /></label><span id="research-count-hint">可填 3–20 条，默认 20 条。数量越多，研究耗时越长；证据不足时会少于目标数量，不凑数。另生成三条内容方向。</span></div>
      <button className="primary large" disabled={busy || savingBrief || !sourceId || !query.trim() || !count.trim() || !Number.isInteger(Number(count)) || Number(count) < 3 || Number(count) > 20} onClick={run}>{busy ? "正在研究…" : "开始快速研究"}</button>
      {job && <div className={`research-progress ${job.status}`} aria-live="polite"><div className="progress-heading"><div><small>{job.status === "failed" ? "任务失败" : job.status === "completed" ? "任务完成" : "实时研究进度"}</small><strong>{job.phase}</strong></div><b>{Math.round(job.progress)}%</b></div><div className="progress-track"><i style={{ width: `${Math.max(2, job.progress)}%` }} /></div><p>{job.detail}</p></div>}</div>
      <div className="research-notes"><div><span>01</span><h3>内部优先</h3><p>快速模式只读取已启用知识库，不主动联网。</p></div><div><span>02</span><h3>保留证据</h3><p>每条研究发现都保存文件、标题层级、段落与参考来源。</p></div><div><span>03</span><h3>进入白板</h3><p>生成新节点与关联边，不覆盖已有思考。</p></div></div>
    </section>
    <section className="research-history" aria-label="历史研究"><div className="section-title"><h2>历史研究</h2><span>当前项目 · {history.length} 次</span></div>
      {history.length ? <div className="research-history-list">{history.map((item) => <article className="research-history-item" key={item.id}>
        <div className="research-history-main"><div className="research-history-meta"><span className={`run-status ${item.status}`}>{item.status === "completed" ? "已完成" : item.status === "failed" ? "失败" : "进行中"}</span><time dateTime={item.created_at}>{new Date(item.completed_at || item.created_at).toLocaleString("zh-CN")}</time></div>
          <h3>{item.prompt || "未命名研究"}</h3><p>{item.status === "failed" ? item.error || "研究失败" : `已生成 ${item.output_node_ids?.length ?? 0} 个白板节点${item.model_name ? ` · ${item.model_name}` : ""}`}</p></div>
        <div className="research-history-actions"><button className="secondary" disabled={item.status !== "completed" || !item.output_node_ids?.length} onClick={() => onDone(item.output_node_ids)}>查看白板节点</button><button className="secondary danger" disabled={item.status === "running"} onClick={() => deleteHistory(item)}>删除记录</button></div>
      </article>)}</div> : <div className="empty-state"><strong>还没有历史研究</strong><p>完成一次快速研究后，可在这里返回查看生成的白板节点。</p></div>}
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

function SettingsView({ sources, setSources, setStatus }: { sources: Source[]; setSources: (sources: Source[]) => void; setStatus: (value: string) => void }) {
  const [tab, setTab] = useState<"sources" | "models" | "mcp" | "formats" | "security" | "network">("sources");
  const [mcpRevision, setMcpRevision] = useState(0);
  const [mcp, setMcp] = useState<McpSearchConfig>({ name: "Tavily", url: "https://mcp.tavily.com/mcp/", tool_name: "tavily_search", enabled: false, has_api_key: false, api_key: "", network_mode: "inherit", proxy_url: "", proxy_username: "", has_proxy_password: false });
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpActivity, setMcpActivity] = useState<{ phase: string; started: number; error?: string; result?: Record<string, unknown> } | null>(null);
  const [modelActivity, writeModelActivity] = useState<{ phase: string; started: number; finished?: number; error?: string; result?: Record<string, unknown> } | null>(null);
  function setModelActivity(value: { phase: string; started: number; error?: string; result?: Record<string, unknown> } | null) { writeModelActivity(value ? { ...value, ...((value.error || value.result) ? { finished: Date.now() } : {}) } : null); }
  const [providerTestJobId, setProviderTestJobId] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [settingsImportRevision, setSettingsImportRevision] = useState(0);
  const [quotaResult, setQuotaResult] = useState("");
  const [refreshJobs, setRefreshJobs] = useState<Record<string, RefreshJob>>({});
  const [sourceMessage, setSourceMessage] = useState("");
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelFilter, setModelFilter] = useState("");
  const [, setTick] = useState(0);
  const [providers, setProviders] = useState<Provider[]>([]); const [selectedProvider, setSelectedProvider] = useState(""); const [protect, setProtect] = useState(true); const [sourceName, setSourceName] = useState("本地知识库"); const [sourcePath, setSourcePath] = useState(""); const [busy, setBusy] = useState(false); const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [formats, setFormats] = useState<ContentFormat[]>([]);
  const [form, setForm] = useState({ name: "自定义模型", protocol: "openai_compatible", base_url: "", api_key: "", model_name: "", enabled: true, is_external: true, temperature: .3, max_tokens: "3000", timeout_seconds: 60, network_mode: "inherit", proxy_url: "", proxy_username: "", proxy_password: "", stream_output: false, reasoning_mode: "off", reasoning_effort: "medium", test_model: "", test_timeout_seconds: 15, test_max_tokens: 256, quota_url: "", quota_json_path: "", quota_unit: "" });
  useEffect(() => { Promise.all([api.listProviders(), api.getSecurity(), api.activeProvider()]).then(([items, security, active]) => { setProviders(items); setProtect(security.protect_internal_data); setActiveProviderId(active.provider_id); const first = items.find((item) => item.id === active.provider_id) ?? items[0]; if (first) { setSelectedProvider(first.id); setFormFromProvider(first); } }).catch((error) => setModelActivity({ phase: "加载配置失败", started: Date.now(), error: errorText(error) })); }, []);
  useEffect(() => { const timer = setInterval(() => setTick((value) => value + 1), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { let alive = true; Promise.all(sources.map((source) => api.latestRefresh(source.id).then((job) => [source.id, job] as const).catch(() => [source.id, null] as const))).then((items) => { if (alive) { const found: Record<string, RefreshJob> = {}; for (const [id, job] of items) if (job) found[id] = job; setRefreshJobs((current) => ({ ...current, ...found })); } }); return () => { alive = false; }; }, [sources]);
  const runningRefreshIds = Object.values(refreshJobs).filter((job) => job.status === "running").map((job) => job.job_id).join("|");
  useEffect(() => { if (!runningRefreshIds) return; let alive = true; const poll = () => { runningRefreshIds.split("|").forEach((id) => { api.getRefreshJob(id).then((job) => { if (alive) setRefreshJobs((current) => ({ ...current, [job.source_id]: job })); }).catch((error) => { if (alive) setSourceMessage(`读取刷新进度失败：${errorText(error)}`); }); }); }; const timer = setInterval(poll, 700); return () => { alive = false; clearInterval(timer); }; }, [runningRefreshIds]);
  useEffect(() => { api.listContentFormats().then(setFormats).catch((error) => setStatus(errorText(error))); }, []);
  useEffect(() => { api.getMcpSearch().then(setMcp).catch((error) => setStatus(errorText(error))); }, []);
  useEffect(() => { if (!providerTestJobId) return; let alive = true; const poll = async () => { try { const job = await api.providerTestJob(providerTestJobId); if (!alive) return; setModelActivity({ phase: job.phase, started: job.started_at ? Number(job.started_at) * 1000 : Date.now() - job.elapsed_seconds * 1000, result: job.result ?? undefined }); if (job.status === "completed") { setProviderTestJobId(null); setBusy(false); } } catch (error) { if (alive) { setModelActivity({ phase: "测试进度读取失败", started: Date.now(), error: errorText(error) }); setProviderTestJobId(null); setBusy(false); } } }; void poll(); const timer = setInterval(poll, 800); return () => { alive = false; clearInterval(timer); }; }, [providerTestJobId]);
  async function saveMcp() { setMcpBusy(true); const started = Date.now(); setMcpActivity({ phase: "正在保存搜索服务配置", started }); try { setMcp(await api.saveMcpSearch(mcp)); setMcpRevision((value) => value + 1); setMcpActivity({ phase: "配置已保存", started, result: { message: "可点击测试连接与工具列表" } }); } catch (error) { setMcpActivity({ phase: "保存失败", started, error: errorText(error) }); } finally { setMcpBusy(false); } }
  async function testMcp() { setMcpBusy(true); const started = Date.now(); setMcpActivity({ phase: "正在连接 MCP 并读取工具列表", started }); try { const result = await api.testMcpSearch(); setMcpActivity({ phase: result.search_tool_available ? "连接及工具验证成功" : "连接成功，但搜索工具不可用", started, result }); } catch (error) { setMcpActivity({ phase: "连接失败", started, error: errorText(error) }); } finally { setMcpBusy(false); } }
  function changeFormat(id: string, values: Partial<ContentFormat>) { setFormats((current) => current.map((item) => item.id === id ? { ...item, ...values } : item)); }
  async function saveFormats() { setBusy(true); try { setFormats(await api.saveContentFormats(formats)); setStatus("输出形态与 Prompt 已保存，后续生成将使用新配置"); } catch (error) { setStatus(errorText(error)); } finally { setBusy(false); } }
  function setFormFromProvider(provider: Provider) { setAvailableModels([]); setModelOptions(Array.isArray(provider.extra.model_options) ? provider.extra.model_options.filter((item): item is string => typeof item === "string") : [provider.model_name]); const extra = provider.extra; setForm({ name: provider.name, protocol: provider.protocol, base_url: provider.base_url, api_key: "", model_name: provider.model_name, enabled: provider.enabled, is_external: provider.is_external, temperature: provider.temperature, max_tokens: String(provider.max_tokens), timeout_seconds: provider.timeout_seconds, network_mode: String(extra.network_mode ?? "inherit"), proxy_url: String(extra.proxy_url ?? ""), proxy_username: String(extra.proxy_username ?? ""), proxy_password: "", stream_output: Boolean(extra.stream_output), reasoning_mode: String(extra.reasoning_mode ?? "off"), reasoning_effort: String(extra.reasoning_effort ?? "medium"), test_model: String(extra.test_model ?? ""), test_timeout_seconds: Number(extra.test_timeout_seconds ?? 15), test_max_tokens: Number(extra.test_max_tokens ?? 256), quota_url: String(extra.quota_url ?? ""), quota_json_path: String(extra.quota_json_path ?? ""), quota_unit: String(extra.quota_unit ?? "") }); }
  function applyProviderPreset(key: keyof typeof PROVIDER_PRESETS) { const preset = PROVIDER_PRESETS[key]; setSelectedProvider(""); setAvailableModels([]); setModelOptions(preset.model_name ? [preset.model_name] : []); setForm({ ...form, ...preset, protocol: "openai_compatible", api_key: "", enabled: true, is_external: true }); setModelActivity(null); }
  async function saveProvider(event?: FormEvent, makeDefault = false) { event?.preventDefault(); setBusy(true); const started = Date.now(); setModelActivity({ phase: "正在保存模型配置", started }); try { if (!form.max_tokens.trim() || !Number.isInteger(Number(form.max_tokens)) || Number(form.max_tokens) < 1 || Number(form.max_tokens) > 393216) throw new Error("最大输出 token：请输入 1–393216 范围内的整数"); const { network_mode, proxy_url, proxy_username, proxy_password, stream_output, reasoning_mode, reasoning_effort, test_model, test_timeout_seconds, test_max_tokens, quota_url, quota_json_path, quota_unit, ...providerForm } = form; const saved = await api.saveProvider({ ...(selectedProvider ? { id: selectedProvider } : {}), ...providerForm, max_tokens: Number(form.max_tokens), api_key: form.api_key || null, extra: { network_mode, proxy_url: proxy_url || null, proxy_username: proxy_username || null, proxy_password: proxy_password || null, stream_output, reasoning_mode, reasoning_effort, test_model, test_timeout_seconds, test_max_tokens, quota_url, quota_json_path, quota_unit, model_options: [...new Set([...modelOptions, form.model_name])].filter(Boolean) } }); const items = await api.listProviders(); setProviders(items); setSelectedProvider(saved.id); setFormFromProvider(saved); if (makeDefault || !activeProviderId) { await api.activateProvider(saved.id); setActiveProviderId(saved.id); } setModelActivity({ phase: makeDefault ? "已保存并设为默认调用模型" : "配置已保存", started, result: { message: makeDefault ? "后续研究和共创将使用本配置的模型及代理。已有失败任务请点击重试。" : "配置已保存；如需用于生成任务，请点击设为默认调用模型。", model: saved.model_name } }); } catch (error) { setModelActivity({ phase: "保存失败", started, error: errorText(error) }); } finally { setBusy(false); } }
  async function activateModel() { if (!selectedProvider) return; const started = Date.now(); setModelActivity({ phase: "正在切换默认调用模型", started }); try { const result = await api.activateProvider(selectedProvider); setActiveProviderId(result.provider_id); setModelActivity({ phase: "默认模型已切换", started, result: { message: `${result.model_name} 将用于后续研究与共创` } }); } catch (error) { setModelActivity({ phase: "切换失败", started, error: errorText(error) }); } }
  async function testProvider() { if (!selectedProvider) return; setBusy(true); const started = Date.now(); setModelActivity({ phase: "正在创建短文本测试任务", started }); try { const job = await api.startProviderTest(selectedProvider); setProviderTestJobId(job.job_id); setModelActivity({ phase: job.phase, started }); } catch (error) { setModelActivity({ phase: "模型测试失败", started, error: errorText(error) }); setBusy(false); } }
  async function deleteSelectedProvider() { if (!selectedProvider || !window.confirm("删除这项模型配置及其本地密钥？此操作不会删除项目内容。")) return; const id = selectedProvider; setBusy(true); try { await api.deleteProvider(id); const items = await api.listProviders(); const active = await api.activeProvider(); setProviders(items); setActiveProviderId(active.provider_id); setSelectedProvider(""); applyProviderPreset("custom"); setModelActivity({ phase: "模型配置已删除", started: Date.now(), result: { message: "已移除配置及本地密钥" } }); } catch (error) { setModelActivity({ phase: "删除失败", started: Date.now(), error: errorText(error) }); } finally { setBusy(false); } }
  async function queryQuota() { if (!selectedProvider) return; setQuotaResult("正在查询供应商额度…"); try { const result = await api.queryProviderQuota(selectedProvider); setQuotaResult(`当前额度：${result.value} ${result.unit}（${result.route}）`); } catch (error) { setQuotaResult(`查询失败：${errorText(error)}`); } }
  async function exportSettings() { setSettingsMessage("正在整理配置…"); try { const backup = await api.exportSettings(); const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `内容智能白板-配置-${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); setSettingsMessage("配置已导出。文件包含明文 API Key 与代理密码，请仅在可信设备保存。"); } catch (error) { setSettingsMessage(`导出失败：${errorText(error)}`); } }
  async function importSettings(file: File | undefined) { if (!file) return; setSettingsMessage("正在校验和导入配置…"); try { if (file.size > 2_000_000) throw new Error("配置文件超过 2 MB"); const backup = JSON.parse(await file.text()) as Record<string, unknown>; const result = await api.importSettings(backup); const [items, active, security, mcpConfig, sourceItems, contentFormats] = await Promise.all([api.listProviders(), api.activeProvider(), api.getSecurity(), api.getMcpSearch(), api.listSources(), api.listContentFormats()]); setProviders(items); setActiveProviderId(active.provider_id); setProtect(security.protect_internal_data); setMcp(mcpConfig); setSettingsImportRevision((value) => value + 1); setSources(sourceItems); setFormats(contentFormats); const selected = items.find((item) => item.id === active.provider_id) ?? items[0]; if (selected) { setSelectedProvider(selected.id); setFormFromProvider(selected); } setSettingsMessage(`${result.message}${result.missing_paths.length ? `；请重新选择路径：${result.missing_paths.join("、")}` : ""}`); } catch (error) { setSettingsMessage(`导入失败：${errorText(error)}`); } }
  async function discoverModels() { if (!form.base_url) return; setBusy(true); const started = Date.now(); setModelActivity({ phase: "正在访问供应商模型列表", started }); try { const result = await api.discoverModels({ ...(selectedProvider ? { provider_id: selectedProvider } : {}), base_url: form.base_url, api_key: form.api_key || null, timeout_seconds: form.timeout_seconds, network_mode: form.network_mode, proxy_url: form.proxy_url || null, proxy_username: form.proxy_username || null, proxy_password: form.proxy_password || null }); setAvailableModels(result.models); setModelActivity({ phase: result.models.length ? "已获取模型列表" : "供应商未返回模型", started, result: { ...result, endpoint: form.base_url, network_mode: form.network_mode } }); } catch (error) { setModelActivity({ phase: "获取模型失败", started, error: errorText(error) }); } finally { setBusy(false); } }
  async function uploadWiki(file: File | undefined) { if (!file) return; setBusy(true); setSourceMessage("正在上传 Wiki ZIP…"); try { const source = await api.uploadWikiZip(file, sourceName); setSources(await api.listSources()); setSourceMessage(`知识源“${source.name}”已上传，请点击刷新知识库`); } catch (error) { setSourceMessage(`上传失败：${errorText(error)}`); } finally { setBusy(false); } }
  async function addSource(event: FormEvent) { event.preventDefault(); setBusy(true); const path = cleanSourcePath(sourcePath); setSourcePath(path); setSourceMessage(path !== sourcePath ? `已移除粘贴文本中的非路径提示，识别到目录：${path}` : "正在添加知识库…"); try { const source = await api.createSource(sourceName, path); const items = await api.listSources(); setSources(items); setSourcePath(""); setSourceMessage(`知识源“${source.name}”已添加，请点击刷新知识库`); } catch (error) { setSourceMessage(`添加失败：${errorText(error)}`); } finally { setBusy(false); } }
  async function browseSource() { setBusy(true); try { const result = await api.selectFolder(); if (result.path) { setSourcePath(cleanSourcePath(result.path)); setSourceMessage("已选择本地知识库文件夹"); } } catch (error) { setSourceMessage(errorText(error)); } finally { setBusy(false); } }
  async function removeSource(source: Source) { if (!window.confirm(`确定移除知识源“${source.name}”及其本地索引吗？源文件不会被删除。`)) return; setBusy(true); try { await api.deleteSource(source.id); setSources(await api.listSources()); setSourceMessage(`已移除知识源“${source.name}”，源文件未被修改`); } catch (error) { setSourceMessage(errorText(error)); } finally { setBusy(false); } }
  async function refreshSource(id: string) { setSourceMessage(""); try { const job = await api.startRefresh(id); setRefreshJobs((current) => ({ ...current, [id]: job })); } catch (error) { setSourceMessage(`刷新启动失败：${errorText(error)}`); } }
  async function saveProtect(value: boolean) { setProtect(value); try { await api.saveSecurity(value); setStatus(value ? "内部数据保护已开启" : "内部数据保护已关闭，请确认模型服务的数据边界"); } catch (error) { setStatus(errorText(error)); } }
  return <><PageHeader eyebrow="工作台配置" title="设置" description="管理知识源、模型、搜索与数据边界。" />
    <div className="settings-backup-bar"><div><strong>配置备份</strong><span>包含全局代理、模型、知识源路径、搜索 MCP、DeepSeek 网页工具、内容形态和密钥；不包含 Wiki 原文及项目内容。</span></div><div className="form-actions"><button type="button" className="secondary" onClick={exportSettings}>一键导出</button><label className="secondary file-import-button">一键导入<input type="file" accept=".json,application/json" onChange={(event) => { void importSettings(event.target.files?.[0]); event.target.value = ""; }} /></label></div></div>
    {settingsMessage && <p className="settings-backup-message" role="status">{settingsMessage}</p>}
    <nav className="settings-tabs" aria-label="设置功能" role="tablist">{([ ["sources", "知识源"], ["models", "大模型与代理"], ["network", "全局网络与代理"], ["mcp", "MCP 与网页搜索"], ["formats", "内容形态"], ["security", "数据保护"] ] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</nav>
    <div className="settings-grid settings-tab-body">{tab === "sources" && <section className="card settings-card"><div className="section-title"><h2>本地知识源</h2><span>只读，不修改源文件</span></div><form onSubmit={addSource}><label>上传 Wiki ZIP（支持服务器版）<input type="file" accept=".zip" disabled={busy} onChange={(e) => { void uploadWiki(e.target.files?.[0]); e.target.value = ""; }} /></label><label>知识源名称<input value={sourceName} onChange={(e) => setSourceName(e.target.value)} /></label><label>本地知识库文件夹路径<div className="folder-picker"><input value={sourcePath} onChange={(e) => setSourcePath(e.target.value)} onBlur={() => setSourcePath(cleanSourcePath(sourcePath))} onPaste={(e) => { const pasted = e.clipboardData.getData("text"); if (pasted) { e.preventDefault(); setSourcePath(cleanSourcePath(pasted)); } }} placeholder={"例如：D:\\LLM-Wiki\\wiki"} /><button type="button" className="secondary" disabled={busy} onClick={browseSource}>浏览文件夹</button></div></label><button className="primary" disabled={busy || !sourcePath.trim()}>添加知识源</button></form>{sourceMessage && <div className="settings-feedback" role="status">{sourceMessage}</div>}<p className="source-help">粘贴内容若含工具警告，会自动提取其中的本地目录。桌面版可选择本机文件夹；服务器版请填写服务器目录，或上传包含 _agent_context 的 Wiki ZIP。ZIP 导入 Markdown 文件，其他附件不导入；原始 ZIP 不会被修改。</p><p className="source-help">刷新时模型先阅读 _agent_context/overview.md 和 domain-map.md；研究时按需再读 relations.md，并从原始词条获取证据。</p><div className="source-list">{sources.map((source) => { const job = refreshJobs[source.id]; return <div className="source-entry" key={source.id}><div className="source-entry-top"><div><strong>{source.name}</strong><small>{source.root_path}</small></div><div className="source-actions"><button className="secondary" disabled={busy || job?.status === "running"} onClick={() => refreshSource(source.id)}>{job?.status === "running" ? "刷新中…" : "刷新知识库"}</button><button className="text-button danger" disabled={busy || job?.status === "running"} onClick={() => removeSource(source)}>移除</button></div></div>{job && <div className={`settings-progress ${job.status}`} role="status"><div className="settings-progress-head"><strong>{job.phase}</strong><span>{job.total ? `${job.processed} / ${job.total} 个词条` : "正在准备"}</span></div><div className="settings-progress-track"><i style={{ width: `${job.total ? Math.round(job.processed / job.total * 100) : 0}%` }} /></div><p>{job.detail}</p>{job.current_path && <p>当前词条：<code>{job.current_path}</code></p>}<p>已用 {formatSeconds(job.elapsed_seconds)} · {job.estimated_total_seconds == null ? "预计总时长计算中" : `预计总时长 ${formatSeconds(job.estimated_total_seconds)}`} · 已更新 {job.indexed} · 未变更 {job.unchanged} · 警告 {job.warnings_count}</p>{job.agent_context && <p>模型阅读：{job.agent_context.status === "read" ? `成功${job.agent_context.model ? `（${job.agent_context.model}）` : ""}，${job.agent_context.summary ?? "已理解领域图"}` : job.agent_context.message ?? "未读取"}</p>}{job.error && <p className="settings-error">错误：{job.error}</p>}{job.report?.warnings?.length ? <details><summary>查看 {job.report.warnings.length} 条索引警告</summary>{job.report.warnings.map((warning, index) => <p key={index}>{warning.path}：{warning.error}</p>)}</details> : null}</div>}</div>; })}</div></section>}
      {tab === "network" && <GlobalNetworkSettings key={settingsImportRevision} />}
    {tab === "models" && <section className="card settings-card">
        <p className="model-default-notice">当前研究与白板共创默认调用：{providers.find((item) => item.id === activeProviderId)?.name ?? "未配置"} · {providers.find((item) => item.id === activeProviderId)?.model_name ?? "无模型"}。测试其他配置成功不会自动切换默认模型。</p>
        <div className="section-title"><h2>自定义大模型</h2><button className="text-button" onClick={() => applyProviderPreset("custom")}>新建配置</button></div>
        <div className="provider-presets"><button type="button" onClick={() => applyProviderPreset("deepseek")}><strong>DeepSeek</strong><small>官方 OpenAI 兼容接口</small></button><button type="button" onClick={() => applyProviderPreset("aihubmix")}><strong>AIHubMix</strong><small>聚合模型供应商</small></button><button type="button" onClick={() => applyProviderPreset("custom")}><strong>其他供应商</strong><small>任意兼容接口</small></button></div>
        {providers.length > 0 && <div className="provider-selection"><label>已保存的供应商与模型<select value={selectedProvider} onChange={(e) => { setSelectedProvider(e.target.value); setQuotaResult(""); const provider = providers.find((item) => item.id === e.target.value); if (provider) setFormFromProvider(provider); }}><option value="">新建配置</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.id === activeProviderId ? "当前调用 · " : ""}{provider.name} · {provider.model_name} · {provider.is_external ? "外部" : "内部"}</option>)}</select></label><button type="button" className="secondary danger" disabled={busy || !selectedProvider} onClick={deleteSelectedProvider}>删除配置</button></div>}
        <form onSubmit={saveProvider} className="provider-form">
          <label>配置名称<input required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>接口协议<select value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })}><option value="openai_compatible">OpenAI 兼容接口</option><option value="custom">自定义兼容接口</option></select></label>
          <label>接口基础地址<input value={form.base_url} onChange={(e) => { setAvailableModels([]); setForm({ ...form, base_url: e.target.value }); }} placeholder="例如 https://api.deepseek.com 或 https://aihubmix.com/v1" /></label>
          <label>接口密钥<input type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder={selectedProvider ? "留空则使用已保存密钥" : "输入供应商 API Key"} /></label>
          <div className="network-settings"><label>网络连接方式<select value={form.network_mode} onChange={(e) => setForm({ ...form, network_mode: e.target.value })}><option value="inherit">继承全局网络设置</option><option value="auto">单独自动检测</option><option value="direct">直接连接</option><option value="system_proxy">Windows 系统代理</option><option value="custom_proxy">企业代理手动设置</option></select></label>{form.network_mode === "custom_proxy" && <div className="proxy-fields"><label>企业代理地址<input value={form.proxy_url} onChange={(e) => setForm({ ...form, proxy_url: e.target.value })} placeholder="例如 http://proxy.company.com:8080" /></label><label>代理用户名（可选）<input value={form.proxy_username} onChange={(e) => setForm({ ...form, proxy_username: e.target.value })} placeholder="域账号或代理账号" /></label><label>代理密码（可选）<input type="password" value={form.proxy_password} onChange={(e) => setForm({ ...form, proxy_password: e.target.value })} placeholder={selectedProvider ? "留空则使用已保存密码" : "输入代理密码"} /></label></div>}<p>自动模式会优先使用有效的 Windows 系统代理，失败后再尝试直连；企业代理支持地址及账号密码，并使用 Windows 系统证书库验证 HTTPS。</p></div>
          <div className="model-discovery"><label>当前调用模型<input list="provider-model-options" value={form.model_name} onChange={(e) => setForm({ ...form, model_name: e.target.value })} placeholder="手动输入模型 ID，或从下方选择" /><datalist id="provider-model-options">{availableModels.map((model) => <option key={model} value={model} />)}</datalist></label><button type="button" className="secondary" disabled={busy || !form.base_url || (!form.api_key && !selectedProvider)} onClick={discoverModels}>{busy ? "获取中…" : "刷新模型"}</button></div>
          <div className="form-actions"><button type="button" className="secondary" disabled={!form.model_name.trim()} onClick={() => setModelOptions((items) => [...new Set([...items, form.model_name.trim()])])}>将当前模型加入可调用列表</button></div>
          {!!modelOptions.length && <div className="model-chips" aria-label="可调用模型">{modelOptions.map((model) => <span className="model-option" key={model}><button type="button" className={form.model_name === model ? "active" : ""} onClick={() => setForm({ ...form, model_name: model })}>{model}</button><button type="button" className="text-button danger" aria-label={`移除 ${model}`} onClick={() => setModelOptions((items) => items.filter((item) => item !== model))}>移除</button></span>)}</div>}
          {!!availableModels.length && <details className="source-panel"><summary>供应商返回 {availableModels.length} 个模型，点击加入可调用列表</summary><label>筛选模型<input value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} placeholder="输入模型名称筛选" /></label><p className="context-note">最多显示前 100 项，输入名称可继续筛选。</p><div className="model-chips">{availableModels.filter((model) => model.toLowerCase().includes(modelFilter.toLowerCase())).slice(0, 100).map((model) => <button type="button" key={model} className={modelOptions.includes(model) ? "active" : ""} onClick={() => { setModelOptions((items) => [...new Set([...items, model])]); setForm((current) => ({ ...current, model_name: model })); }}>{modelOptions.includes(model) ? "已加入 · " : "+ "}{model}</button>)}</div></details>}
          <div className="config-grid"><label>温度<input type="number" min="0" max="2" step="0.1" value={form.temperature} onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })} /></label><label>最大输出 token<input required type="number" min="1" max="393216" step="1" value={form.max_tokens} onChange={(e) => setForm({ ...form, max_tokens: e.target.value })} /></label><label>超时秒数<input type="number" min="5" max="300" value={form.timeout_seconds} onChange={(e) => setForm({ ...form, timeout_seconds: Number(e.target.value) })} /></label></div>
          <details className="model-advanced" open><summary>推理、测试与额度设置</summary><label className="checkbox-label"><input type="checkbox" checked={form.stream_output} onChange={(e) => setForm({ ...form, stream_output: e.target.checked })} />启用流式接收（实验）</label><p>默认使用完整响应模式以优先保证正文交付。流式模式可实时显示供应商推理和正文接收进度；遇到停滞时请关闭此项。</p><div className="advanced-grid"><label>思考模式<select value={form.reasoning_mode} onChange={(e) => setForm({ ...form, reasoning_mode: e.target.value })}><option value="off">关闭思考 / 使用供应商默认参数</option><option value="effort">reasoning_effort 参数</option><option value="thinking">thinking.enabled 参数</option></select></label>{form.reasoning_mode === "effort" && <label>思考强度<select value={form.reasoning_effort} onChange={(e) => setForm({ ...form, reasoning_effort: e.target.value })}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>}<label>短文本测试模型<input value={form.test_model} onChange={(e) => setForm({ ...form, test_model: e.target.value })} placeholder="留空使用当前调用模型" /></label><label>每条线路测试超时（秒）<input type="number" min="5" max="30" value={form.test_timeout_seconds} onChange={(e) => setForm({ ...form, test_timeout_seconds: Number(e.target.value) })} /></label><label>测试输出上限（token）<input type="number" min="64" max="512" value={form.test_max_tokens} onChange={(e) => setForm({ ...form, test_max_tokens: Number(e.target.value) })} /></label><label>额度查询接口（可选）<input value={form.quota_url} onChange={(e) => setForm({ ...form, quota_url: e.target.value })} placeholder="供应商提供的余额或套餐接口" /></label><label>额度字段路径<input value={form.quota_json_path} onChange={(e) => setForm({ ...form, quota_json_path: e.target.value })} placeholder="如 data.balance" /></label><label>额度单位<input value={form.quota_unit} onChange={(e) => setForm({ ...form, quota_unit: e.target.value })} placeholder="元 / token / 次" /></label></div><p>DeepSeek 关闭思考时会明确发送 disabled；其他供应商默认不附加思考参数。开启思考且接口返回推理文本时，可在任务详情查看；流式模式支持实时显示。不同供应商的参数并不通用；额度查询需配置供应商接口。</p></details>
          <p className="context-note">最大输出可填写 1–393216 token（384K），实际输出上限以供应商和模型能力为准；数字框支持清空后重新输入。</p>
          <label>模型数据边界<select value={form.is_external ? "external" : "internal"} onChange={(e) => setForm({ ...form, is_external: e.target.value === "external" })}><option value="external">外部：数据保护开启时禁止发送内部资料</option><option value="internal">内部：数据保护开启时仍允许调用</option></select></label>
          <p className="context-note">仅将确实受企业控制、允许处理内部知识的模型标记为“内部”。保存当前调用模型后，可切换为默认模型。</p>
          <p className="context-note">先保存，再进行短文本实测或刷新额度。测试会向已保存的模型发送“请只回复 OK”；自动网络模式最多依次尝试系统代理和直连，每条线路按独立测试超时限制。</p>
          <div className="form-actions"><button className="secondary" disabled={busy || !form.name.trim() || !form.base_url || !form.model_name}>保存配置</button><button type="button" className="primary" disabled={busy || !form.name.trim() || !form.base_url || !form.model_name || !form.enabled} onClick={() => void saveProvider(undefined, true)}>保存并设为默认</button><button type="button" className="secondary" disabled={busy || !selectedProvider} onClick={testProvider}>短文本实测</button><button type="button" className="secondary" disabled={busy || !selectedProvider || !form.quota_url || !form.quota_json_path} onClick={queryQuota}>刷新额度</button><button type="button" className="secondary" disabled={busy || !selectedProvider || selectedProvider === activeProviderId} onClick={activateModel}>设为默认调用模型</button></div>
        </form>
        {quotaResult && <p className="settings-feedback" role="status">{quotaResult}</p>}
        {modelActivity && <div className={`settings-progress ${modelActivity.error || modelActivity.result?.status === "failed" ? "failed" : modelActivity.finished ? "completed" : "running"}`} role="status">
          <div className="settings-progress-head"><strong>{modelActivity.phase}</strong><span>已用 {formatSeconds(Math.floor(((modelActivity.finished ?? Date.now()) - modelActivity.started) / 1000))}</span></div>
          {(providerTestJobId || typeof modelActivity.result?.capability_test === "boolean") && <><p>测试文本：请只回复 OK · 模型：{String(modelActivity.result?.tested_model ?? (form.test_model || form.model_name))} · 网络：{String(modelActivity.result?.route ?? form.network_mode)}</p><p>请求地址：{String(modelActivity.result?.endpoint ?? form.base_url)}</p></>}
          {typeof modelActivity.result?.capability_test === "boolean" ? <><p><strong>{modelActivity.result.capability_test ? "通过：模型返回了文本" : "失败：模型未返回可用文本"}</strong>。{String(modelActivity.result.message ?? "")} · HTTP {String(modelActivity.result.http_status ?? "未返回")} · 耗时 {String(modelActivity.result.latency_ms ?? "待测")} ms</p><p>结束原因：{String(modelActivity.result.finish_reason ?? "未提供")} · 输出上限：{String(modelActivity.result.test_max_tokens ?? "未提供")} token</p>{Boolean(modelActivity.result.response_excerpt) && <p>返回文本：{String(modelActivity.result.response_excerpt)}</p>}{Boolean(modelActivity.result.usage) && <p>本次用量：{JSON.stringify(modelActivity.result.usage)}</p>}</> : modelActivity.result && <p>{String(modelActivity.result.message ?? "")}</p>}
          {modelActivity.error && <p className="settings-error">{modelActivity.error}</p>}
        </div>}
      </section>}
      {tab === "mcp" && <><section className="card settings-card"><div className="section-title"><div><h2>搜索 MCP</h2><p>通过 Streamable HTTP 连接 Tavily 或其他搜索 MCP；洞察、质疑、创意模式和笔记节点可综合网络与 Wiki 资料。</p></div></div>
        <label>服务名称<input value={mcp.name} onChange={(e) => setMcp({ ...mcp, name: e.target.value })} /></label>
        <label>MCP 服务地址<input value={mcp.url} onChange={(e) => setMcp({ ...mcp, url: e.target.value })} placeholder="https://mcp.tavily.com/mcp/" /></label>
        <label>搜索工具名称<input value={mcp.tool_name} onChange={(e) => setMcp({ ...mcp, tool_name: e.target.value })} placeholder="tavily_search" /></label>
        <label>API Key / Bearer Token<input type="password" value={mcp.api_key || ""} onChange={(e) => setMcp({ ...mcp, api_key: e.target.value })} placeholder={mcp.has_api_key ? "已保存密钥；留空沿用" : "输入密钥"} /></label>
        <label>网络连接方式<select value={mcp.network_mode} onChange={(e) => setMcp({ ...mcp, network_mode: e.target.value as McpSearchConfig["network_mode"] })}><option value="inherit">继承全局网络设置</option><option value="auto">单独自动检测</option><option value="direct">直接连接</option><option value="system_proxy">Windows 系统代理</option><option value="custom_proxy">企业代理手动设置</option></select></label>
        {mcp.network_mode === "custom_proxy" && <div className="proxy-fields"><label>企业代理地址<input value={mcp.proxy_url} onChange={(e) => setMcp({ ...mcp, proxy_url: e.target.value })} placeholder="http://proxy.company.com:8080" /></label><label>代理用户名<input value={mcp.proxy_username} onChange={(e) => setMcp({ ...mcp, proxy_username: e.target.value })} /></label><label>代理密码<input type="password" value={mcp.proxy_password || ""} onChange={(e) => setMcp({ ...mcp, proxy_password: e.target.value })} placeholder={mcp.has_proxy_password ? "已保存代理密码；留空沿用" : "可选"} /></label></div>}
        <label className="check"><input type="checkbox" checked={mcp.enabled} onChange={(e) => setMcp({ ...mcp, enabled: e.target.checked })} />启用搜索 MCP</label>
        <p className="context-note">先保存，再测试连接与工具列表。密钥独立保存在本地密钥文件；网络访问使用系统代理设置。</p>
        <div className="form-actions"><button className="primary" disabled={mcpBusy || !mcp.url.trim() || !mcp.tool_name.trim()} onClick={saveMcp}>保存 MCP</button><button className="secondary" disabled={mcpBusy || !mcp.enabled} onClick={testMcp}>测试连接</button></div>
        {mcpActivity && <div className={`settings-progress ${mcpActivity.error ? "failed" : ""}`} role="status"><div className="settings-progress-head"><strong>{mcpActivity.phase}</strong><span>已用 {formatSeconds(Math.floor((Date.now() - mcpActivity.started) / 1000))}</span></div><p>服务：{mcp.name} · 地址：{String(mcpActivity.result?.endpoint ?? mcp.url)} · 网络：{String(mcpActivity.result?.network_mode ?? mcp.network_mode)}</p>{mcpActivity.result && <p>{String(mcpActivity.result.message ?? "")} · 耗时 {String(mcpActivity.result.latency_ms ?? "待测")} ms · 搜索工具 {String(mcpActivity.result.search_tool ?? mcp.tool_name)} · 可用性 {mcpActivity.result.search_tool_available === true ? "通过" : "待确认/未找到"}</p>}{Array.isArray(mcpActivity.result?.tools) && <p>发现工具：{(mcpActivity.result.tools as string[]).join("、") || "无"}</p>}{mcpActivity.error && <p className="settings-error">{mcpActivity.error}。请检查 MCP 地址、密钥、代理与工具名称。</p>}</div>}
      </section><DeepSeekWebSettings key={settingsImportRevision} revision={mcpRevision} /></>}
      {tab === "formats" && <section className="card settings-card format-settings"><div className="section-title"><div><h2>内容输出形态与 Prompt</h2><p>这些要求会自动用于白板 AI 共创和内容工坊；节点中仍可填写本次特有的正向与负向 Prompt。</p></div><button className="secondary" disabled={busy || formats.length >= 20} onClick={() => setFormats([...formats, { id: `custom_${Date.now().toString(36)}`, name: "新内容形态", positive_prompt: "", negative_prompt: "" }])}>添加形态</button></div>
        {formats.map((item) => <div className="format-setting-item" key={item.id}><div><label>形态标识<input value={item.id} disabled title="保存后的形态标识不可更改" /></label><label>显示名称<input value={item.name} maxLength={60} onChange={(event) => changeFormat(item.id, { name: event.target.value })} /></label><button className="text-button danger" disabled={busy || formats.length === 1} onClick={() => setFormats(formats.filter((format) => format.id !== item.id))}>移除</button></div><div className="format-prompts"><label>默认正向 Prompt<textarea value={item.positive_prompt} maxLength={3000} onChange={(event) => changeFormat(item.id, { positive_prompt: event.target.value })} /></label><label>默认负向 Prompt<textarea value={item.negative_prompt} maxLength={3000} onChange={(event) => changeFormat(item.id, { negative_prompt: event.target.value })} /></label></div></div>)}
        <div className="form-actions"><button className="primary" disabled={busy || !formats.length || formats.some((item) => !item.name.trim())} onClick={saveFormats}>保存内容形态</button></div>
      </section>}
      {tab === "security" && <section className="card settings-card security-card"><div><h2>内部数据保护</h2><p>开启时，内部知识库、研究发现和白板内容不会发送给标记为“外部”的模型。模型操作会明确报错，不再悄悄生成本地模板。</p></div><label className="big-switch"><input type="checkbox" checked={protect} onChange={(e) => saveProtect(e.target.checked)} /><span>{protect ? "已开启" : "已关闭"}</span></label></section>}
    </div></>;
}
