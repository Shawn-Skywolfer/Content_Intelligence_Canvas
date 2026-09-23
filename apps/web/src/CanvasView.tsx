import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import {
  applyNodeChanges, Background, Connection, ConnectionMode, Controls, Edge, EdgeChange, Handle,
  MarkerType, MiniMap, Node, NodeChange, NodeProps, Position, ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, CanvasData, CanvasEdge, CanvasNode, ContentJob, Project } from "./api";

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
      <div className="flow-card-body nodrag" title={node.locked ? "节点已锁定" : "双击直接编辑 Markdown"}
        onDoubleClick={(event) => { event.stopPropagation(); if (!node.locked) { cancelBlur.current = false; setDraft(node.body); setEditing(true); } }}>
        {node.body ? <Markdown>{node.body}</Markdown> : <span className="flow-card-placeholder">双击输入 Markdown…</span>}
      </div>)}
    <div className="node-foot"><span>{STATUS_LABELS[node.status] ?? node.status}</span>{(node.metadata?.evidence?.length ?? 0) > 0 && <span>{node.metadata?.evidence?.length} 条证据</span>}</div>
  </article>;
}

const NODE_TYPES = { canvas: FlowCard };
const FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1.05 };
const MULTI_SELECTION_KEYS = ["Control", "Meta"];
const SNAP_GRID: [number, number] = [10, 10];
const PRO_OPTIONS = { hideAttribution: true };
const DEFAULT_EDGE_OPTIONS = {
  type: "smoothstep",
  markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
  pathOptions: { borderRadius: 14, offset: 28 },
};

const GROUPS = [
  { key: "input", title: "01 输入与简报", types: ["idea", "brief"], x: 40, y: 40 },
  { key: "research", title: "02 研究与证据", types: ["knowledge", "fact", "signal", "internal_knowledge"], x: 800, y: 40 },
  { key: "thinking", title: "03 洞察与策略", types: ["insight", "challenge", "creative_pattern", "content_concept"], x: 40, y: 680 },
  { key: "output", title: "04 内容生产", types: ["note", "output"], x: 800, y: 680 },
];

