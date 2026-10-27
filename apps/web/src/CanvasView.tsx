import { t, labels, useLocale, getLocale, uiMessage } from "./i18n";
import { PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import Markdown from "./MarkdownContent";
import WikiEvidence from "./WikiEvidence";
import CanvasToolbar from "./CanvasToolbar";

import {
  applyNodeChanges, Background, Connection, ConnectionMode, Controls, Edge, EdgeChange, Handle,
  MarkerType, MiniMap, Node, NodeChange, NodeProps, NodeResizer, Position, ReactFlow, ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, CanvasData, CanvasEdge, CanvasNode, ContentFormat, MagicJob, Project, downloadUrl } from "./api";

const WEB_SEARCH_TYPES = new Set(["insight", "challenge", "creative_pattern", "note"]);

const NODE_LABELS: Record<string, string> = labels({
  idea: "想法", brief: "简报", note: "笔记", knowledge: "知识", fact: "事实",
  signal: "信号", internal_knowledge: "内部知识", insight: "洞察", challenge: "质疑",
  creative_pattern: "创意模式", content_concept: "内容概念", output: "内容输出", frame: "分组",
});
const STATUS_LABELS: Record<string, string> = labels({
  exploring: "探索中", candidate: "候选", approved: "已批准", locked: "已锁定",
});

type FlowNodeData = Record<string, unknown> & {
  canvasNode: CanvasNode;
  relationship: "upstream" | "downstream" | null;
  onBodyCommit: (id: string, body: string) => void;
  onResizeCommit: (id: string, width: number, height: number) => void;
  onExpand: (id: string) => void;
  summarizing: boolean;
};
type FlowNode = Node<FlowNodeData, "canvas">;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneCanvas(canvas: CanvasData): CanvasData {
  return structuredClone(canvas);
}

function sameSelection(current: string[], next: string[]): boolean {
  return current.length === next.length && current.every((id) => next.includes(id));
}

function closeEnough(current: number | undefined, next: number, tolerance = 0.01): boolean {
  return typeof current === "number" && Math.abs(current - next) <= tolerance;
}

function FlowCard({ data, selected }: NodeProps<FlowNode>) {
  const locale = useLocale();
  const node = data.canvasNode;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.body);
  const cancelBlur = useRef(false);
  useEffect(() => { if (!editing) setDraft(node.body); }, [node.body, editing]);
  function finishEdit(save: boolean) {
    if (save && draft !== node.body) data.onBodyCommit(node.id, draft);
    setEditing(false);
  }
  return <article className={`flow-card node-${node.type} ${selected ? "selected" : ""} ${data.relationship ? `related-${data.relationship}` : ""} ${node.locked ? "locked" : ""}`}>
    <NodeResizer isVisible={selected && !node.locked} minWidth={220} minHeight={140} onResizeEnd={(_, size) => data.onResizeCommit(node.id, size.width, size.height)} />
    {node.type !== "frame" && <>
      <Handle id="top" type="source" position={Position.Top} className="connection-handle handle-top" />
      <Handle id="right" type="source" position={Position.Right} className="connection-handle handle-right" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="connection-handle handle-bottom" />
      <Handle id="left" type="source" position={Position.Left} className="connection-handle handle-left" />
    </>}
    <div className="node-head"><span>{NODE_LABELS[node.type] ?? node.type}</span>{node.locked && <b>{t("已锁定")}</b>}</div>
    <h3>{node.title}</h3>
    {node.type !== "frame" && (editing ?
      <textarea className="flow-card-editor nodrag nowheel" autoFocus aria-label={t("编辑{0}的 Markdown 正文", node.title)}
        value={draft} onChange={(event) => setDraft(event.target.value)}
        onPointerDown={(event) => event.stopPropagation()}
        onBlur={() => { if (cancelBlur.current) { cancelBlur.current = false; return; } finishEdit(true); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); cancelBlur.current = true; setDraft(node.body); setEditing(false); }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.blur(); }
        }} /> :
      <div className="flow-card-body nodrag" title={node.locked ? t("点击展开完整内容") : t("双击直接编辑 Markdown")}
        onDoubleClick={(event) => { event.stopPropagation(); if (!node.locked) { cancelBlur.current = false; setDraft(node.body); setEditing(true); } }}>
        {node.summary ? <p className="flow-card-summary">{node.summary}</p> :
          <span className="flow-card-placeholder">{node.body ? data.summarizing ? t("模型正在总结…") : t("模型摘要待生成") : t("双击输入 Markdown…")}</span>}
      </div>)}
    {node.type !== "frame" && !!node.body && !editing && <button type="button" className="flow-card-expand nodrag"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); data.onExpand(node.id); }}>{t("展开全文")}</button>}
    <div className="node-foot"><span>{STATUS_LABELS[node.status] ?? node.status}</span>{(node.metadata?.evidence?.length ?? 0) > 0 && <span>{node.metadata?.evidence?.length}  {t("条证据")}</span>}</div>
  </article>;
}

const NODE_TYPES = { canvas: FlowCard };
const FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1.05 };
const MULTI_SELECTION_KEYS = ["Control", "Meta"];
const SNAP_GRID: [number, number] = [10, 10];
const PRO_OPTIONS = { hideAttribution: true };
const DEFAULT_EDGE_OPTIONS = {
  type: "default",
  markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
  pathOptions: { curvature: 0.3 },
};

const GROUPS = [
  { key: "input", title: "01 输入与简报", types: ["idea", "brief"], x: 40, y: 40 },
  { key: "research", title: "02 研究与证据", types: ["knowledge", "fact", "signal", "internal_knowledge"], x: 820, y: 40 },
  { key: "thinking", title: "03 洞察与策略", types: ["insight", "challenge", "creative_pattern", "content_concept"], x: 1600, y: 40 },
];

function toFlowNodes(nodes: CanvasNode[], edges: CanvasEdge[], selectedIds: string[], onBodyCommit: FlowNodeData["onBodyCommit"], onResizeCommit: FlowNodeData["onResizeCommit"], onExpand: FlowNodeData["onExpand"], summaryInFlight: string): FlowNode[] {
  const selected = new Set(selectedIds);
  const upstream = new Set(edges.filter((edge) => selected.has(edge.target_node_id)).map((edge) => edge.source_node_id));
  const downstream = new Set(edges.filter((edge) => selected.has(edge.source_node_id)).map((edge) => edge.target_node_id));
  return nodes.map((node) => ({
    id: node.id,
    type: "canvas",
    position: { x: node.x, y: node.y },
    data: { canvasNode: node, relationship: selected.has(node.id) ? null : upstream.has(node.id) ? "upstream" : downstream.has(node.id) ? "downstream" : null, onBodyCommit, onResizeCommit, onExpand, summarizing: summaryInFlight === node.id },
    selected: selected.has(node.id),
    draggable: !node.locked,
    selectable: true,
    zIndex: node.type === "frame" ? node.locked ? -10 : -1 : 2,
    className: node.type === "frame" ? `flow-node-frame${node.locked ? " flow-node-frame-locked" : ""}` : "",
    style: { width: node.width, height: node.height },
  }));
}

function smartPorts(source: CanvasNode | undefined, target: CanvasNode | undefined): { source: string; target: string } {
  if (!source || !target) return { source: "right", target: "left" };
  const dx = (target.x + target.width / 2) - (source.x + source.width / 2);
  const dy = (target.y + target.height / 2) - (source.y + source.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? { source: "right", target: "left" } : { source: "left", target: "right" };
  return dy >= 0 ? { source: "bottom", target: "top" } : { source: "top", target: "bottom" };
}

function rerouteEdges(board: CanvasData): CanvasData {
  const nodes = new Map(board.nodes.map((node) => [node.id, node]));
  return {
    ...board,
    edges: board.edges.map((edge) => {
      const ports = smartPorts(nodes.get(edge.source_node_id), nodes.get(edge.target_node_id));
      return { ...edge, metadata: { ...edge.metadata, source_handle: ports.source, target_handle: ports.target, routing: "smart" } };
    }),
  };
}

function upstreamIds(board: CanvasData, targetIds: string[], maxDepth = 6): string[] {
  const target = new Set(targetIds);
  const found = new Set<string>();
  let frontier = [...targetIds];
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const edge of board.edges) {
      if (!frontier.includes(edge.target_node_id) || target.has(edge.source_node_id) || found.has(edge.source_node_id)) continue;
      found.add(edge.source_node_id);
      next.push(edge.source_node_id);
    }
    frontier = next;
  }
  return [...found];
}

