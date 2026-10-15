import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import {
  applyNodeChanges, Background, Connection, ConnectionMode, Controls, Edge, EdgeChange, Handle,
  MarkerType, MiniMap, Node, NodeChange, NodeProps, NodeResizer, Position, ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, CanvasData, CanvasEdge, CanvasNode, ContentFormat, MagicJob, Project } from "./api";

const NODE_LABELS: Record<string, string> = {
  idea: "想法", brief: "简报", note: "笔记", knowledge: "知识", fact: "事实",
  signal: "信号", internal_knowledge: "内部知识", insight: "洞察", challenge: "质疑",
  creative_pattern: "创意模式", content_concept: "内容概念", output: "内容输出", frame: "分组",
};
const STATUS_LABELS: Record<string, string> = {
  exploring: "探索中", candidate: "候选", approved: "已批准", locked: "已锁定",
};

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
    <NodeResizer isVisible={selected} minWidth={220} minHeight={140} onResizeEnd={(_, size) => data.onResizeCommit(node.id, size.width, size.height)} />
    {node.type !== "frame" && <>
      <Handle id="top" type="source" position={Position.Top} className="connection-handle handle-top" />
      <Handle id="right" type="source" position={Position.Right} className="connection-handle handle-right" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="connection-handle handle-bottom" />
      <Handle id="left" type="source" position={Position.Left} className="connection-handle handle-left" />
    </>}
    <div className="node-head"><span>{NODE_LABELS[node.type] ?? node.type}</span>{node.locked && <b>已锁定</b>}</div>
    <h3>{node.title}</h3>
    {node.type !== "frame" && (editing ?
      <textarea className="flow-card-editor nodrag nowheel" autoFocus aria-label={`编辑${node.title}的 Markdown 正文`}
        value={draft} onChange={(event) => setDraft(event.target.value)}
        onPointerDown={(event) => event.stopPropagation()}
        onBlur={() => { if (cancelBlur.current) { cancelBlur.current = false; return; } finishEdit(true); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); cancelBlur.current = true; setDraft(node.body); setEditing(false); }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.blur(); }
        }} /> :
      <div className="flow-card-body nodrag" title={node.locked ? "点击展开完整内容" : "双击直接编辑 Markdown"}
        onDoubleClick={(event) => { event.stopPropagation(); if (!node.locked) { cancelBlur.current = false; setDraft(node.body); setEditing(true); } }}>
        {node.summary ? <p className="flow-card-summary">{node.summary}</p> :
          <span className="flow-card-placeholder">{node.body ? data.summarizing ? "模型正在总结…" : "模型摘要待生成" : "双击输入 Markdown…"}</span>}
      </div>)}
    {node.type !== "frame" && !!node.body && !editing && <button type="button" className="flow-card-expand nodrag"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); data.onExpand(node.id); }}>展开全文</button>}
    <div className="node-foot"><span>{STATUS_LABELS[node.status] ?? node.status}</span>{(node.metadata?.evidence?.length ?? 0) > 0 && <span>{node.metadata?.evidence?.length} 条证据</span>}</div>
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
    zIndex: node.type === "frame" ? -1 : 2,
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
  return <div className="empty-state"><strong>请先创建或选择一个项目</strong><p>项目会保存想法、研究、白板节点和最终内容资产。</p></div>;
}