function toFlowNodes(nodes: CanvasNode[], edges: CanvasEdge[], selectedIds: string[], onBodyCommit: FlowNodeData["onBodyCommit"]): FlowNode[] {
  const selected = new Set(selectedIds);
  const upstream = new Set(edges.filter((edge) => selected.has(edge.target_node_id)).map((edge) => edge.source_node_id));
  const downstream = new Set(edges.filter((edge) => selected.has(edge.source_node_id)).map((edge) => edge.target_node_id));
  return nodes.map((node) => ({
    id: node.id,
    type: "canvas",
    position: { x: node.x, y: node.y },
    data: { canvasNode: node, relationship: selected.has(node.id) ? null : upstream.has(node.id) ? "upstream" : downstream.has(node.id) ? "downstream" : null, onBodyCommit },
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

function upstreamIds(board: CanvasData, targetIds: string[]): string[] {
  const target = new Set(targetIds);
  const found = new Set<string>();
  let frontier = [...targetIds];
  while (frontier.length) {
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

export default function CanvasView({ project, canvas, selectedIds, setSelectedIds, onChange, onRefresh, setStatus }: {
  project: Project | null;
  canvas: CanvasData | null;
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  onChange: (canvas: CanvasData) => void;
  onRefresh: () => Promise<void>;
  setStatus: (value: string) => void;
}) {
  const [magic, setMagic] = useState("");
  const [magicType, setMagicType] = useState("insight");
  const [busy, setBusy] = useState(false);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [contentFormat, setContentFormat] = useState<"wechat" | "video_script" | "poster_campaign">("wechat");
  const [contentTitle, setContentTitle] = useState("");
  const [contentInstruction, setContentInstruction] = useState("");
  const [contentDuration, setContentDuration] = useState(90);
  const [contentUseLlm, setContentUseLlm] = useState(true);
  const [contentJob, setContentJob] = useState<ContentJob | null>(null);
  const [displayNodes, setDisplayNodes] = useState<FlowNode[]>([]);
  const [, setHistoryRevision] = useState(0);
  const undoStack = useRef<CanvasData[]>([]);
  const redoStack = useRef<CanvasData[]>([]);
  const boardRef = useRef<CanvasData | null>(canvas);
  const displayNodesRef = useRef<FlowNode[]>([]);
  const onChangeRef = useRef(onChange);
  const draggingRef = useRef(false);
  const selectedNodeIdsRef = useRef(selectedIds);
  const selectedEdgeIdsRef = useRef(selectedEdgeIds);

  const onBodyCommit = useCallback((id: string, body: string) => {
    const current = boardRef.current;
    const node = current?.nodes.find((item) => item.id === id);
    if (!current || !node || node.locked || node.body === body) return;
    undoStack.current = [...undoStack.current.slice(-79), cloneCanvas(current)];
    redoStack.current = [];
    setHistoryRevision((value) => value + 1);
    const next = { ...current, nodes: current.nodes.map((item) => item.id === id ? { ...item, body } : item) };
    boardRef.current = next;
    onChangeRef.current(next);
    setStatus("Markdown 内容已更新，正在自动保存");
  }, [setStatus]);

  const onSelectionChange = useCallback(({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
    const nextNodeIds = nodes.map((node) => node.id);
    const nextEdgeIds = edges.map((edge) => edge.id);
    if (!sameSelection(selectedNodeIdsRef.current, nextNodeIds)) {
      selectedNodeIdsRef.current = nextNodeIds;
      setSelectedIds(nextNodeIds);
    }
    if (!sameSelection(selectedEdgeIdsRef.current, nextEdgeIds)) {
      selectedEdgeIdsRef.current = nextEdgeIds;
      setSelectedEdgeIds(nextEdgeIds);
    }
  }, [setSelectedIds]);

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
    const next = toFlowNodes(canvas.nodes, canvas.edges, selectedIds, onBodyCommit);
    displayNodesRef.current = next;
    setDisplayNodes(next);
  }, [canvas, selectedIds, onBodyCommit]);
  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    setSelectedEdgeIds([]);
    setHistoryRevision((value) => value + 1);
  }, [project?.id]);

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
    const keptNodes = board.nodes.filter((node) => !removable.has(node.id));
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
    commit({ ...board, nodes: [frame, ...board.nodes] }, "已创建内容分组");
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
  const inheritedIds = upstreamIds(board, selectedIds);
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
    type: "smoothstep",
    className: selectedIds.includes(edge.source_node_id) || selectedIds.includes(edge.target_node_id) ? "edge-related" : "",
    selected: selectedEdgeIds.includes(edge.id),
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
  }));

  function onNodesChange(changes: NodeChange<FlowNode>[]) {
    setDisplayNodes((current) => {
      const next = applyNodeChanges(changes, current);
      displayNodesRef.current = next;
      return next;
    });
  }

  function onNodeDragStart() {
    if (draggingRef.current) return;
    pushUndoSnapshot();
    draggingRef.current = true;
  }

  function onNodeDragStop() {
    const current = boardRef.current;
    if (!current) return;
    const positions = new Map(displayNodesRef.current.map((node) => [node.id, node.position]));
    const moved = current.nodes.map((node) => {
      const position = positions.get(node.id);
      return position ? { ...node, x: position.x, y: position.y } : node;
    });
    const next = rerouteEdges({ ...current, nodes: moved });
    draggingRef.current = false;
    applyWithoutHistory(next);
    setStatus("节点位置和连接线路由已更新，正在自动保存");
  }

  function onEdgesChange(changes: EdgeChange<Edge>[]) {
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
    for (const group of GROUPS) {
      const members = regular.filter((node) => group.types.includes(node.type));
      members.forEach((node, index) => {
        placed.add(node.id);
        arranged.push({
          ...node,
          x: group.x + 34 + (index % 2) * 328,
          y: group.y + 76 + Math.floor(index / 2) * 220,
          width: Math.min(node.width || 300, 300),
          height: Math.max(node.height || 180, 180),
        });
      });
      const rows = Math.max(1, Math.ceil(members.length / 2));
      frames.push({
        id: `grp_${group.key}_${current.id}`,
        type: "frame", title: group.title, body: "", status: "exploring", locked: false,
        x: group.x, y: group.y, width: 700, height: Math.max(560, 108 + rows * 220),
        metadata: { auto_group: true, group_key: group.key }, created_by: "system",
        project_id: current.project_id, canvas_id: current.id,
      });
    }
    const unplaced = regular.filter((node) => !placed.has(node.id)).map((node, index) => ({
      ...node, x: 1540 + (index % 2) * 328, y: 100 + Math.floor(index / 2) * 220,
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
    commit({ ...board, nodes: board.nodes.map((node) => node.id === id ? { ...node, ...values } : node) });
  }

  async function runMagic() {
    if (!magic.trim() || !selectedIds.length) return;
    setBusy(true);
    try {
      const result = selectedIds.length === 1
        ? await api.generateIntoNode(activeProject.id, selectedIds[0], magic, true)
        : await api.magic(activeProject.id, selectedIds, magic, magicType);
      const nextIds = selectedIds.length === 1 ? [selectedIds[0]] : result.nodes.map((node) => node.id);
      setStatus(result.message); setMagic(""); await onRefresh(); setSelectedIds(nextIds);
    } catch (error) { setStatus(errorText(error)); } finally { setBusy(false); }
  }

  async function concept() {
    if (!selectedIds.length) return;
    setBusy(true);
    try {
      const result = await api.createConcept(activeProject.id, selectedIds);
      setStatus(result.message); await onRefresh(); setSelectedIds(result.nodes.map((node) => node.id));
    } catch (error) { setStatus(errorText(error)); } finally { setBusy(false); }
  }

  async function generateDraft() {
    if (!selectedIds.length) return;
    setBusy(true);
    setContentJob(null);
    try {
      let job = await api.startContentGeneration(
        activeProject.id, selectedIds, contentFormat, contentTitle, contentDuration,
        contentUseLlm, contentInstruction, false,
      );
      setContentJob(job);
      while (job.status === "running") {
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        job = await api.contentJob(job.job_id);
        setContentJob(job);
      }
      if (job.status === "failed") throw new Error(job.error || "内容生成失败");
      if (!job.result) throw new Error("内容生成已结束，但没有返回草稿");
      setStatus(job.result.message); await onRefresh(); setSelectedIds([job.result.node.id]);
    } catch (error) {
      setStatus(errorText(error));
      setContentJob((current) => current ? { ...current, status: "failed", error: errorText(error), detail: errorText(error) } : null);
    } finally { setBusy(false); }
  }

  async function saveAsAsset() {
    if (!primary || primary.type !== "output" || !boardRef.current) return;
    setBusy(true);
    try {
      await api.saveCanvas(activeProject.id, boardRef.current);
      const result = await api.saveNodeAsAsset(activeProject.id, primary.id);
      setStatus(result.message); await onRefresh(); setSelectedIds([primary.id]);
    } catch (error) { setStatus(errorText(error)); } finally { setBusy(false); }
  }

  function applyQuickInstruction(instruction: string) {
    setMagicType(primary?.type === "output" ? "output" : "insight");
    setMagic(instruction);
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
      <button className="primary" disabled={!selectedIds.length} onClick={() => { setContentJob(null); setComposerOpen(true); }}>生成新内容</button>
    </>} />
    <div className="canvas-shortcuts"><span>拖动节点移动</span><span>四向端口拖出有向连线</span><span>下游继承上游上下文</span><span>框选或 Ctrl 多选</span><span>Ctrl+Z 撤回</span><span>Delete 删除</span><span>N 新建节点</span></div>
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
          onSelectionChange={onSelectionChange}
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
        <div className="inspector-title"><div><small>{NODE_LABELS[primary.type] ?? primary.type}</small><h2>节点检查器</h2></div><button className="icon-button danger" disabled={primary.locked} onClick={deleteSelection}>删除</button></div>
        <label>标题<input disabled={primary.locked} value={primary.title} onChange={(event) => updateLocal(primary.id, { title: event.target.value })} /></label>
        <label>正文<textarea disabled={primary.locked} value={primary.body} onChange={(event) => updateLocal(primary.id, { body: event.target.value })} /></label>
        <div className="quick-edit"><small>快速加工</small><div><button className="secondary" onClick={() => applyQuickInstruction("调整表达风格，使内容更清晰、有节奏，并保留原有事实")}>调整风格</button><button className="secondary" onClick={() => applyQuickInstruction("基于现有证据补充事实、案例和具体细节；证据不足时明确指出缺口，不得编造")}>补充事实/案例</button><button className="secondary" onClick={() => applyQuickInstruction("优化结构与论证顺序，强化开头、转折和结论")}>优化结构</button></div></div>
        <label>状态<select disabled={primary.locked} value={primary.status} onChange={(event) => updateLocal(primary.id, { status: event.target.value })}><option value="exploring">探索中</option><option value="candidate">候选</option><option value="approved">已批准</option></select></label>
        <label className="switch-row"><span><strong>锁定节点</strong><small>锁定后不能修改内容或删除</small></span><input type="checkbox" checked={primary.locked} onChange={(event) => updateLocal(primary.id, { locked: event.target.checked, status: event.target.checked ? "locked" : primary.status === "locked" ? "candidate" : primary.status })} /></label>
        {primary.type === "output" && <div className="asset-save-panel"><strong>{primary.metadata?.asset_id ? "已关联内容资产" : "仍是白板草稿"}</strong><p>先在上方直接修改，确认后再保存到内容资产；再次保存会生成新版本。</p><button className="primary" disabled={busy || primary.locked} onClick={saveAsAsset}>{busy ? "正在保存…" : primary.metadata?.asset_id ? "更新内容资产" : "保存到内容资产"}</button></div>}
        {!!primary.metadata?.evidence?.length && <div className="evidence-panel"><h3>证据</h3>{primary.metadata.evidence.map((item, index) => <details key={`${item.chunk_id}-${index}`}><summary>{item.title || item.path}</summary><small>{item.path}｜{item.heading?.join(" › ")}</small><p>{item.excerpt}</p>{item.references?.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}</details>)}</div>}
      </> : <div className="inspector-empty"><strong>{selected.length > 1 ? `已选择 ${selected.length} 个节点` : selectedEdgeIds.length ? `已选择 ${selectedEdgeIds.length} 条连接` : "选择一个节点"}</strong><p>{selected.length > 1 ? "可以将多个节点综合为一个新的下游节点。" : "从任一节点的上下左右端口拖到另一个节点，即可创建有向连接。"}</p></div>}</div>
        {!!selectedIds.length && <section className="ai-copilot">
          <div className="ai-copilot-head"><div><small>AI 共创</small><h3>{selectedIds.length === 1 ? "在当前节点内生成" : "综合多个节点"}</h3></div><span>{selectedIds.length} 个选中节点</span></div>
          <p className="context-note">{inheritedIds.length ? `将自动继承 ${inheritedIds.length} 个上游节点作为上下文。` : "当前没有上游节点；可先建立有向连接补充上下文。"}{selectedIds.length === 1 ? " 生成结果会直接写入当前节点，不会另建下游节点。" : " 多选加工会生成一个新的综合节点。"}</p>
          {selectedIds.length > 1 && <label>新节点类型<select value={magicType} onChange={(event) => setMagicType(event.target.value)}><option value="insight">洞察</option><option value="challenge">质疑</option><option value="creative_pattern">创意模式</option><option value="note">笔记</option></select></label>}
          <label>处理要求<textarea value={magic} onChange={(event) => setMagic(event.target.value)} placeholder="例如：结合上游证据补充案例，调整为更有节奏的表达，并保留事实边界。" /></label>
          <button className="primary ai-run" disabled={busy || !magic.trim()} onClick={runMagic}>{busy ? "正在处理…" : selectedIds.length === 1 ? "生成到当前节点" : "综合为新节点"}</button>
          <div className="ai-secondary-actions"><button className="secondary" disabled={busy} onClick={concept}>形成内容概念</button><button className="secondary" disabled={busy} onClick={() => { setContentJob(null); setComposerOpen(true); }}>生成新内容</button></div>
        </section>}
      </aside>
    </div>
    {composerOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setComposerOpen(false); }}><section className="content-composer" role="dialog" aria-modal="true" aria-label="在白板生成新内容"><div className="composer-head"><div><small>白板内容工坊</small><h2>从选中节点生成可编辑草稿</h2><p>草稿先留在白板，修改满意后再保存到内容资产。</p></div><button className="icon-button" disabled={busy} onClick={() => setComposerOpen(false)}>关闭</button></div><div className="composer-grid"><label>内容形态<select disabled={busy} value={contentFormat} onChange={(event) => setContentFormat(event.target.value as typeof contentFormat)}><option value="wechat">微信公众号</option><option value="video_script">视频号 / 短视频脚本</option><option value="poster_campaign">海报 / 营销活动</option></select></label><label>标题（可选）<input disabled={busy} value={contentTitle} onChange={(event) => setContentTitle(event.target.value)} placeholder="留空则自动生成" /></label></div>{contentFormat === "video_script" && <label>目标时长（秒）<input disabled={busy} type="number" min="15" max="600" value={contentDuration} onChange={(event) => setContentDuration(Number(event.target.value))} /></label>}<label>风格与创作要求<textarea disabled={busy} value={contentInstruction} onChange={(event) => setContentInstruction(event.target.value)} placeholder="例如：专业但不生硬；开头用真实场景切入；增加一个有证据支持的案例；结尾给出三条行动建议。" /></label><label className="check"><input disabled={busy} type="checkbox" checked={contentUseLlm} onChange={(event) => setContentUseLlm(event.target.checked)} />使用已配置大模型</label>{contentJob && <div className={`research-progress ${contentJob.status}`}><div className="progress-heading"><div><small>实时生成进展</small><strong>{contentJob.phase}</strong></div><b>{contentJob.progress}%</b></div><div className="progress-track"><i style={{ width: `${contentJob.progress}%` }} /></div><p>{contentJob.detail}{contentJob.error ? `：${contentJob.error}` : ""}</p></div>}<div className="composer-actions"><span>选中 {selectedIds.length} 个节点，并继承 {inheritedIds.length} 个上游节点</span>{contentJob?.status === "completed" ? <button className="primary large" onClick={() => setComposerOpen(false)}>完成，返回白板</button> : <button className="primary large" disabled={busy} onClick={generateDraft}>{busy ? "正在生成…" : contentJob?.status === "failed" ? "重新生成" : "生成到白板"}</button>}</div></section></div>}
  </div>;
}
