import { useCallback, useEffect, useRef, useState } from "react";
import {
  Background, Connection, Controls, Edge, EdgeChange, Handle, MarkerType, MiniMap, Node,
  NodeChange, NodeProps, Position, ReactFlow,
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

function sameSelection(current: string[], next: string[]): boolean {
  return current.length === next.length && current.every((id) => next.includes(id));
}

function closeEnough(current: number | undefined, next: number, tolerance = 0.01): boolean {
  return typeof current === "number" && Math.abs(current - next) <= tolerance;
}

function FlowCard({ data, selected }: NodeProps<FlowNode>) {
  const node = data.canvasNode;
  return <article className={`flow-card node-${node.type} ${selected ? "selected" : ""} ${node.locked ? "locked" : ""}`}>
    {node.type !== "frame" && <Handle type="target" position={Position.Left} className="connection-handle" />}
    <div className="node-head"><span>{NODE_LABELS[node.type] ?? node.type}</span>{node.locked && <b>已锁定</b>}</div>
    <h3>{node.title}</h3>
    {node.type !== "frame" && <p>{node.body}</p>}
    <div className="node-foot"><span>{STATUS_LABELS[node.status] ?? node.status}</span>{(node.metadata?.evidence?.length ?? 0) > 0 && <span>{node.metadata?.evidence?.length} 条证据</span>}</div>
    {node.type !== "frame" && <Handle type="source" position={Position.Right} className="connection-handle" />}
  </article>;
}

const NODE_TYPES = { canvas: FlowCard };
const FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1.05 };
const MULTI_SELECTION_KEYS = ["Control", "Meta"];
const SNAP_GRID: [number, number] = [10, 10];
const PRO_OPTIONS = { hideAttribution: true };
const DEFAULT_EDGE_OPTIONS = {
  type: "smoothstep",
  markerEnd: { type: MarkerType.ArrowClosed },
};

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
  const [, setHistoryRevision] = useState(0);
  const undoStack = useRef<CanvasData[]>([]);
  const redoStack = useRef<CanvasData[]>([]);
  const boardRef = useRef<CanvasData | null>(canvas);
  const onChangeRef = useRef(onChange);
  const dragSnapshotTaken = useRef(false);
  const selectedNodeIdsRef = useRef(selectedIds);
  const selectedEdgeIdsRef = useRef(selectedEdgeIds);

  useEffect(() => { boardRef.current = canvas; }, [canvas]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { selectedNodeIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { selectedEdgeIdsRef.current = selectedEdgeIds; }, [selectedEdgeIds]);
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
    const positions = new Map<string, { x: number; y: number }>();
    for (const change of changes) {
      if (change.type === "position" && change.position) positions.set(change.id, change.position);
    }
    if (!positions.size) return;
    let didMove = false;
    const nextNodes = board.nodes.map((node) => {
      const position = positions.get(node.id);
      if (!position || (closeEnough(node.x, position.x) && closeEnough(node.y, position.y))) return node;
      didMove = true;
      return { ...node, x: position.x, y: position.y };
    });
    if (didMove) applyWithoutHistory({ ...board, nodes: nextNodes });
  }

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
    applyWithoutHistory({ ...current, viewport });
  }, []);

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

  async function generateDraft() {
    if (!selectedIds.length) return;
    setBusy(true);
    try {
      const result = await api.generateContent(
        activeProject.id, selectedIds, contentFormat, contentTitle, contentDuration,
        contentUseLlm, contentInstruction, false,
      );
      setStatus(result.message); setComposerOpen(false); await onRefresh(); setSelectedIds([result.node.id]);
    } catch (error) { setStatus(errorText(error)); } finally { setBusy(false); }
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
    <PageHeader title={activeProject.name} description="拖拽布局和连接观点；支持撤回、重做、多选、快捷键与自动保存。" actions={<>
      <button className="secondary" disabled={!undoStack.current.length} onClick={undo} title="Ctrl+Z">撤回</button>
      <button className="secondary" disabled={!redoStack.current.length} onClick={redo} title="Ctrl+Shift+Z / Ctrl+Y">重做</button>
      <button className="secondary" onClick={addNote} title="N">添加节点</button>
      <button className="secondary" disabled={!selectedIds.length && !selectedEdgeIds.length} onClick={deleteSelection} title="Delete">删除</button>
      <button className="secondary" disabled={selected.length < 2} onClick={createGroup}>创建分组</button>
      <button className="primary" disabled={!selectedIds.length} onClick={() => setComposerOpen(true)}>生成新内容</button>
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
          onSelectionChange={onSelectionChange}
          onMoveEnd={onMoveEnd}
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          minZoom={0.2}
          maxZoom={1.8}
          selectionOnDrag
          panOnDrag={[1, 2]}
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
      <aside className="inspector">{primary ? <>
        <div className="inspector-title"><div><small>{NODE_LABELS[primary.type] ?? primary.type}</small><h2>节点检查器</h2></div><button className="icon-button danger" disabled={primary.locked} onClick={deleteSelection}>删除</button></div>
        <label>标题<input disabled={primary.locked} value={primary.title} onChange={(event) => updateLocal(primary.id, { title: event.target.value })} /></label>
        <label>正文<textarea disabled={primary.locked} value={primary.body} onChange={(event) => updateLocal(primary.id, { body: event.target.value })} /></label>
        <div className="quick-edit"><small>快速加工</small><div><button className="secondary" onClick={() => applyQuickInstruction("调整表达风格，使内容更清晰、有节奏，并保留原有事实")}>调整风格</button><button className="secondary" onClick={() => applyQuickInstruction("基于现有证据补充事实、案例和具体细节；证据不足时明确指出缺口，不得编造")}>补充事实/案例</button><button className="secondary" onClick={() => applyQuickInstruction("优化结构与论证顺序，强化开头、转折和结论")}>优化结构</button></div></div>
        <label>状态<select disabled={primary.locked} value={primary.status} onChange={(event) => updateLocal(primary.id, { status: event.target.value })}><option value="exploring">探索中</option><option value="candidate">候选</option><option value="approved">已批准</option></select></label>
        <label className="switch-row"><span><strong>锁定节点</strong><small>锁定后不能修改内容或删除</small></span><input type="checkbox" checked={primary.locked} onChange={(event) => updateLocal(primary.id, { locked: event.target.checked, status: event.target.checked ? "locked" : primary.status === "locked" ? "candidate" : primary.status })} /></label>
        {primary.type === "output" && <div className="asset-save-panel"><strong>{primary.metadata?.asset_id ? "已关联内容资产" : "仍是白板草稿"}</strong><p>先在上方直接修改，确认后再保存到内容资产；再次保存会生成新版本。</p><button className="primary" disabled={busy || primary.locked} onClick={saveAsAsset}>{busy ? "正在保存…" : primary.metadata?.asset_id ? "更新内容资产" : "保存到内容资产"}</button></div>}
        {!!primary.metadata?.evidence?.length && <div className="evidence-panel"><h3>证据</h3>{primary.metadata.evidence.map((item, index) => <details key={`${item.chunk_id}-${index}`}><summary>{item.title || item.path}</summary><small>{item.path}｜{item.heading?.join(" › ")}</small><p>{item.excerpt}</p>{item.references?.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}</details>)}</div>}
      </> : <div className="inspector-empty"><strong>{selected.length > 1 ? `已选择 ${selected.length} 个节点` : selectedEdgeIds.length ? `已选择 ${selectedEdgeIds.length} 条连接` : "选择一个节点"}</strong><p>{selected.length > 1 ? "可以创建分组、复制、删除或用智能加工栏处理。" : "从节点边缘的圆点拖到另一个节点，即可创建连接。"}</p></div>}</aside>
    </div>
    {!!selectedIds.length && <div className="magic-bar"><span>已选择 {selectedIds.length} 项</span><select value={magicType} onChange={(event) => setMagicType(event.target.value)}><option value="insight">生成洞察</option><option value="challenge">保存质疑</option><option value="creative_pattern">保存创意模式</option><option value="note">生成笔记</option></select><input value={magic} onChange={(event) => setMagic(event.target.value)} placeholder="例如：找出这些信息里的矛盾，并形成一个核心判断" onKeyDown={(event) => { if (event.key === "Enter") runMagic(); }} /><button className="secondary" disabled={busy} onClick={concept}>形成内容概念</button><button className="primary" disabled={busy || !magic.trim()} onClick={runMagic}>{busy ? "处理中…" : "用大模型加工"}</button></div>}
    {composerOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setComposerOpen(false); }}><section className="content-composer" role="dialog" aria-modal="true" aria-label="在白板生成新内容"><div className="composer-head"><div><small>白板内容工坊</small><h2>从选中节点生成可编辑草稿</h2><p>草稿先留在白板，修改满意后再保存到内容资产。</p></div><button className="icon-button" onClick={() => setComposerOpen(false)}>关闭</button></div><div className="composer-grid"><label>内容形态<select value={contentFormat} onChange={(event) => setContentFormat(event.target.value as typeof contentFormat)}><option value="wechat">微信公众号</option><option value="video_script">视频号 / 短视频脚本</option><option value="poster_campaign">海报 / 营销活动</option></select></label><label>标题（可选）<input value={contentTitle} onChange={(event) => setContentTitle(event.target.value)} placeholder="留空则自动生成" /></label></div>{contentFormat === "video_script" && <label>目标时长（秒）<input type="number" min="15" max="600" value={contentDuration} onChange={(event) => setContentDuration(Number(event.target.value))} /></label>}<label>风格与创作要求<textarea value={contentInstruction} onChange={(event) => setContentInstruction(event.target.value)} placeholder="例如：专业但不生硬；开头用真实场景切入；增加一个有证据支持的案例；结尾给出三条行动建议。" /></label><label className="check"><input type="checkbox" checked={contentUseLlm} onChange={(event) => setContentUseLlm(event.target.checked)} />使用已配置大模型</label><div className="composer-actions"><span>将使用 {selectedIds.length} 个白板节点作为依据</span><button className="primary large" disabled={busy} onClick={generateDraft}>{busy ? "正在生成…" : "生成到白板"}</button></div></section></div>}
  </div>;
}
