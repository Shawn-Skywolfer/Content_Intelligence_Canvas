import { useEffect, useRef, useState } from "react";
import {
  Background, Connection, Controls, Edge, EdgeChange, Handle, MarkerType, MiniMap, Node,
  NodeChange, NodeProps, Position, ReactFlow, applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, CanvasData, CanvasEdge, CanvasNode, Project } from "./api";

const NODE_LABELS: Record<string, string> = {
  idea: "想法", brief: "简报", note: "笔记", knowledge: "知识", fact: "事实",
  signal: "信号", internal_knowledge: "内部知识", insight: "洞察", challenge: "质疑",
  creative_pattern: "创意模式", content_concept: "内容概念", output: "内容输出", frame: "分组",
};
const STATUS_LABELS: Record<string, string> = {
  exploring: "探索中", candidate: "候选", approved: "已批准", locked: "已锁定",
};

type FlowNodeData = Record<string, unknown> & { canvasNode: CanvasNode };
type FlowNode = Node<FlowNodeData, "canvas">;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneCanvas(canvas: CanvasData): CanvasData {
  return structuredClone(canvas);
}

function FlowCard({ data, selected }: NodeProps<FlowNode>) {
  const node = data.canvasNode;
  return <article className={`flow-card node-${node.type} ${selected ? "selected" : ""} ${node.locked ? "locked" : ""}`}>
    {node.type !== "frame" && <Handle type="target" position={Position.Left} className="connection-handle" />}
    <div className="node-head"><span>{NODE_LABELS[node.type] ?? node.type}</span>{node.locked && <b>已锁定</b>}</div>
    <h3>{node.title}</h3>
    {node.type !== "frame" && <p>{node.body}</p>}
    <div className="node-foot"><span>{STATUS_LABELS[node.status] ?? node.status}</span>{(node.metadata.evidence?.length ?? 0) > 0 && <span>{node.metadata.evidence?.length} 条证据</span>}</div>
    {node.type !== "frame" && <Handle type="source" position={Position.Right} className="connection-handle" />}
  </article>;
}