function miniMapNodeColor(node: Node): string {
  return (node.data as FlowNodeData | undefined)?.canvasNode?.type === "insight" ? "#c7000b" : "#9aa5b4";
}

function EmptyProject() {
  return <div className="empty-state"><strong>{t("请先创建或选择一个项目")}</strong><p>{t("项目会保存想法、研究、白板节点和最终内容资产。")}</p></div>;
}

function PageHeader({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }) {
  return <header className="page-header"><div><small>{t("内容白板")}</small><h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

const TASK_STATUS: Record<string, string> = labels({ running: "运行中", paused: "已暂停", failed: "失败", cancelled: "已取消", completed: "已完成" });
const NETWORK_LABELS: Record<string, string> = labels({ inherit: "继承全局网络设置", auto: "自动（系统代理优先）", direct: "直连", system_proxy: "系统代理", custom_proxy: "企业代理" });

function TaskTelemetry({ metrics }: { metrics?: Record<string, unknown> }) {
  if (!metrics) return null;
  return <div className="task-telemetry">
    {metrics.route != null && <span>{t("线路：")}{String(metrics.route)}</span>}
    {metrics.http_status != null && <span>HTTP {String(metrics.http_status)}</span>}
    {metrics.elapsed_seconds != null && <span>{t("本次调用")} {String(metrics.elapsed_seconds)}  {t("秒")}</span>}
    {metrics.content_chars != null && <span>{t("正文")} {String(metrics.content_chars)}  {t("字符")}</span>}
    {metrics.reasoning_chars != null && <span>{t("推理")} {String(metrics.reasoning_chars)}  {t("字符")}</span>}
    {typeof metrics.provider_reasoning === "string" && !!metrics.provider_reasoning && <details className="provider-reasoning-delta"><summary>{t("查看供应商推理输出片段")}</summary><pre>{metrics.provider_reasoning}</pre></details>}
    {metrics.finish_reason != null && <span>{t("结束原因：")}{String(metrics.finish_reason)}</span>}
    {metrics.exception_type != null && <span>{t("错误类型：")}{String(metrics.exception_type)}</span>}
    {metrics.usage != null && <details><summary>{t("用量统计")}</summary><pre>{JSON.stringify(metrics.usage, null, 2)}</pre></details>}
    {typeof metrics.output_preview === "string" && <details><summary>{t("已接收正文预览")}</summary><p>{metrics.output_preview}</p></details>}
  </div>;
}

function TaskLogExport({ jobId }: { jobId: string }) {
  return <div className="task-log-export"><a className="secondary" href={downloadUrl(`/api/magic/jobs/${jobId}/logs/export?format=txt`)} download>{t("导出 LOG（文本）")}</a><a className="secondary" href={downloadUrl(`/api/magic/jobs/${jobId}/logs/export?format=json`)} download>{t("导出 LOG（JSON）")}</a></div>;
}

function TaskDetails({ job, nodes, formats, controls, pending, message, onClose, onResume }: {
  job: MagicJob; nodes: CanvasNode[]; formats: ContentFormat[]; controls: React.ReactNode; pending: boolean; message: string;
  onClose: () => void; onResume: (request: Record<string, unknown>) => void;
}) {
  const [instruction, setInstruction] = useState(String(job.request?.instruction ?? ""));
  const [negative, setNegative] = useState(String(job.request?.negative_prompt ?? ""));
  const [outputType, setOutputType] = useState(String(job.request?.output_type ?? "insight"));
  const [format, setFormat] = useState(String(job.request?.format ?? "wechat"));
  const editable = ["paused", "failed", "cancelled"].includes(job.status);
  const reasoningEvents = (job.events || []).filter((event) => event.attempt === (job.attempt || 1) && typeof event.metrics?.provider_reasoning === "string" && event.metrics.provider_reasoning);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="task-details-dialog" role="dialog" aria-modal="true" aria-label={t("任务完整详情")}>
      <header><div><small>{TASK_STATUS[job.status]}  {t("· 第 {0} 次执行", job.attempt ?? 1)}</small><h2>{t("AI 任务详情")}</h2></div><button className="secondary" onClick={onClose}>{t("关闭详情")}</button></header>
      {message && <p className="settings-feedback" role="status">{message}</p>}
      <p>{job.job_id}</p><p>{t("创建于")} {new Date(job.created_at).toLocaleString(getLocale())}  {t("· 更新于")} {job.updated_at ? new Date(job.updated_at).toLocaleString(getLocale()) : t("未记录")}</p>
      <div className="task-detail-summary"><strong>{uiMessage(job.phase)} · {job.progress}%</strong><p>{uiMessage(job.detail)}</p>{job.error && <p className="settings-error">{t("完整错误：")}{uiMessage(job.error)}</p>}</div>
      {Boolean((job.result as Record<string, unknown> | null)?.completed_draft) && <details className="evidence-panel" open><summary>{t("已保存的完整草稿（尚未通过简报核对）")}</summary><p>{t("这是模型已完整返回的版本。后续审阅或修订尚未完成，请勿视为最终定稿。")}</p><Markdown>{String((job.result as Record<string, unknown>).completed_draft)}</Markdown></details>}
      {job.result?.failure && <div className="settings-error"><strong>{job.result.failure.http_status == null ? t("未收到 HTTP 响应") : `HTTP ${job.result.failure.http_status}`} · {job.result.failure.operation}</strong><p>{uiMessage(job.result.failure.reason)}</p><p>{t("处理建议：")}{uiMessage(job.result.failure.suggestion)}</p><p>{t("请求地址：")}{job.result.failure.endpoint}</p></div>}
      <p>{t("本次调用：")}{job.provider?.name || "旧版未记录"} · {job.provider?.model_name || "模型未记录"} · {NETWORK_LABELS[job.provider?.network_mode || ""] || "网络未记录"}</p>
      {job.provider?.base_url && <p>{t("接口：")}{job.provider.base_url}</p>}
      <div className="task-detail-actions">{controls}</div><TaskLogExport jobId={job.job_id} />
      <details className="provider-reasoning-panel" open><summary>{t("供应商模型推理输出（实时）")}</summary><p className="context-note">{t("仅展示本任务所选模型 API 实际返回的 reasoning_content / reasoning 文本，不生成或推测。此处按最近 200 条日志汇总，本次调用及历次执行的完整内容可导出 LOG。")}</p>{reasoningEvents.length ? <div className="provider-reasoning-text">{reasoningEvents.map((event, index) => <pre key={index}>{String(event.metrics!.provider_reasoning)}</pre>)}</div> : <p>{t("供应商尚未返回推理文本；未开启思考或不提供此字段的模型仍可正常生成正文。")}</p>}</details>
      <h3>{t("实时执行 LOG")}</h3><p className="context-note">{t("实时记录处理阶段、连接线路、HTTP、接收进度及错误。供应商返回的推理文本也会独立记录。此处显示最近 200 条；导出包含全部日志与历次重试记录。")}</p>{job.events?.length ? <ol className="task-event-list">{job.events.map((event, index) => <li key={index} className={`task-log-${event.level || "info"}`}><small>{new Date(event.at).toLocaleTimeString(getLocale())}  {t("· 第 {0} 次 ·", event.attempt)} {event.level === "error" ? t("错误") : event.level === "warning" ? t("警告") : t("信息")}</small><strong>{uiMessage(event.phase)}</strong><p>{uiMessage(event.detail)}</p><TaskTelemetry metrics={event.metrics} /></li>)}</ol> : <p>{t("旧版任务没有逐步记录。")}</p>}
      <h3>{t("创作要求与输入")}</h3>
      {!job.request?.instruction && <p>{t("旧版任务没有保存原始 Prompt，请补充要求后重新执行。")}</p>}
      <label>{t("正向 Prompt")}<textarea value={instruction} maxLength={1000} disabled={!editable} onChange={(event) => setInstruction(event.target.value)} placeholder={t("输入本任务需要完成的事情")} /></label>
      <label>{t("负向 Prompt")}<textarea value={negative} maxLength={2000} disabled={!editable} onChange={(event) => setNegative(event.target.value)} /></label>
      <div className="advanced-grid"><label>{t("输出节点类型")}<select disabled={!editable} value={outputType} onChange={(event) => setOutputType(event.target.value)}>{["insight", "challenge", "creative_pattern", "note", "output"].map((type) => <option key={type} value={type}>{NODE_LABELS[type]}</option>)}</select></label>{outputType === "output" && <label>{t("内容形态")}<select disabled={!editable} value={format} onChange={(event) => setFormat(event.target.value)}>{formats.map((item) => <option key={item.id} value={item.id}>{t(item.name)}</option>)}</select></label>}</div>
      <p>{t("继承上游层级：")}{String(job.request?.upstream_depth ?? 6)}  {t("· 网络搜索：")}{job.request?.web_search ? t("开启") : t("关闭")}</p>
      {editable && <><p>{t("继续或重试将使用当前默认模型重新执行；已发送给供应商的请求可能仍会计费。")}</p><button className="primary" disabled={pending || instruction.trim().length < 2} onClick={() => onResume({ ...job.request, node_ids: job.node_ids, instruction: instruction.trim(), negative_prompt: negative, output_type: outputType, format, web_search: WEB_SEARCH_TYPES.has(outputType) && Boolean(job.request?.web_search) })}>{t("按以上要求")}{job.status === "paused" ? t("继续") : t("重试")}</button></>}
      <h3>{t("输入节点（当前内容）")}</h3>{job.node_ids.map((id) => { const node = nodes.find((item) => item.id === id); return <details key={id}><summary>{node?.title || t("已删除节点 {0}", id)}</summary><Markdown>{node?.body || "节点内容已不存在"}</Markdown></details>; })}
      {Boolean((job.result as Record<string, unknown> | null)?.partial_body) && <><h3>{t("中断前的草稿（未完成）")}</h3><Markdown>{String((job.result as Record<string, unknown>).partial_body)}</Markdown></>}
      {job.result?.node && <><h3>{t("生成结果：")}{job.result.node.title}</h3><Markdown>{job.result.node.body}</Markdown></>}
    </section>
  </div>;
}

export default function CanvasView({ project, canvas, selectedIds, setSelectedIds, onChange, onRefresh, beforeGenerate, setStatus }: {
  project: Project | null;
  canvas: CanvasData | null;
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  onChange: (canvas: CanvasData) => void;
  onRefresh: (skipPendingSave?: boolean) => Promise<void>;
  beforeGenerate?: () => Promise<void>;
  setStatus: (value: string) => void;
}) {
  type Draft = { magic: string; negative: string; type: string; web: boolean; format: string; duration: string; depth: number };
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftKey = `${project?.id ?? ""}:${[...selectedIds].sort().join("|")}`;
  const [defaultFormat, setDefaultFormat] = useState("wechat");
  const draft: Draft = drafts[draftKey] ?? { magic: "", negative: "", type: "insight", web: false, format: defaultFormat, duration: "90", depth: 6 };
  const updateDraft = (changes: Partial<Draft>) => setDrafts((current) => ({ ...current, [draftKey]: { ...(current[draftKey] ?? draft), ...changes } }));
  const magic = draft.magic;
  const magicNegativePrompt = draft.negative;
  const magicType = draft.type;
  const webSearch = draft.web;
  const contentFormat = draft.format;
  const contentDuration = draft.duration;
  const upstreamDepth = draft.depth;
  const [busy, setBusy] = useState(false);
  const deletedJobIdsRef = useRef(new Set<string>());
  const [magicJobs, setMagicJobs] = useState<MagicJob[]>([]);
  const [taskDetailId, setTaskDetailId] = useState("");
  const [taskFilter, setTaskFilter] = useState("all");
  const [tasksCollapsed, setTasksCollapsed] = useState(() => { try { return localStorage.getItem("cic.canvas.tasks.collapsed") === "true"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("cic.canvas.tasks.collapsed", String(tasksCollapsed)); } catch { /* 当前页面仍可使用 */ } }, [tasksCollapsed]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [taskMessage, setTaskMessage] = useState("");
  const [taskOperations, setTaskOperations] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<{ name?: string; model_name: string | null; network_mode?: string } | null>(null);
  const completedJobsRef = useRef(new Set<string>());
  const [submittingMagic, setSubmittingMagic] = useState(false);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [contentFormats, setContentFormats] = useState<ContentFormat[]>([]);
  const [displayNodes, setDisplayNodes] = useState<FlowNode[]>([]);
  const [expandedNodeId, setExpandedNodeId] = useState("");
  const [summaryInFlight, setSummaryInFlight] = useState("");
  const [summaryRevision, setSummaryRevision] = useState(0);
  const summaryBusyRef = useRef(false);
  const summaryBlockedRef = useRef(false);
  const summaryAttemptedRef = useRef(new Set<string>());
  const [, setHistoryRevision] = useState(0);
  const undoStack = useRef<CanvasData[]>([]);
  const redoStack = useRef<CanvasData[]>([]);
  const boardRef = useRef<CanvasData | null>(canvas);
  const boardElementRef = useRef<HTMLElement | null>(null);
  const flowInstanceRef = useRef<ReactFlowInstance<FlowNode> | null>(null);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const rightPanRef = useRef<{ pointerId: number; startX: number; startY: number; origin: { x: number; y: number; zoom: number }; current: { x: number; y: number; zoom: number } } | null>(null);
  const [panningRight, setPanningRight] = useState(false);
  const displayNodesRef = useRef<FlowNode[]>([]);
  const onChangeRef = useRef(onChange);
  const draggingRef = useRef(false);
  const selectedNodeIdsRef = useRef(selectedIds);
  const selectedEdgeIdsRef = useRef(selectedEdgeIds);
  const onExpand = useCallback((id: string) => setExpandedNodeId(id), []);
  const refreshJobsRef = useRef(onRefresh);
  const statusJobsRef = useRef(setStatus);
  refreshJobsRef.current = onRefresh;
  statusJobsRef.current = setStatus;
  useEffect(() => {
    if (!project?.id) return;
    let active = true;
    const projectId = project.id;
    const poll = async () => {
      try {
        api.activeProvider().then((value) => { if (active) setDefaultModel(value); }).catch(() => {});
        const jobs = await api.listMagicJobs(projectId);
        if (!active) return;
        setMagicJobs(jobs.filter((job) => !deletedJobIdsRef.current.has(job.job_id)));
        const finished = jobs.filter((job) => job.status === "completed" && !completedJobsRef.current.has(job.job_id));
        finished.forEach((job) => completedJobsRef.current.add(job.job_id));
        if (finished.length) await refreshJobsRef.current();
      } catch (error) { if (active) statusJobsRef.current(t("读取白板任务失败：{0}", errorText(error))); }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [project?.id]);
  useEffect(() => {
    let active = true;
    api.listContentFormats().then((formats) => {
      if (!active) return;
      setContentFormats(formats);
      setDefaultFormat(formats[0]?.id ?? "");
    }).catch((error) => setStatus(t("读取输出形态失败：{0}", errorText(error))));
    return () => { active = false; };
  }, [setStatus]);

  const onBodyCommit = useCallback((id: string, body: string) => {
    const current = boardRef.current;
    const node = current?.nodes.find((item) => item.id === id);
    if (!current || !node || node.locked || node.body === body) return;
    undoStack.current = [...undoStack.current.slice(-79), cloneCanvas(current)];
    redoStack.current = [];
    setHistoryRevision((value) => value + 1);
    const next = { ...current, nodes: current.nodes.map((item) => item.id === id ? { ...item, body, summary: null, summary_model: null } : item) };
    boardRef.current = next;
    onChangeRef.current(next);
    setStatus(t("Markdown 内容已更新，正在自动保存"));
  }, [setStatus]);

  const onResizeCommit = useCallback((id: string, width: number, height: number) => {
    const current = boardRef.current;
    const node = current?.nodes.find((item) => item.id === id);
    if (!current || !node || !Number.isFinite(width) || !Number.isFinite(height) ||
      (closeEnough(node.width, width) && closeEnough(node.height, height))) return;
    undoStack.current = [...undoStack.current.slice(-79), cloneCanvas(current)];
    redoStack.current = [];
    setHistoryRevision((value) => value + 1);
    const next = rerouteEdges({ ...current, nodes: current.nodes.map((item) => item.id === id ? { ...item, width, height } : item) });
    boardRef.current = next;
    onChangeRef.current(next);
    setStatus(t("节点大小已更新，正在自动保存"));
  }, [setStatus]);

  const onMoveEnd = useCallback((_: unknown, viewport: { x: number; y: number; zoom: number }) => {
    if (rightPanRef.current) return;
    const current = boardRef.current;
    if (!current) return;
    const previous = current.viewport ?? {};
    if (
      closeEnough(previous.x, viewport.x) &&
      closeEnough(previous.y, viewport.y) &&
      closeEnough(previous.zoom, viewport.zoom, 0.0001)
    ) return;
    const next = { ...current, viewport };
    boardRef.current = next;
    onChangeRef.current(next);
  }, []);

  useEffect(() => { boardRef.current = canvas; }, [canvas]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { selectedNodeIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { selectedEdgeIdsRef.current = selectedEdgeIds; }, [selectedEdgeIds]);
  useEffect(() => {
    if (!canvas || draggingRef.current) return;
    const next = toFlowNodes(canvas.nodes, canvas.edges, selectedIds, onBodyCommit, onResizeCommit, onExpand, summaryInFlight);
    displayNodesRef.current = next;
    setDisplayNodes(next);
  }, [canvas, selectedIds, onBodyCommit, onResizeCommit, onExpand, summaryInFlight]);
  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    setSelectedEdgeIds([]);
    setHistoryRevision((value) => value + 1);
  }, [project?.id]);
  useEffect(() => {
    summaryAttemptedRef.current.clear();
    summaryBlockedRef.current = false;
    setExpandedNodeId("");
  }, [project?.id]);

  async function generateSummary(node: CanvasNode, force = false) {
    if (!project || summaryBusyRef.current) return;
    summaryBusyRef.current = true;
    setSummaryInFlight(node.id);
    const projectId = project.id;
    try {
      if (beforeGenerate) await beforeGenerate();
      else if (boardRef.current) await api.saveCanvas(projectId, boardRef.current);
      const result = await api.summarizeNode(projectId, node.id, force);
      const current = boardRef.current;
      if (current?.project_id === projectId && result.summary) {
        const next = { ...current, nodes: current.nodes.map((item) =>
          item.id === node.id && item.title === result.title && item.body === result.body
            ? { ...item, summary: result.summary, summary_model: result.summary_model } : item) };
        boardRef.current = next;
        onChangeRef.current(next);
      }
    } catch (error) {
      summaryBlockedRef.current = true;
      setStatus(t("模型摘要暂不可用：{0}。仍可展开查看完整正文。", errorText(error)));
    } finally {
      summaryBusyRef.current = false;
      setSummaryInFlight("");
      setSummaryRevision((value) => value + 1);
    }
  }

  useEffect(() => {
    if (!canvas || !project || summaryBusyRef.current || summaryBlockedRef.current) return;
    const missing = canvas.nodes.find((node) => node.type !== "frame" && node.body.trim() && !node.summary &&
      !summaryAttemptedRef.current.has(`${node.id}|${node.title}|${node.body}`));
    if (!missing) return;
    const timer = setTimeout(() => {
      summaryAttemptedRef.current.add(`${missing.id}|${missing.title}|${missing.body}`);
      void generateSummary(missing);
    }, 900);
    return () => clearTimeout(timer);
  }, [canvas, project?.id, summaryRevision]);

  function applyWithoutHistory(next: CanvasData) {
    boardRef.current = next;
    onChangeRef.current(next);
  }

  function pushUndoSnapshot() {
    const current = boardRef.current;
    if (!current) return;
    undoStack.current = [...undoStack.current.slice(-79), cloneCanvas(current)];
    redoStack.current = [];
    setHistoryRevision((value) => value + 1);
  }

  function commit(next: CanvasData, message?: string) {
    pushUndoSnapshot();
    applyWithoutHistory(next);
    if (message) setStatus(message);
  }

  function undo() {
    const current = boardRef.current;
    const previous = undoStack.current.pop();
    if (!current || !previous) return;
    redoStack.current.push(cloneCanvas(current));
    applyWithoutHistory(previous);
    setSelectedIds([]);
    setSelectedEdgeIds([]);
    setHistoryRevision((value) => value + 1);
    setStatus(t("已撤回上一步操作"));
  }

  function redo() {
    const current = boardRef.current;
    const next = redoStack.current.pop();
    if (!current || !next) return;
    undoStack.current.push(cloneCanvas(current));
    applyWithoutHistory(next);
    setSelectedIds([]);
    setSelectedEdgeIds([]);
    setHistoryRevision((value) => value + 1);
    setStatus(t("已重做上一步操作"));
  }

  function startRightPan(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 2 || !flowInstanceRef.current || (event.target as HTMLElement).closest("input,textarea,select,[contenteditable='true'],.react-flow__controls,.react-flow__minimap,.canvas-toolbox")) return;
    event.preventDefault(); event.stopPropagation();
    const viewport = flowInstanceRef.current.getViewport();
    rightPanRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: viewport, current: viewport };
    cursorRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanningRight(true);
  }

  function moveBoardPointer(event: ReactPointerEvent<HTMLElement>) {
    if (!(event.target as Element | null)?.closest(".canvas-toolbox")) cursorRef.current = { x: event.clientX, y: event.clientY };
    const pan = rightPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    pan.current = { x: pan.origin.x + event.clientX - pan.startX, y: pan.origin.y + event.clientY - pan.startY, zoom: pan.origin.zoom };
    void flowInstanceRef.current?.setViewport(pan.current, { duration: 0 });
  }

  function finishRightPan(event: ReactPointerEvent<HTMLElement>) {
    const pan = rightPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    rightPanRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setPanningRight(false);
    onMoveEnd(null, pan.current);
  }

  function addNote() {
    const board = boardRef.current;
    if (!board) return;
    const bounds = boardElementRef.current?.getBoundingClientRect();
    const pointer = cursorRef.current;
    const screenPoint = pointer ?? (bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : null);
    const viewport = flowInstanceRef.current?.getViewport() ?? { x: board.viewport.x ?? 0, y: board.viewport.y ?? 0, zoom: board.viewport.zoom ?? 1 };
    const point = screenPoint && flowInstanceRef.current ? flowInstanceRef.current.screenToFlowPosition(screenPoint, { snapToGrid: true }) : {
      x: ((screenPoint?.x ?? 400) - (bounds?.left ?? 0) - viewport.x) / viewport.zoom,
      y: ((screenPoint?.y ?? 300) - (bounds?.top ?? 0) - viewport.y) / viewport.zoom,
    };
    const node: CanvasNode = {
      id: `nod_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "note", title: t("新笔记"), body: "", status: "exploring",
      locked: false, x: point.x - (pointer ? 0 : 170), y: point.y - (pointer ? 0 : 105), width: 340, height: 210,
      metadata: {}, created_by: "user", project_id: board.project_id, canvas_id: board.id,
    };
    commit({ ...board, nodes: [...board.nodes, node] }, t("已添加新节点；可从上下左右连接点拖出有向连线"));
    setSelectedIds([node.id]);
  }

  function deleteSelection() {
    const board = boardRef.current;
    if (!board || (!selectedIds.length && !selectedEdgeIds.length)) return;
    const removable = new Set(board.nodes.filter((node) => selectedIds.includes(node.id) && !node.locked).map((node) => node.id));
    const keptNodes = board.nodes.filter((node) => !removable.has(node.id)).map((node) =>
      node.type === "frame" && Array.isArray(node.metadata.member_ids)
        ? { ...node, metadata: { ...node.metadata, member_ids: (node.metadata.member_ids as string[]).filter((id) => !removable.has(id)) } }
        : node);
    const keptEdges = board.edges.filter((edge) => !selectedEdgeIds.includes(edge.id) && !removable.has(edge.source_node_id) && !removable.has(edge.target_node_id));
    if (keptNodes.length === board.nodes.length && keptEdges.length === board.edges.length) {
      setStatus(t("选中的节点已锁定，不能删除"));
      return;
    }
    commit({ ...board, nodes: keptNodes, edges: keptEdges }, t("已删除选中内容，可使用 Ctrl+Z 撤回"));
    setSelectedIds([]);
    setSelectedEdgeIds([]);
  }

  function createGroup() {
    const board = boardRef.current;
    if (!board) return;
    const selected = board.nodes.filter((node) => selectedIds.includes(node.id));
    if (selected.length < 2) return;
    const x = Math.min(...selected.map((node) => node.x)) - 45;
    const y = Math.min(...selected.map((node) => node.y)) - 72;
    const width = Math.max(...selected.map((node) => node.x + node.width)) - x + 45;
    const height = Math.max(...selected.map((node) => node.y + node.height)) - y + 45;
    const frame: CanvasNode = {
      id: `nod_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "frame", title: t("内容分组"), body: "", status: "exploring", locked: false,
      x, y, width, height, metadata: { member_ids: selectedIds }, created_by: "user",
      project_id: board.project_id, canvas_id: board.id,
    };
    commit({ ...board, nodes: [frame, ...board.nodes] }, t("已创建内容分组；选中分组后可综合加工成员节点"));
    setSelectedIds([frame.id]);
  }

  function duplicateSelection() {
    const board = boardRef.current;
    if (!board) return;
    const copies = board.nodes.filter((node) => selectedIds.includes(node.id) && node.type !== "frame").map((node) => ({
      ...cloneCanvas({ ...board, nodes: [node], edges: [] }).nodes[0],
      id: `nod_${crypto.randomUUID().replaceAll("-", "")}`,
      title: t("{0}（副本）", node.title), x: node.x + 36, y: node.y + 36, locked: false,
    }));
    if (!copies.length) return;
    commit({ ...board, nodes: [...board.nodes, ...copies] }, t("已复制选中节点"));
    setSelectedIds(copies.map((node) => node.id));
  }

  function nudge(dx: number, dy: number) {
    const board = boardRef.current;
    if (!board || !selectedIds.length) return;
    commit({ ...board, nodes: board.nodes.map((node) => selectedIds.includes(node.id) ? { ...node, x: node.x + dx, y: node.y + dy } : node) });
  }

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input,textarea,select,[contenteditable='true']")) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if (command && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
      if (command && event.key.toLowerCase() === "a") { event.preventDefault(); setSelectedIds(boardRef.current?.nodes.filter((node) => node.type !== "frame").map((node) => node.id) ?? []); return; }
      if (command && event.key.toLowerCase() === "d") { event.preventDefault(); duplicateSelection(); return; }
      if (command && event.key.toLowerCase() === "s") { event.preventDefault(); setStatus(t("白板会自动保存，无需手动保存")); return; }
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteSelection(); return; }
      if (event.key === "Escape") { setSelectedIds([]); setSelectedEdgeIds([]); return; }
      if (!command && event.key.toLowerCase() === "n") { event.preventDefault(); addNote(); return; }
      const step = event.shiftKey ? 1 : 10;
      if (event.key === "ArrowLeft") { event.preventDefault(); nudge(-step, 0); }
      if (event.key === "ArrowRight") { event.preventDefault(); nudge(step, 0); }
      if (event.key === "ArrowUp") { event.preventDefault(); nudge(0, -step); }
      if (event.key === "ArrowDown") { event.preventDefault(); nudge(0, step); }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  if (!project) return <><PageHeader title={t("把研究变成可持续积累的内容资产")} description={t("节点、证据、分支和内容输出都保存在同一个项目中。")} /><EmptyProject /></>;
  if (!canvas) return <div className="empty-state">{t("正在加载白板…")}</div>;

  const activeProject = project;
  const board = canvas;
  const selected = board.nodes.filter((node) => selectedIds.includes(node.id));
  const primary = selected.length === 1 ? selected[0] : null;
  const inheritedIds = upstreamIds(board, selectedIds, upstreamDepth);
  const flowEdges: Edge[] = board.edges.map((edge) => ({
    id: edge.id,
    source: edge.source_node_id,
    target: edge.target_node_id,
    sourceHandle: String(edge.metadata?.source_handle ?? smartPorts(
      board.nodes.find((node) => node.id === edge.source_node_id),
      board.nodes.find((node) => node.id === edge.target_node_id),
    ).source),
    targetHandle: String(edge.metadata?.target_handle ?? smartPorts(
      board.nodes.find((node) => node.id === edge.source_node_id),
      board.nodes.find((node) => node.id === edge.target_node_id),
    ).target),
    type: "default",
    className: selectedIds.includes(edge.source_node_id) || selectedIds.includes(edge.target_node_id) ? "edge-related edge-flowing" : "",
    pathOptions: { curvature: 0.3 },
    selected: selectedEdgeIds.includes(edge.id),
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
  }));

  function onNodesChange(changes: NodeChange<FlowNode>[]) {
    const next = applyNodeChanges(changes, displayNodesRef.current);
    displayNodesRef.current = next;
    setDisplayNodes(next);
    if (changes.some((change) => change.type === "select" || change.type === "remove")) {
      const ids = next.filter((node) => node.selected).map((node) => node.id);
      if (!sameSelection(selectedNodeIdsRef.current, ids)) {
        selectedNodeIdsRef.current = ids;
        setSelectedIds(ids);
      }
    }
  }

  function onNodeDragStart() {
    if (draggingRef.current) return;
    pushUndoSnapshot();
    draggingRef.current = true;
  }

  function onNodeDragStop(_: unknown, dragged?: FlowNode) {
    const current = boardRef.current;
    if (!current) return;
    const positions = new Map(displayNodesRef.current.map((node) => [node.id, node.position]));
    const frame = current.nodes.find((node) => node.id === dragged?.id && node.type === "frame");
    const framePosition = frame ? positions.get(frame.id) : undefined;
    const dx = frame && framePosition ? framePosition.x - frame.x : 0;
    const dy = frame && framePosition ? framePosition.y - frame.y : 0;
    const members = new Set<string>(Array.isArray(frame?.metadata.member_ids) ? frame.metadata.member_ids as string[] : []);
    const moved = current.nodes.map((node) => {
      const position = positions.get(node.id);
      if (members.has(node.id)) return { ...node, x: node.x + dx, y: node.y + dy };
      return position ? { ...node, x: position.x, y: position.y } : node;
    });
    const next = rerouteEdges({ ...current, nodes: moved });
    draggingRef.current = false;
    applyWithoutHistory(next);
    setStatus(t("节点位置和连接线路由已更新，正在自动保存"));
  }

  function onEdgesChange(changes: EdgeChange<Edge>[]) {
    if (changes.some((change) => change.type === "select" || change.type === "remove")) {
      const ids = new Set(selectedEdgeIdsRef.current);
      for (const change of changes) {
        if (change.type === "remove" || (change.type === "select" && !change.selected)) ids.delete(change.id);
        else if (change.type === "select" && change.selected) ids.add(change.id);
      }
      const next = [...ids];
      if (!sameSelection(selectedEdgeIdsRef.current, next)) {
        selectedEdgeIdsRef.current = next;
        setSelectedEdgeIds(next);
      }
    }
    const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
    if (!removed.size) return;
    commit({ ...board, edges: board.edges.filter((edge) => !removed.has(edge.id)) }, t("已删除连接线"));
  }

  function onConnect(connection: Connection) {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    if (board.edges.some((edge) => edge.source_node_id === connection.source && edge.target_node_id === connection.target)) return;
    const fallbackPorts = smartPorts(
      board.nodes.find((node) => node.id === connection.source),
      board.nodes.find((node) => node.id === connection.target),
    );
    const edge: CanvasEdge = {
      id: `edg_${crypto.randomUUID().replaceAll("-", "")}`,
      source_node_id: connection.source,
      target_node_id: connection.target,
      relation: "context",
      metadata: {
        source_handle: connection.sourceHandle ?? fallbackPorts.source,
        target_handle: connection.targetHandle ?? fallbackPorts.target,
        routing: "smart",
      },
    };
    commit({ ...board, edges: [...board.edges, edge] }, t("已创建有向关系：上游内容将作为下游节点的生成上下文"));
  }

  function organizeCanvas() {
    const current = boardRef.current;
    if (!current) return;
    const regular = current.nodes.filter((node) => node.type !== "frame");
    const userFrames = current.nodes.filter((node) => node.type === "frame" && !node.metadata?.starter_frame && !node.metadata?.auto_group);
    const placed = new Set<string>();
    const arranged: CanvasNode[] = [];
    const frames: CanvasNode[] = [];
    const tallestRows = Math.max(1, ...GROUPS.map((group) => Math.ceil(regular.filter((node) => group.types.includes(node.type)).length / 2)));
    const frameHeight = Math.max(570, 110 + tallestRows * 230);
    for (const group of GROUPS) {
      const members = regular.filter((node) => group.types.includes(node.type));
      members.forEach((node, index) => {
        placed.add(node.id);
        arranged.push({
          ...node,
          x: group.x + 34 + (index % 2) * 340,
          y: group.y + 90 + Math.floor(index / 2) * 230,
          width: 310,
          height: 190,
        });
      });
      frames.push({
        id: `grp_${group.key}_${current.id}`,
        type: "frame", title: t(group.title), body: "", status: "exploring", locked: false,
        x: group.x, y: group.y, width: 730, height: frameHeight,
        metadata: { auto_group: true, group_key: group.key }, created_by: "system",
        project_id: current.project_id, canvas_id: current.id,
      });
    }
    const unplaced = regular.filter((node) => !placed.has(node.id)).map((node, index) => ({
      ...node, x: 820 + (index % 2) * 340, y: frameHeight + 120 + Math.floor(index / 2) * 260,
    }));
    const next = rerouteEdges({ ...current, nodes: [...frames, ...userFrames, ...arranged, ...unplaced] });
    commit(next, t("已按节点类型分组，并自动重排有向连接线"));
  }

  function organizeConnections() {
    const current = boardRef.current;
    if (!current) return;
    commit(rerouteEdges(current), t("已按节点相对位置重新规划连接线"));
  }

  function updateLocal(id: string, values: Partial<CanvasNode>) {
    commit({ ...board, nodes: board.nodes.map((node) => node.id === id ? {
      ...node, ...values,
      ...("title" in values || "body" in values ? { summary: null, summary_model: null } : {}),
    } : node) });
  }

  async function runMagic() {
    if ((!magic.trim() && magicType !== "output") || !selectedIds.length || submittingMagic) return;
    const inputs = [...new Set(selectedIds.flatMap((id) => {
      const node = boardRef.current?.nodes.find((item) => item.id === id);
      return node?.type === "frame" ? (Array.isArray(node.metadata.member_ids) ? node.metadata.member_ids as string[] : []) : [id];
    }))];
    if (!inputs.length) { setStatus(t("分组中没有可加工的节点")); return; }
    if (magicType === "output" && contentFormat === "video_script" && (!contentDuration.trim() || !Number.isInteger(Number(contentDuration)) || Number(contentDuration) < 15 || Number(contentDuration) > 600)) {
      setStatus(t("目标时长：请输入 15–600 秒范围内的整数")); return;
    }
    const submittedDraftKey = draftKey;
    setSubmittingMagic(true);
    try {
      if (beforeGenerate) await beforeGenerate(); else await api.saveCanvas(activeProject.id, boardRef.current!);
      const job = await api.startMagic(activeProject.id, inputs, magicType === "output" && !magic.trim() ? t("结合节点内容生成草稿") : magic,
        magicType, magicNegativePrompt, WEB_SEARCH_TYPES.has(magicType) && webSearch, contentFormat, contentFormat === "video_script" ? Number(contentDuration) : 90, upstreamDepth);
      setMagicJobs((current) => [job, ...current.filter((item) => item.job_id !== job.job_id)]);
      await onRefresh(true);
      setStatus(t("已启动生成任务：{0}", job.job_id));
      setDrafts((current) => { const next = { ...current }; delete next[submittedDraftKey]; return next; });
    } catch (error) { setStatus(errorText(error)); } finally { setSubmittingMagic(false); }
  }

  async function taskAction(jobId: string, action: "pause" | "cancel" | "resume", values?: Record<string, unknown>) {
    const original = magicJobs.find((job) => job.job_id === jobId);
    if (action === "resume" && !values && !original?.request?.instruction) {
      setTaskDetailId(jobId); setTaskMessage(t("旧版任务没有保存 Prompt，请在详情中补充创作要求再重试。")); return;
    }
    setTaskOperations((current) => [...current, jobId]);
    try {
      const updated = action === "pause" ? await api.pauseMagicJob(jobId) : action === "cancel" ? await api.cancelMagicJob(jobId) : await api.resumeMagicJob(jobId, values);
      setMagicJobs((current) => current.map((item) => item.job_id === jobId ? updated : item));
      const message = action === "pause" ? t("任务已暂停，继续时会重新执行模型调用") : action === "cancel" ? t("任务已取消") : t("任务已重新启动，使用当前默认模型");
      setTaskMessage(message); setStatus(message);
    } catch (error) { const message = t("任务操作失败：{0}", errorText(error)); setTaskMessage(message); setStatus(message); }
    finally { setTaskOperations((current) => current.filter((id) => id !== jobId)); }
  }

  async function deleteTask(job: MagicJob) {
    if (job.status === "running") return;
    setTaskOperations((current) => [...current, job.job_id]);
    try {
      await api.deleteMagicJob(job.job_id);
      deletedJobIdsRef.current.add(job.job_id);
      setMagicJobs((current) => current.filter((item) => item.job_id !== job.job_id));
      setSelectedTaskIds((current) => current.filter((id) => id !== job.job_id));
      setTaskDetailId((current) => current === job.job_id ? "" : current);
      setTaskMessage(t("任务及其日志已删除，生成的节点和内容资产保留"));
    } catch (error) { setTaskMessage(t("删除失败：{0}", errorText(error))); }
    finally { setTaskOperations((current) => current.filter((id) => id !== job.job_id)); }
  }

  function taskControls(job: MagicJob) {
    const pending = taskOperations.includes(job.job_id);
    return <>{job.status === "running" && <button className="text-button" disabled={pending} onClick={() => void taskAction(job.job_id, "pause")}>{t("暂停")}</button>}
      {["running", "paused", "failed"].includes(job.status) && <button className="text-button danger" disabled={pending} onClick={() => void taskAction(job.job_id, "cancel")}>{t("取消")}</button>}
      {["paused", "failed", "cancelled"].includes(job.status) && <button className="text-button" disabled={pending} onClick={() => void taskAction(job.job_id, "resume")}>{job.status === "paused" ? t("继续") : t("重试")}</button>}
      <button className="text-button" onClick={() => { setTaskMessage(""); setTaskDetailId(job.job_id); }}>{t("查看详情")}</button>
      <button className="text-button danger" disabled={pending || job.status === "running"} title={job.status === "running" ? t("请先暂停或取消任务，再删除") : t("删除任务和日志，保留生成结果")} onClick={() => void deleteTask(job)}>{t("删除任务")}</button>
      {job.status === "completed" && job.result?.node && <button className="text-button" onClick={() => setSelectedIds([job.result!.node!.id])}>{t("定位结果")}</button>}</>;
  }

  async function batchTaskAction(action: "pause" | "cancel" | "resume" | "delete") {
    const valid = magicJobs.filter((job) => selectedTaskIds.includes(job.job_id) && (action === "delete" ? job.status !== "running" : action === "pause" ? job.status === "running" : action === "resume" ? ["paused", "failed", "cancelled"].includes(job.status) : ["running", "paused", "failed"].includes(job.status)));
    if (!valid.length) { setTaskMessage(t("请先勾选支持该操作的任务")); return; }
    await Promise.all(valid.map((job) => action === "delete" ? deleteTask(job) : taskAction(job.job_id, action)));
  }

  async function saveAsAsset() {
    if (!primary || primary.type !== "output" || !boardRef.current) return;
    setBusy(true);
    try {
      if (beforeGenerate) await beforeGenerate(); else await api.saveCanvas(activeProject.id, boardRef.current);
      const result = await api.saveNodeAsAsset(activeProject.id, primary.id);
      setStatus(result.message); await onRefresh(true); setSelectedIds([primary.id]);
    } catch (error) { setStatus(errorText(error)); } finally { setBusy(false); }
  }

  return <div className="canvas-page">
    <PageHeader title={activeProject.name} description={t("用有向连接组织上下文，按所选层级继承上游内容。")} />
    <div className="canvas-shortcuts"><span>{t("卡片显示模型摘要，点击展开全文")}</span><span>{t("双击正文编辑 Markdown")}</span><span>{t("四向端口拖出有向连线")}</span><span>{t("框选或 Ctrl 多选")}</span><span>{t("Ctrl+Z 撤回")}</span><span>{t("Delete 删除")}</span><span>{t("N 新建节点")}</span></div>
    <div className="canvas-workspace flow-workspace">
      <section className={`board-wrap${panningRight ? " panning-right" : ""}`} ref={boardElementRef}
        onPointerDownCapture={startRightPan} onPointerMoveCapture={moveBoardPointer}
        onPointerUpCapture={finishRightPan} onPointerCancelCapture={finishRightPan} onLostPointerCapture={finishRightPan}
        onPointerLeave={() => { if (!rightPanRef.current) cursorRef.current = null; }}
        onContextMenuCapture={(event) => { if (!(event.target as HTMLElement).closest("input,textarea,[contenteditable='true']")) event.preventDefault(); }}>
        <CanvasToolbar tools={[
          { icon: "undo", label: t("撤回"), shortcut: "Ctrl+Z", disabled: !undoStack.current.length, onClick: undo },
          { icon: "redo", label: t("重做"), shortcut: "Ctrl+Shift+Z / Ctrl+Y", disabled: !redoStack.current.length, onClick: redo },
          { icon: "add", label: t("添加节点"), shortcut: "N", onClick: addNote },
          { icon: "delete", label: t("删除"), shortcut: "Delete", disabled: !selectedIds.length && !selectedEdgeIds.length, onClick: deleteSelection },
          { icon: "group", label: t("创建分组"), disabled: selected.length < 2, onClick: createGroup },
          { icon: "connections", label: t("整理连线"), onClick: organizeConnections },
          { icon: "organize", label: t("按类型整理"), onClick: organizeCanvas },
        ]} />
        <ReactFlow
          onInit={(instance) => { flowInstanceRef.current = instance; }}
          nodes={displayNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          onMoveEnd={onMoveEnd}
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          minZoom={0.2}
          maxZoom={1.8}
          selectionOnDrag
          panOnDrag={[1]}
          elevateNodesOnSelect={false}
          connectionMode={ConnectionMode.Loose}
          multiSelectionKeyCode={MULTI_SELECTION_KEYS}
          deleteKeyCode={null}
          snapToGrid
          snapGrid={SNAP_GRID}
          proOptions={PRO_OPTIONS}
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        >
          <Background gap={20} size={1} color="#dfe4ea" />
          <MiniMap pannable zoomable nodeColor={miniMapNodeColor} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </section>
      <aside className="inspector"><div className="inspector-content">{primary ? <>
        <div className="inspector-title"><div><small>{NODE_LABELS[primary.type] ?? primary.type}</small><h2>{t("节点详情")}</h2></div><button className="icon-button danger" disabled={primary.locked} onClick={deleteSelection}>{t("删除")}</button></div>
        <label>{t("标题")}<input disabled={primary.locked} value={primary.title} onChange={(event) => updateLocal(primary.id, { title: event.target.value })} /></label>
        <label>{t("正文")}<textarea disabled={primary.locked} value={primary.body} onChange={(event) => updateLocal(primary.id, { body: event.target.value })} /></label>
        {primary.type !== "frame" && !!primary.body && <div className="node-summary-inspector"><strong>{t("卡片模型摘要")}</strong><p>{primary.summary || (summaryInFlight === primary.id ? t("正在生成摘要…") : t("尚未生成摘要"))}</p><button className="secondary" disabled={!!summaryInFlight} onClick={() => { summaryBlockedRef.current = false; void generateSummary(primary, true); }}>{summaryInFlight === primary.id ? t("生成中…") : t("重新生成摘要")}</button></div>}
        {Array.isArray(primary.metadata?.source_node_ids) && <div className="source-panel"><strong>{t("加工来源")}</strong><p>{t("由")} {(primary.metadata.source_node_titles as string[] | undefined)?.join("、") || (primary.metadata.source_node_ids as string[]).join("、")}  {t("联合加工生成")}</p><small>{t("来源节点 ID：")}{(primary.metadata.source_node_ids as string[]).join("、")}</small>{Array.isArray(primary.metadata.inherited_upstream_ids) && primary.metadata.inherited_upstream_ids.length > 0 && <p>{t("额外继承")} {(primary.metadata.inherited_upstream_ids as string[]).length}  {t("个上游节点")}</p>}</div>}
        {primary.type === "frame" && Array.isArray(primary.metadata.member_ids) && <div className="source-panel"><strong>{t("分组成员")}</strong><p>{t("包含")} {(primary.metadata.member_ids as string[]).length}  {t("个节点；输入处理要求可生成新的下游节点。")}</p></div>}
        <label>{t("状态")}<select disabled={primary.locked} value={primary.status} onChange={(event) => updateLocal(primary.id, { status: event.target.value })}><option value="exploring">{t("探索中")}</option><option value="candidate">{t("候选")}</option><option value="approved">{t("已批准")}</option></select></label>
        <label className="switch-row"><span><strong>{t("锁定节点")}</strong><small>{t("锁定后不能修改内容或删除")}</small></span><input type="checkbox" checked={primary.locked} onChange={(event) => updateLocal(primary.id, { locked: event.target.checked, status: event.target.checked ? "locked" : primary.status === "locked" ? "candidate" : primary.status })} /></label>
        {primary.type === "output" && <div className="asset-save-panel"><strong>{primary.metadata?.asset_id ? t("已关联内容资产") : t("仍是白板草稿")}</strong><p>{t("先在上方直接修改，确认后再保存到内容资产；再次保存会生成新版本。")}</p><button className="primary" disabled={busy || primary.locked} onClick={saveAsAsset}>{busy ? t("正在保存…") : primary.metadata?.asset_id ? t("更新内容资产") : t("保存到内容资产")}</button></div>}
        {primary.type === "output" && <details className="source-panel"><summary>{t("查看生成形态与 Prompt")}</summary><p>{t("输出形态：")}{String(primary.metadata?.format_name || primary.metadata?.format || "未记录")}</p><p>{t("正向要求：")}{String(primary.metadata?.instruction || "未单独填写")}</p><p>{t("负向要求：")}{String(primary.metadata?.negative_prompt || "未单独填写")}</p><p>{t("形态默认要求：")}{String(primary.metadata?.format_positive_prompt || "未记录")}</p><p>{t("形态避免事项：")}{String(primary.metadata?.format_negative_prompt || "未记录")}</p></details>}
        {!!primary.metadata?.evidence?.length && <div className="evidence-panel"><h3>{t("证据")}</h3>{primary.metadata.evidence.map((item, index) => <WikiEvidence key={`${primary.id}-${item.chunk_id}-${index}`} item={item} sourceId={typeof primary.metadata.research_source_id === "string" ? primary.metadata.research_source_id : undefined} />)}</div>}
        {Array.isArray(primary.metadata?.web_sources) && primary.metadata.web_sources.length > 0 && <div className="evidence-panel"><h3>{t("网络资料")}</h3>{(primary.metadata.web_sources as Array<{ title: string; url: string; excerpt: string; content?: string; content_chars?: number }>).map((item, index) => <details key={`${item.url}-${index}`}><summary>{item.title || item.url}</summary><small>{item.content_chars ? t("用于模型上下文的正文：{0} 字符", item.content_chars) : t("网络资料摘录")}</small><Markdown>{item.content || item.excerpt}</Markdown>{item.url && <a href={item.url} target="_blank" rel="noreferrer">{t("查看来源")}</a>}</details>)}</div>}
      </> : <div className="inspector-empty"><strong>{selected.length > 1 ? t("已选择 {0} 个节点", selected.length) : selectedEdgeIds.length ? t("已选择 {0} 条连接", selectedEdgeIds.length) : t("选择一个节点")}</strong><p>{selected.length > 1 ? t("可以将多个节点综合为一个新的下游节点。") : t("从任一节点的上下左右端口拖到另一个节点，即可创建有向连接。")}</p></div>}</div>
        {!!selectedIds.length && <section className="ai-copilot">
          <div className="ai-copilot-head"><div><small>{t("AI 共创")}</small><h3>{selectedIds.length === 1 && primary?.type !== "frame" ? t("由当前节点生成下游") : t("综合多个节点")}</h3></div><span>{selectedIds.length}  {t("个选中节点")}</span></div>
          <label>{t("可继承的上游节点层级")}<select value={upstreamDepth} onChange={(event) => updateDraft({ depth: Number(event.target.value) })}><option value={0}>{t("不继承")}</option><option value={1}>{t("仅上游一层")}</option><option value={2}>{t("上游两层")}</option><option value={3}>{t("上游三层")}</option><option value={6}>{t("上游六层（默认）")}</option><option value={12}>{t("上游十二层")}</option></select></label>
          <p className="context-note">{inheritedIds.length ? t("当前选中的层级将继承 {0} 个上游节点。", inheritedIds.length) : t("当前层级没有可继承的上游节点。")}  {t("将回读这些节点引用的完整 Wiki 词条。内容简报始终作为默认创作约束；如需例外，请在本次要求中明确说明。原节点保留，结果进入新的下游节点。")}</p>
          {!!primary && Array.isArray(primary.metadata.ai_prompt_history) && <details className="evidence-panel" open><summary>{t("此节点提交过的 AI Prompt")}</summary>{(primary.metadata.ai_prompt_history as Array<Record<string, unknown>>).map((item, index) => <div key={index}><strong>{NODE_LABELS[String(item.output_type)] || String(item.output_type || "")} · {String(item.at || "")}</strong><p style={{ whiteSpace: "pre-wrap" }}>{String(item.instruction || "")}</p>{Boolean(item.negative_prompt) && <p>{t("负向 Prompt：")}{String(item.negative_prompt)}</p>}</div>)}</details>}
          <label>{t("新节点类型")}<select value={magicType} onChange={(event) => updateDraft({ type: event.target.value })}><option value="insight">{t("洞察")}</option><option value="challenge">{t("质疑")}</option><option value="creative_pattern">{t("创意模式")}</option><option value="note">{t("笔记")}</option><option value="output">{t("内容输出")}</option></select></label>
          {WEB_SEARCH_TYPES.has(magicType) && <label className="check"><input type="checkbox" checked={webSearch} onChange={(event) => updateDraft({ web: event.target.checked })} />{t("检索网络资料（自动选择：优先 DeepSeek，其次搜索 MCP，并与 Wiki 资料综合）")}</label>}
          {magicType === "output" && <><label>{t("内容输出形态")}<select value={contentFormat} onChange={(event) => updateDraft({ format: event.target.value })}>{contentFormats.map((format) => <option key={format.id} value={format.id}>{t(format.name)}</option>)}</select></label>{contentFormat === "video_script" && <label>{t("目标时长（秒）")}<input type="number" min="15" max="600" value={contentDuration} step="1" onChange={(event) => updateDraft({ duration: event.target.value.replace(/^0+(?=\d)/, "") })} /></label>}<p className="context-note">{t("默认 Prompt 在“设置 → 内容输出形态与 Prompt”中配置，此处填写本次加工要求。")}</p></>}
          <label>{magicType === "output" ? t("正向 Prompt（要做的事情）") : t("处理要求")}<textarea value={magic} onChange={(event) => updateDraft({ magic: event.target.value })} placeholder={t("例如：结合上游证据补充案例，调整为更有节奏的表达，并保留事实边界。")} /></label>
          {magicType === "output" && <label>{t("负向 Prompt（不要做的事情）")}<textarea value={magicNegativePrompt} onChange={(event) => updateDraft({ negative: event.target.value })} placeholder={t("例如：不要编造案例；不要使用夸张标题；不要忽略证据不足的部分。")} /></label>}
          {magicJobs.filter((job) => job.status === "running" && job.node_ids.some((id) => selectedIds.includes(id))).map((job) => <div className="ai-progress" role="status" key={job.job_id}><span className="ai-progress-spinner" />{uiMessage(job.phase)} · {job.progress}% · {uiMessage(job.detail)}</div>)}
          <button className="primary ai-run" disabled={submittingMagic || (magicType === "output" ? !contentFormat : !magic.trim()) || magicJobs.some((job) => job.status === "running" && job.node_ids.length === selectedIds.length && job.node_ids.every((id) => selectedIds.includes(id)))} onClick={runMagic}>{submittingMagic ? t("正在提交…") : magicType === "output" ? t("生成内容输出节点") : t("AI 加工并生成下游节点")}</button>
        </section>}
      </aside>
    </div>
    <section className={`canvas-task-monitor${tasksCollapsed ? " collapsed" : ""}`} aria-label={t("AI 任务状态")}>
      <div className="task-manager-heading"><strong>{t("AI 任务监测 · 正在生成")} {magicJobs.filter((job) => job.status === "running").length}  {t("个任务")}</strong><span>{t("暂停")} {magicJobs.filter((job) => job.status === "paused").length}  {t("· 失败")} {magicJobs.filter((job) => job.status === "failed").length}  {t("· 共")} {magicJobs.length}  {t("项")}</span><button type="button" className="task-monitor-toggle" aria-expanded={!tasksCollapsed} aria-controls="canvas-task-details" onClick={() => setTasksCollapsed((value) => !value)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={tasksCollapsed ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>{tasksCollapsed ? t("展开任务监测") : t("折叠任务监测")}</button></div>
      {!tasksCollapsed && <div id="canvas-task-details">
      <p className="task-default-model">{t("后续任务默认模型：")}{defaultModel ? `${defaultModel.name || "未配置"} · ${defaultModel.model_name || "无模型"} · ${NETWORK_LABELS[defaultModel.network_mode || ""] || "自动"}` : t("正在读取")}{t("。可在设置中“保存并设为默认”。")}</p>
      <div className="task-manager-toolbar"><label>{t("任务状态")}<select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value)}><option value="all">{t("全部任务")}</option>{Object.entries(TASK_STATUS).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label><span>{t("已选")} {selectedTaskIds.length}  {t("项")}</span><button className="secondary" onClick={() => void batchTaskAction("pause")}>{t("暂停选中")}</button><button className="secondary" onClick={() => void batchTaskAction("resume")}>{t("继续 / 重试选中")}</button><button className="secondary danger" onClick={() => void batchTaskAction("cancel")}>{t("取消选中")}</button><button className="secondary danger" onClick={() => void batchTaskAction("delete")}>{t("删除已停止的选中任务")}</button></div>
      {taskMessage && <p className="task-manager-message" role="status">{uiMessage(taskMessage)}</p>}
      <div className="canvas-task-list">{magicJobs.filter((job) => taskFilter === "all" || job.status === taskFilter).map((job) => <article className={`canvas-task ${job.status}`} key={job.job_id}>
        <div className="task-row-title"><input type="checkbox" aria-label={t("选择任务 {0}", job.job_id)} checked={selectedTaskIds.includes(job.job_id)} onChange={(event) => setSelectedTaskIds((current) => event.target.checked ? [...current, job.job_id] : current.filter((id) => id !== job.job_id))} /><button className="task-open" onClick={() => { setTaskMessage(""); setTaskDetailId(job.job_id); }}>{job.node_ids.map((id) => board.nodes.find((node) => node.id === id)?.title || "节点已删除").join("、")}</button><span>{TASK_STATUS[job.status]} · {job.progress}%</span></div>
        <p>{uiMessage(job.phase)} · {uiMessage(job.detail)}</p>
        <small>{t("已用")} {Math.max(0, Math.floor(((job.status === "running" ? Date.now() : new Date(job.updated_at || job.created_at).getTime()) - new Date(job.created_at).getTime()) / 1000)) || 0}  {t("秒 · 第")} {job.attempt || 1}  {t("次执行")}</small>
        <TaskTelemetry metrics={[...(job.events || [])].reverse().find((event) => event.attempt === (job.attempt || 1) && event.metrics && Object.keys(event.metrics).length)?.metrics} />
        <small>{job.provider?.name || "旧版未记录模型"} · {job.provider?.model_name || ""} · {NETWORK_LABELS[job.provider?.network_mode || ""] || ""}</small>
        {job.error && <small className="task-error">{uiMessage(job.error)}</small>}
        <div className="task-row-actions">{taskControls(job)}</div>
        <div className="canvas-task-track"><i style={{ width: `${job.progress}%` }} /></div>
      </article>)}</div>
      {!magicJobs.length && <span>{t("暂无生成任务")}</span>}
      </div>}
    </section>
    {taskDetailId && (() => { const job = magicJobs.find((item) => item.job_id === taskDetailId); return job ? <TaskDetails key={job.job_id} job={job} nodes={board.nodes} formats={contentFormats} controls={taskControls(job)} pending={taskOperations.includes(job.job_id)} message={uiMessage(taskMessage)} onClose={() => setTaskDetailId("")} onResume={(values) => void taskAction(job.job_id, "resume", values)} /> : null; })()}
    {expandedNodeId && (() => {
      const expanded = board.nodes.find((node) => node.id === expandedNodeId);
      return expanded ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setExpandedNodeId(""); }}>
        <section className="node-full-content" role="dialog" aria-modal="true" aria-label={t("{0}的完整内容", expanded.title)}>
          <header><div><small>{NODE_LABELS[expanded.type] ?? expanded.type}  {t("· 完整内容")}</small><h2>{expanded.title}</h2></div><button className="secondary" onClick={() => setExpandedNodeId("")}>{t("收起全文")}</button></header>
          {expanded.summary && <p className="node-full-summary"><strong>{t("模型摘要")}</strong>{expanded.summary}</p>}
          <div className="node-full-markdown"><Markdown>{expanded.body}</Markdown>
            {!!expanded.metadata?.evidence?.length && <section className="evidence-panel"><h3>{t("原始 Wiki 依据")}</h3>{expanded.metadata.evidence.map((item, index) => <WikiEvidence key={`${expanded.id}-${item.chunk_id}-${index}`} item={item} sourceId={typeof expanded.metadata.research_source_id === "string" ? expanded.metadata.research_source_id : undefined} />)}</section>}
          </div>
        </section>
      </div> : null;
    })()}
  </div>;
}