function PageHeader({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }) {
  return <header className="page-header"><div><small>内容白板</small><h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</header>;
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
  type Draft = { magic: string; negative: string; type: string; web: boolean; format: string; duration: number; depth: number };
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftKey = `${project?.id ?? ""}:${[...selectedIds].sort().join("|")}`;
  const [defaultFormat, setDefaultFormat] = useState("wechat");
  const draft: Draft = drafts[draftKey] ?? { magic: "", negative: "", type: "insight", web: false, format: defaultFormat, duration: 90, depth: 6 };
  const updateDraft = (changes: Partial<Draft>) => setDrafts((current) => ({ ...current, [draftKey]: { ...(current[draftKey] ?? draft), ...changes } }));
  const magic = draft.magic;
  const magicNegativePrompt = draft.negative;
  const magicType = draft.type;
  const webSearch = draft.web;
  const contentFormat = draft.format;
  const contentDuration = draft.duration;
  const upstreamDepth = draft.depth;
  const [busy, setBusy] = useState(false);
  const [magicJobs, setMagicJobs] = useState<MagicJob[]>([]);
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
        const jobs = await api.listMagicJobs(projectId);
        if (!active) return;
        setMagicJobs(jobs);
        const finished = jobs.filter((job) => job.status === "completed" && !completedJobsRef.current.has(job.job_id));
        finished.forEach((job) => completedJobsRef.current.add(job.job_id));
        if (finished.length) await refreshJobsRef.current();
      } catch (error) { if (active) statusJobsRef.current(`读取白板任务失败：${errorText(error)}`); }
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
    }).catch((error) => setStatus(`读取输出形态失败：${errorText(error)}`));
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
    setStatus("Markdown 内容已更新，正在自动保存");
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
    setStatus("节点大小已更新，正在自动保存");
  }, [setStatus]);

  const onMoveEnd = useCallback((_: unknown, viewport: { x: number; y: number; zoom: number }) => {
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
      setStatus(`模型摘要暂不可用：${errorText(error)}。仍可展开查看完整正文。`);
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
    setStatus("已撤回上一步操作");
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
    setStatus("已重做上一步操作");
  }

  function addNote() {
    const board = boardRef.current;
    if (!board) return;
    const offset = board.nodes.length % 8;
    const node: CanvasNode = {
      id: `nod_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "note", title: "新笔记", body: "", status: "exploring",
      locked: false, x: 220 + offset * 34, y: 160 + offset * 28, width: 340, height: 210,
      metadata: {}, created_by: "user", project_id: board.project_id, canvas_id: board.id,
    };
    commit({ ...board, nodes: [...board.nodes, node] }, "已添加新节点；可从上下左右连接点拖出有向连线");
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
      setStatus("选中的节点已锁定，不能删除");
      return;
    }
    commit({ ...board, nodes: keptNodes, edges: keptEdges }, "已删除选中内容，可使用 Ctrl+Z 撤回");
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
      type: "frame", title: "内容分组", body: "", status: "exploring", locked: false,
      x, y, width, height, metadata: { member_ids: selectedIds }, created_by: "user",
      project_id: board.project_id, canvas_id: board.id,
    };
    commit({ ...board, nodes: [frame, ...board.nodes] }, "已创建内容分组；选中分组后可综合加工成员节点");
    setSelectedIds([frame.id]);
  }

  function duplicateSelection() {
    const board = boardRef.current;
    if (!board) return;
    const copies = board.nodes.filter((node) => selectedIds.includes(node.id) && node.type !== "frame").map((node) => ({
      ...cloneCanvas({ ...board, nodes: [node], edges: [] }).nodes[0],
      id: `nod_${crypto.randomUUID().replaceAll("-", "")}`,
      title: `${node.title}（副本）`, x: node.x + 36, y: node.y + 36, locked: false,
    }));
    if (!copies.length) return;
    commit({ ...board, nodes: [...board.nodes, ...copies] }, "已复制选中节点");
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
      if (command && event.key.toLowerCase() === "s") { event.preventDefault(); setStatus("白板会自动保存，无需手动保存"); return; }
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

  if (!project) return <><PageHeader title="把研究变成可持续积累的内容资产" description="节点、证据、分支和内容输出都保存在同一个项目中。" /><EmptyProject /></>;
  if (!canvas) return <div className="empty-state">正在加载白板…</div>;

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
    setStatus("节点位置和连接线路由已更新，正在自动保存");
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
    commit({ ...board, edges: board.edges.filter((edge) => !removed.has(edge.id)) }, "已删除连接线");
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
    commit({ ...board, edges: [...board.edges, edge] }, "已创建有向关系：上游内容将作为下游节点的生成上下文");
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
        type: "frame", title: group.title, body: "", status: "exploring", locked: false,
        x: group.x, y: group.y, width: 730, height: frameHeight,
        metadata: { auto_group: true, group_key: group.key }, created_by: "system",
        project_id: current.project_id, canvas_id: current.id,
      });
    }
    const unplaced = regular.filter((node) => !placed.has(node.id)).map((node, index) => ({
      ...node, x: 820 + (index % 2) * 340, y: frameHeight + 120 + Math.floor(index / 2) * 260,
    }));
    const next = rerouteEdges({ ...current, nodes: [...frames, ...userFrames, ...arranged, ...unplaced] });
    commit(next, "已按节点类型分组，并自动重排有向连接线");
  }

  function organizeConnections() {
    const current = boardRef.current;
    if (!current) return;
    commit(rerouteEdges(current), "已按节点相对位置重新规划连接线");
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
    if (!inputs.length) { setStatus("分组中没有可加工的节点"); return; }
    const submittedDraftKey = draftKey;
    setSubmittingMagic(true);
    try {
      if (beforeGenerate) await beforeGenerate(); else await api.saveCanvas(activeProject.id, boardRef.current!);
      const job = await api.startMagic(activeProject.id, inputs, magicType === "output" && !magic.trim() ? "结合节点内容生成草稿" : magic,
        magicType, magicNegativePrompt, magicType === "insight" && webSearch, contentFormat, contentDuration, upstreamDepth);
      setMagicJobs((current) => [job, ...current.filter((item) => item.job_id !== job.job_id)]);
      setStatus(`已启动生成任务：${job.job_id}`);
      setDrafts((current) => { const next = { ...current }; delete next[submittedDraftKey]; return next; });
    } catch (error) { setStatus(errorText(error)); } finally { setSubmittingMagic(false); }
  }

  async function cancelMagic(jobId: string) {
    try {
      const cancelled = await api.cancelMagicJob(jobId);
      setMagicJobs((current) => current.map((item) => item.job_id === jobId ? cancelled : item));
      setStatus("任务已取消，不会生成下游节点");
    } catch (error) { setStatus(`取消任务失败：${errorText(error)}`); }
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
    <PageHeader title={activeProject.name} description="用有向连接组织上下文；下游生成会自动继承全部上游内容。" actions={<>
      <button className="secondary" disabled={!undoStack.current.length} onClick={undo} title="Ctrl+Z">撤回</button>
      <button className="secondary" disabled={!redoStack.current.length} onClick={redo} title="Ctrl+Shift+Z / Ctrl+Y">重做</button>
      <button className="secondary" onClick={addNote} title="N">添加节点</button>
      <button className="secondary" disabled={!selectedIds.length && !selectedEdgeIds.length} onClick={deleteSelection} title="Delete">删除</button>
      <button className="secondary" disabled={selected.length < 2} onClick={createGroup}>创建分组</button>
      <button className="secondary" onClick={organizeConnections}>整理连线</button>
      <button className="secondary" onClick={organizeCanvas}>按类型整理</button>
    </>} />
    <div className="canvas-shortcuts"><span>卡片显示模型摘要，点击展开全文</span><span>双击正文编辑 Markdown</span><span>四向端口拖出有向连线</span><span>框选或 Ctrl 多选</span><span>Ctrl+Z 撤回</span><span>Delete 删除</span><span>N 新建节点</span></div>
    <div className="canvas-workspace flow-workspace">
      <section className="board-wrap">
        <ReactFlow
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
          panOnDrag={[1, 2]}
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
        <div className="inspector-title"><div><small>{NODE_LABELS[primary.type] ?? primary.type}</small><h2>节点详情</h2></div><button className="icon-button danger" disabled={primary.locked} onClick={deleteSelection}>删除</button></div>
        <label>标题<input disabled={primary.locked} value={primary.title} onChange={(event) => updateLocal(primary.id, { title: event.target.value })} /></label>
        <label>正文<textarea disabled={primary.locked} value={primary.body} onChange={(event) => updateLocal(primary.id, { body: event.target.value })} /></label>
        {primary.type !== "frame" && !!primary.body && <div className="node-summary-inspector"><strong>卡片模型摘要</strong><p>{primary.summary || (summaryInFlight === primary.id ? "正在生成摘要…" : "尚未生成摘要")}</p><button className="secondary" disabled={!!summaryInFlight} onClick={() => { summaryBlockedRef.current = false; void generateSummary(primary, true); }}>{summaryInFlight === primary.id ? "生成中…" : "重新生成摘要"}</button></div>}
        {Array.isArray(primary.metadata?.source_node_ids) && <div className="source-panel"><strong>加工来源</strong><p>由 {(primary.metadata.source_node_titles as string[] | undefined)?.join("、") || (primary.metadata.source_node_ids as string[]).join("、")} 联合加工生成</p><small>来源节点 ID：{(primary.metadata.source_node_ids as string[]).join("、")}</small>{Array.isArray(primary.metadata.inherited_upstream_ids) && primary.metadata.inherited_upstream_ids.length > 0 && <p>额外继承 {(primary.metadata.inherited_upstream_ids as string[]).length} 个上游节点</p>}</div>}
        {primary.type === "frame" && Array.isArray(primary.metadata.member_ids) && <div className="source-panel"><strong>分组成员</strong><p>包含 {(primary.metadata.member_ids as string[]).length} 个节点；输入处理要求可生成新的下游节点。</p></div>}
        <label>状态<select disabled={primary.locked} value={primary.status} onChange={(event) => updateLocal(primary.id, { status: event.target.value })}><option value="exploring">探索中</option><option value="candidate">候选</option><option value="approved">已批准</option></select></label>
        <label className="switch-row"><span><strong>锁定节点</strong><small>锁定后不能修改内容或删除</small></span><input type="checkbox" checked={primary.locked} onChange={(event) => updateLocal(primary.id, { locked: event.target.checked, status: event.target.checked ? "locked" : primary.status === "locked" ? "candidate" : primary.status })} /></label>
        {primary.type === "output" && <div className="asset-save-panel"><strong>{primary.metadata?.asset_id ? "已关联内容资产" : "仍是白板草稿"}</strong><p>先在上方直接修改，确认后再保存到内容资产；再次保存会生成新版本。</p><button className="primary" disabled={busy || primary.locked} onClick={saveAsAsset}>{busy ? "正在保存…" : primary.metadata?.asset_id ? "更新内容资产" : "保存到内容资产"}</button></div>}
        {primary.type === "output" && <details className="source-panel"><summary>查看生成形态与 Prompt</summary><p>输出形态：{String(primary.metadata?.format_name || primary.metadata?.format || "未记录")}</p><p>正向要求：{String(primary.metadata?.instruction || "未单独填写")}</p><p>负向要求：{String(primary.metadata?.negative_prompt || "未单独填写")}</p><p>形态默认要求：{String(primary.metadata?.format_positive_prompt || "未记录")}</p><p>形态避免事项：{String(primary.metadata?.format_negative_prompt || "未记录")}</p></details>}
        {!!primary.metadata?.evidence?.length && <div className="evidence-panel"><h3>证据</h3>{primary.metadata.evidence.map((item, index) => <details key={`${item.chunk_id}-${index}`}><summary>{item.title || item.path}</summary><small>{item.path}｜{item.heading?.join(" › ")}</small><p>{item.excerpt}</p>{item.references?.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}</details>)}</div>}
        {Array.isArray(primary.metadata?.web_sources) && primary.metadata.web_sources.length > 0 && <div className="evidence-panel"><h3>网络资料</h3>{(primary.metadata.web_sources as Array<{ title: string; url: string; excerpt: string }>).map((item, index) => <details key={`${item.url}-${index}`}><summary>{item.title || item.url}</summary><p>{item.excerpt}</p>{item.url && <a href={item.url} target="_blank" rel="noreferrer">查看来源</a>}</details>)}</div>}
      </> : <div className="inspector-empty"><strong>{selected.length > 1 ? `已选择 ${selected.length} 个节点` : selectedEdgeIds.length ? `已选择 ${selectedEdgeIds.length} 条连接` : "选择一个节点"}</strong><p>{selected.length > 1 ? "可以将多个节点综合为一个新的下游节点。" : "从任一节点的上下左右端口拖到另一个节点，即可创建有向连接。"}</p></div>}</div>
        {!!selectedIds.length && <section className="ai-copilot">
          <div className="ai-copilot-head"><div><small>AI 共创</small><h3>{selectedIds.length === 1 && primary?.type !== "frame" ? "由当前节点生成下游" : "综合多个节点"}</h3></div><span>{selectedIds.length} 个选中节点</span></div>
          <label>可继承的上游节点层级<select value={upstreamDepth} onChange={(event) => updateDraft({ depth: Number(event.target.value) })}><option value={0}>不继承</option><option value={1}>仅上游一层</option><option value={2}>上游两层</option><option value={3}>上游三层</option><option value={6}>上游六层（默认）</option><option value={12}>上游十二层</option></select></label>
          <p className="context-note">{inheritedIds.length ? `当前选中的层级将继承 ${inheritedIds.length} 个上游节点。` : "当前层级没有可继承的上游节点。"} 原节点保留；结果进入新的下游节点并标注加工来源。</p>
          <label>新节点类型<select value={magicType} onChange={(event) => updateDraft({ type: event.target.value })}><option value="insight">洞察</option><option value="challenge">质疑</option><option value="creative_pattern">创意模式</option><option value="note">笔记</option><option value="output">内容输出</option></select></label>
          {magicType === "insight" && <label className="check"><input type="checkbox" checked={webSearch} onChange={(event) => updateDraft({ web: event.target.checked })} />检索网络资料（通过设置的搜索 MCP，并与 Wiki 资料综合）</label>}
          {magicType === "output" && <><label>内容输出形态<select value={contentFormat} onChange={(event) => updateDraft({ format: event.target.value })}>{contentFormats.map((format) => <option key={format.id} value={format.id}>{format.name}</option>)}</select></label>{contentFormat === "video_script" && <label>目标时长（秒）<input type="number" min="15" max="600" value={contentDuration} onChange={(event) => updateDraft({ duration: Number(event.target.value) })} /></label>}<p className="context-note">默认 Prompt 在“设置 → 内容输出形态与 Prompt”中配置，此处填写本次加工要求。</p></>}
          <label>{magicType === "output" ? "正向 Prompt（要做的事情）" : "处理要求"}<textarea value={magic} onChange={(event) => updateDraft({ magic: event.target.value })} placeholder="例如：结合上游证据补充案例，调整为更有节奏的表达，并保留事实边界。" /></label>
          {magicType === "output" && <label>负向 Prompt（不要做的事情）<textarea value={magicNegativePrompt} onChange={(event) => updateDraft({ negative: event.target.value })} placeholder="例如：不要编造案例；不要使用夸张标题；不要忽略证据不足的部分。" /></label>}
          {magicJobs.filter((job) => job.status === "running" && job.node_ids.some((id) => selectedIds.includes(id))).map((job) => <div className="ai-progress" role="status" key={job.job_id}><span className="ai-progress-spinner" />{job.phase} · {job.progress}% · {job.detail}</div>)}
          <button className="primary ai-run" disabled={submittingMagic || (magicType === "output" ? !contentFormat : !magic.trim()) || magicJobs.some((job) => job.status === "running" && job.node_ids.length === selectedIds.length && job.node_ids.every((id) => selectedIds.includes(id)))} onClick={runMagic}>{submittingMagic ? "正在提交…" : magicType === "output" ? "生成内容输出节点" : "AI 加工并生成下游节点"}</button>
        </section>}
      </aside>
    </div>
    <section className="canvas-task-monitor" aria-label="AI 任务状态">
      <strong>AI 任务监测 · 正在生成 {magicJobs.filter((job) => job.status === "running").length} 个任务</strong>
      <div className="canvas-task-list">{magicJobs.slice(0, 6).map((job) => <div className={`canvas-task ${job.status}`} key={job.job_id}>
        <span>{job.node_ids.map((id) => board.nodes.find((node) => node.id === id)?.title || "节点已删除").join("、")}</span>
        <span>{job.phase} · {job.progress}%</span>
        {job.status === "running" && <button className="text-button danger" onClick={() => void cancelMagic(job.job_id)}>取消</button>}
        {job.status === "completed" && job.result?.node && <button className="text-button" onClick={() => setSelectedIds([job.result!.node.id])}>定位结果</button>}
        {job.status === "failed" && <small title={job.error || job.detail}>{job.error || job.detail}</small>}
        <div className="canvas-task-track"><i style={{ width: `${job.progress}%` }} /></div>
      </div>)}</div>
      {!magicJobs.length && <span>暂无生成任务</span>}
    </section>
    {expandedNodeId && (() => {
      const expanded = board.nodes.find((node) => node.id === expandedNodeId);
      return expanded ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setExpandedNodeId(""); }}>
        <section className="node-full-content" role="dialog" aria-modal="true" aria-label={`${expanded.title}的完整内容`}>
          <header><div><small>{NODE_LABELS[expanded.type] ?? expanded.type} · 完整内容</small><h2>{expanded.title}</h2></div><button className="secondary" onClick={() => setExpandedNodeId("")}>收起全文</button></header>
          {expanded.summary && <p className="node-full-summary"><strong>模型摘要</strong>{expanded.summary}</p>}
          <div className="node-full-markdown"><Markdown>{expanded.body}</Markdown></div>
        </section>
      </div> : null;
    })()}
  </div>;
}