const NODE_TYPES = { canvas: FlowCard };

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
  const [, setHistoryRevision] = useState(0);
  const undoStack = useRef<CanvasData[]>([]);
  const redoStack = useRef<CanvasData[]>([]);
  const boardRef = useRef<CanvasData | null>(canvas);
  const dragSnapshotTaken = useRef(false);

  useEffect(() => { boardRef.current = canvas; }, [canvas]);
  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    setSelectedEdgeIds([]);
    setHistoryRevision((value) => value + 1);
  }, [project?.id]);

  function applyWithoutHistory(next: CanvasData) {
    boardRef.current = next;
    onChange(next);
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
      type: "note", title: "新笔记", body: "在右侧节点检查器中编辑内容。", status: "exploring",
      locked: false, x: 220 + offset * 34, y: 160 + offset * 28, width: 340, height: 210,
      metadata: {}, created_by: "user", project_id: board.project_id, canvas_id: board.id,
    };
    commit({ ...board, nodes: [...board.nodes, node] }, "已添加新节点；可拖动左右连接点创建关系");
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
  const flowNodes: FlowNode[] = board.nodes.map((node) => ({
    id: node.id,
    type: "canvas",
    position: { x: node.x, y: node.y },
    data: { canvasNode: node },
    selected: selectedIds.includes(node.id),
    draggable: true,
    selectable: true,
    zIndex: node.type === "frame" ? -1 : 2,
    style: { width: node.width, minHeight: node.height },
  }));
  const flowEdges: Edge[] = board.edges.map((edge) => ({
    id: edge.id,
    source: edge.source_node_id,
    target: edge.target_node_id,
    type: "smoothstep",
    selected: selectedEdgeIds.includes(edge.id),
    markerEnd: { type: MarkerType.ArrowClosed },
  }));

  function onNodesChange(changes: NodeChange<FlowNode>[]) {
    const movement = changes.filter((change) => change.type === "position" || change.type === "dimensions");
    if (!movement.length) return;
    const updated = applyNodeChanges(movement, flowNodes);
    const byId = new Map(updated.map((node) => [node.id, node]));
    applyWithoutHistory({
      ...board,
      nodes: board.nodes.map((node) => {
        const changed = byId.get(node.id);
        return changed ? { ...node, x: changed.position.x, y: changed.position.y } : node;
      }),
    });
  }

  function onEdgesChange(changes: EdgeChange<Edge>[]) {
    const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
    if (!removed.size) return;
    commit({ ...board, edges: board.edges.filter((edge) => !removed.has(edge.id)) }, "已删除连接线");
  }

  function onConnect(connection: Connection) {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    if (board.edges.some((edge) => edge.source_node_id === connection.source && edge.target_node_id === connection.target)) return;
    const edge: CanvasEdge = {
      id: `edg_${crypto.randomUUID().replaceAll("-", "")}`,
      source_node_id: connection.source,
      target_node_id: connection.target,
      relation: "context",
      metadata: {},
    };
    commit({ ...board, edges: [...board.edges, edge] }, "已通过拖拽创建节点关系");
  }

  function updateLocal(id: string, values: Partial<CanvasNode>) {
    commit({ ...board, nodes: board.nodes.map((node) => node.id === id ? { ...node, ...values } : node) });
  }

  async function runMagic() {
    if (!magic.trim() || !selectedIds.length) return;
    setBusy(true);
    try {
      const result = await api.magic(activeProject.id, selectedIds, magic, magicType);
      setStatus(result.message); setMagic(""); await onRefresh(); setSelectedIds(result.nodes.map((node) => node.id));
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

  return <div className="canvas-page">
    <PageHeader title={activeProject.name} description="拖拽布局和连接观点；支持撤回、重做、多选、快捷键与自动保存。" actions={<>
      <button className="secondary" disabled={!undoStack.current.length} onClick={undo} title="Ctrl+Z">撤回</button>
      <button className="secondary" disabled={!redoStack.current.length} onClick={redo} title="Ctrl+Shift+Z / Ctrl+Y">重做</button>
      <button className="secondary" onClick={addNote} title="N">添加节点</button>
      <button className="secondary" disabled={!selectedIds.length && !selectedEdgeIds.length} onClick={deleteSelection} title="Delete">删除</button>
      <button className="secondary" disabled={selected.length < 2} onClick={createGroup}>创建分组</button>
    </>} />
    <div className="canvas-shortcuts"><span>拖动节点移动</span><span>从圆点拖出连线</span><span>框选或 Ctrl 多选</span><span>Ctrl+Z 撤回</span><span>Delete 删除</span><span>N 新建节点</span></div>
    <div className="canvas-workspace flow-workspace">
      <section className="board-wrap">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStart={() => { if (!dragSnapshotTaken.current) { pushUndoSnapshot(); dragSnapshotTaken.current = true; } }}
          onNodeDragStop={() => { dragSnapshotTaken.current = false; setStatus("节点位置已更新，正在自动保存"); }}
          onSelectionChange={({ nodes, edges }) => { setSelectedIds(nodes.map((node) => node.id)); setSelectedEdgeIds(edges.map((edge) => edge.id)); }}
          onMoveEnd={(_, viewport) => applyWithoutHistory({ ...boardRef.current!, viewport })}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.05 }}
          minZoom={0.2}
          maxZoom={1.8}
          selectionOnDrag
          panOnDrag={[1, 2]}
          multiSelectionKeyCode={["Control", "Meta"]}
          deleteKeyCode={null}
          snapToGrid
          snapGrid={[10, 10]}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed } }}
        >
          <Background gap={20} size={1} color="#dfe4ea" />
          <MiniMap pannable zoomable nodeColor={(node) => (node.data as FlowNodeData).canvasNode.type === "insight" ? "#c7000b" : "#9aa5b4"} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </section>
      <aside className="inspector">{primary ? <>
        <div className="inspector-title"><div><small>{NODE_LABELS[primary.type] ?? primary.type}</small><h2>节点检查器</h2></div><button className="icon-button danger" disabled={primary.locked} onClick={deleteSelection}>删除</button></div>
        <label>标题<input disabled={primary.locked} value={primary.title} onChange={(event) => updateLocal(primary.id, { title: event.target.value })} /></label>
        <label>正文<textarea disabled={primary.locked} value={primary.body} onChange={(event) => updateLocal(primary.id, { body: event.target.value })} /></label>
        <label>状态<select disabled={primary.locked} value={primary.status} onChange={(event) => updateLocal(primary.id, { status: event.target.value })}><option value="exploring">探索中</option><option value="candidate">候选</option><option value="approved">已批准</option></select></label>
        <label className="switch-row"><span><strong>锁定节点</strong><small>锁定后不能修改内容或删除</small></span><input type="checkbox" checked={primary.locked} onChange={(event) => updateLocal(primary.id, { locked: event.target.checked, status: event.target.checked ? "locked" : primary.status === "locked" ? "candidate" : primary.status })} /></label>
        {!!primary.metadata.evidence?.length && <div className="evidence-panel"><h3>证据</h3>{primary.metadata.evidence.map((item, index) => <details key={`${item.chunk_id}-${index}`}><summary>{item.title || item.path}</summary><small>{item.path}｜{item.heading?.join(" › ")}</small><p>{item.excerpt}</p>{item.references?.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}</details>)}</div>}
      </> : <div className="inspector-empty"><strong>{selected.length > 1 ? `已选择 ${selected.length} 个节点` : selectedEdgeIds.length ? `已选择 ${selectedEdgeIds.length} 条连接` : "选择一个节点"}</strong><p>{selected.length > 1 ? "可以创建分组、复制、删除或用智能加工栏处理。" : "从节点边缘的圆点拖到另一个节点，即可创建连接。"}</p></div>}</aside>
    </div>
    {!!selectedIds.length && <div className="magic-bar"><span>已选择 {selectedIds.length} 项</span><select value={magicType} onChange={(event) => setMagicType(event.target.value)}><option value="insight">生成洞察</option><option value="challenge">保存质疑</option><option value="creative_pattern">保存创意模式</option><option value="note">生成笔记</option></select><input value={magic} onChange={(event) => setMagic(event.target.value)} placeholder="例如：找出这些信息里的矛盾，并形成一个核心判断" onKeyDown={(event) => { if (event.key === "Enter") runMagic(); }} /><button className="secondary" disabled={busy} onClick={concept}>形成内容概念</button><button className="primary" disabled={busy || !magic.trim()} onClick={runMagic}>{busy ? "处理中…" : "用大模型加工"}</button></div>}
  </div>;
}
