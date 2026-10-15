import { act, createElement, useEffect } from "react";
import { create, ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CanvasView from "./CanvasView";
import { api } from "./api";
import type { CanvasData, Project } from "./api";

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ nodes, edges, nodeTypes, onSelectionChange, onNodesChange }: {
    nodes: Array<{ id: string; data: unknown; selected?: boolean }>;
    edges: Array<{ type: string; className: string; source: string; target: string; markerEnd: unknown }>;
    nodeTypes: Record<string, React.ComponentType<any>>;
    onSelectionChange?: (value: { nodes: Array<{ id: string }>; edges: unknown[] }) => void;
    onNodesChange: (changes: Array<{ id: string; type: string; selected?: boolean }>) => void;
  }) => {
    useEffect(() => { onSelectionChange?.({ nodes: nodes.filter((node) => node.selected), edges: [] }); }, [nodes, onSelectionChange]);
    return createElement("div", { className: "mock-flow", "data-edges": JSON.stringify(edges) },
      ...nodes.map((node) => createElement(nodeTypes.canvas, { key: node.id, data: node.data, selected: node.selected })),
      createElement("button", { className: "mock-select", onClick: () => onNodesChange([{ id: "brief", type: "select", selected: true }]) }, "模拟选中"));
  },
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  NodeResizer: () => null,
  Handle: () => null,
  applyNodeChanges: (changes: Array<{ id: string; type: string; selected?: boolean }>, nodes: Array<{ id: string; selected?: boolean }>) =>
    nodes.map((node) => {
      const change = changes.find((item) => item.id === node.id && item.type === "select");
      return change ? { ...node, selected: change.selected } : node;
    }),
  ConnectionMode: { Loose: "loose" },
  MarkerType: { ArrowClosed: "arrowclosed" },
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));

const project: Project = {
  id: "p1", name: "测试项目", idea: "测试", brief: "", status: "active",
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};
const canvas: CanvasData = {
  id: "c1", project_id: project.id, viewport: { x: 0, y: 0, zoom: 1 }, updated_at: "",
  nodes: [
    { id: "idea", type: "idea", title: "想法", body: "**重要结论**", summary: "重要结论的概要", status: "exploring", locked: false, x: 0, y: 0, width: 300, height: 180, metadata: {}, created_by: "user" },
    { id: "brief", type: "brief", title: "简报", body: "目标", status: "exploring", locked: false, x: 400, y: 0, width: 300, height: 180, metadata: {}, created_by: "user" },
  ],
  edges: [{ id: "e1", source_node_id: "idea", target_node_id: "brief", relation: "context", metadata: {} }],
};

describe("白板进入与节点编辑", () => {
  beforeEach(() => { vi.spyOn(api, "listMagicJobs").mockResolvedValue([]); });
  it("AI 共创草稿按节点保存，切换时不串用 Prompt", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    const props = { project, canvas, setSelectedIds: vi.fn(), onChange: vi.fn(), onRefresh: async () => {}, setStatus: vi.fn() };
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(createElement(CanvasView, { ...props, selectedIds: ["idea"] })); });
    const prompt = () => renderer.root.findAllByType("textarea").find((item) => item.props.placeholder?.includes("结合上游证据"));
    await act(async () => { prompt()!.props.onChange({ target: { value: "只属于想法节点的草稿" } }); });
    await act(async () => { renderer.update(createElement(CanvasView, { ...props, selectedIds: ["brief"] })); });
    expect(prompt()!.props.value).toBe("");
    await act(async () => { prompt()!.props.onChange({ target: { value: "简报节点草稿" } }); });
    await act(async () => { renderer.update(createElement(CanvasView, { ...props, selectedIds: ["idea"] })); });
    expect(prompt()!.props.value).toBe("只属于想法节点的草稿");
    await act(async () => { renderer.unmount(); });
  });
  it("刷新后恢复节点生成进度，其他节点仍可启动独立任务", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    const running = { job_id: "job-a", project_id: "p1", node_ids: ["idea"], status: "running" as const,
      phase: "模型综合生成", progress: 68, detail: "正在写入内容", created_at: "" };
    vi.spyOn(api, "listMagicJobs").mockResolvedValue([running]);
    const start = vi.spyOn(api, "startMagic").mockResolvedValue({ ...running, job_id: "job-b", node_ids: ["brief"] });
    vi.spyOn(api, "saveCanvas").mockResolvedValue(canvas);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(createElement(CanvasView, { project, canvas, selectedIds: ["brief"], setSelectedIds: vi.fn(), onChange: vi.fn(), onRefresh: async () => {}, setStatus: vi.fn() })); });
    expect(renderer.root.findByProps({ "aria-label": "AI 任务状态" }).findAllByType("strong")[0].children.join("")).toContain("正在生成 1");
    const prompt = renderer.root.findAllByType("textarea").find((item) => item.props.placeholder?.includes("结合上游证据"));
    await act(async () => { prompt!.props.onChange({ target: { value: "整理简报中的新洞察" } }); });
    const button = renderer.root.findByProps({ children: "AI 加工并生成下游节点" });
    expect(button.props.disabled).toBe(false);
    await act(async () => { button.props.onClick(); });
    expect(start).toHaveBeenCalledWith("p1", ["brief"], "整理简报中的新洞察", "insight", "", false, "wechat", 90, 6);
    await act(async () => { renderer.unmount(); });
  });
  it("AI 共创内选择自定义输出形态，并按配置生成下游内容节点", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    vi.spyOn(api, "listContentFormats").mockResolvedValue([{ id: "podcast", name: "播客提纲", positive_prompt: "问答", negative_prompt: "不编造" }]);
    const start = vi.spyOn(api, "startMagic").mockResolvedValue({ job_id: "j1", project_id: "p1", node_ids: ["idea"], status: "running", phase: "准备生成", progress: 2, detail: "准备生成", created_at: "" });
    vi.spyOn(api, "saveCanvas").mockResolvedValue(canvas);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(createElement(CanvasView, { project, canvas, selectedIds: ["idea"], setSelectedIds: vi.fn(), onChange: vi.fn(), onRefresh: async () => {}, setStatus: vi.fn() })); });
    const selector = renderer.root.findAllByType("select").find((item) => item.findAllByProps({ value: "output" }).length);
    expect(selector).toBeDefined();
    await act(async () => { selector!.props.onChange({ target: { value: "output" } }); });
    expect(renderer.root.findAllByType("option").some((item) => item.children.includes("播客提纲"))).toBe(true);
    await act(async () => { renderer.root.findByProps({ children: "生成内容输出节点" }).props.onClick(); });
    expect(start).toHaveBeenCalledWith("p1", ["idea"], "结合节点内容生成草稿", "output", "", false, "podcast", 90, 6);
    await act(async () => { renderer.unmount(); });
  });

  it("曲线有向边只在端点节点激活时呈现流动状态，并显示两组输出 Prompt", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    let renderer!: ReactTestRenderer;
    const props = { project, canvas, selectedIds: [] as string[], setSelectedIds: vi.fn(), onChange: vi.fn(), onRefresh: async () => {}, setStatus: vi.fn() };
    await act(async () => { renderer = create(createElement(CanvasView, props)); });
    const edge = () => JSON.parse(renderer.root.findByProps({ className: "mock-flow" }).props["data-edges"])[0];
    expect(edge().type).toBe("default");
    expect(edge().className).toBe("");
    expect(edge().source).toBe("idea");
    expect(edge().target).toBe("brief");
    expect(edge().markerEnd.type).toBe("arrowclosed");
    await act(async () => { renderer.update(createElement(CanvasView, { ...props, selectedIds: ["idea"] })); });
    expect(edge().className).toContain("edge-flowing");
    const selector = renderer.root.findAllByType("select").find((item) => item.findAllByProps({ value: "output" }).length);
    await act(async () => { selector!.props.onChange({ target: { value: "output" } }); });
    const textareas = renderer.root.findAllByType("textarea");
    expect(textareas.some((field) => field.props.placeholder?.includes("结合上游证据"))).toBe(true);
    expect(textareas.some((field) => field.props.placeholder?.includes("不要编造案例"))).toBe(true);
    await act(async () => { renderer.unmount(); });
  });

  it("手动整理也生成三列双子列，不再创建内容生产示例列", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    let next!: CanvasData;
    let renderer!: ReactTestRenderer;
    const research = Array.from({ length: 9 }, (_, index) => ({
      ...canvas.nodes[0], id: `finding-${index}`, type: index < 6 ? "fact" : "insight", title: `发现 ${index}`,
    }));
    await act(async () => {
      renderer = create(createElement(CanvasView, {
        project, canvas: { ...canvas, nodes: [...canvas.nodes, ...research], edges: [] }, selectedIds: [],
        setSelectedIds: vi.fn(), onChange: (value: CanvasData) => { next = value; },
        onRefresh: async () => {}, setStatus: vi.fn(),
      }));
    });
    await act(async () => { renderer.root.findByProps({ children: "按类型整理" }).props.onClick(); });
    const frames = next.nodes.filter((node) => node.type === "frame");
    expect(frames.map((frame) => frame.title)).toEqual(["01 输入与简报", "02 研究与证据", "03 洞察与策略"]);
    for (const node of next.nodes.filter((item) => item.type !== "frame")) {
      const frame = frames.find((item) => item.x <= node.x && item.x + item.width >= node.x + node.width);
      expect(frame).toBeDefined();
      expect(node.y + node.height).toBeLessThanOrEqual(frame!.y + frame!.height);
    }
    await act(async () => { renderer.unmount(); });
  });

  it("从历史研究进入时保留预选节点，内部同步不会覆盖九个结果节点", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    const ids = Array.from({ length: 9 }, (_, index) => `research-${index}`);
    const results: CanvasData = {
      ...canvas,
      nodes: ids.map((id, index) => ({ ...canvas.nodes[0], id, title: `研究发现 ${index + 1}`, x: index * 350 })),
      edges: [],
    };
    const setSelectedIds = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(CanvasView, {
        project, canvas: results, selectedIds: ids, setSelectedIds,
        onChange: vi.fn(), onRefresh: async () => {}, setStatus: vi.fn(),
      }));
    });
    expect(renderer.root.findAllByType("article")).toHaveLength(9);
    expect(renderer.root.findAllByType("article").every((card) => card.props.className.includes("selected"))).toBe(true);
    expect(setSelectedIds).not.toHaveBeenCalled();
    await act(async () => { renderer.unmount(); });
  });

  it("从加载中切换到项目白板后仍能渲染，并高亮关联节点及编辑 Markdown", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    let renderer!: ReactTestRenderer;
    let edited: CanvasData | undefined;
    const props = {
      project,
      canvas: null as CanvasData | null,
      selectedIds: [] as string[],
      setSelectedIds: vi.fn(),
      onChange: (next: CanvasData) => { edited = next; },
      onRefresh: async () => {},
      setStatus: vi.fn(),
    };
    await act(async () => { renderer = create(createElement(CanvasView, props)); });
    expect(renderer.root.findAllByType("article")).toHaveLength(0);
    await act(async () => { renderer.update(createElement(CanvasView, { ...props, canvas })); });
    expect(renderer.root.findAllByType("article")).toHaveLength(2);
    await act(async () => { renderer.update(createElement(CanvasView, { ...props, canvas, selectedIds: ["idea"] })); });
    const cards = renderer.root.findAllByType("article");
    expect(cards[1].props.className).toContain("related-downstream");
    expect(cards[0].findByProps({ className: "flow-card-summary" }).children).toContain("重要结论的概要");
    await act(async () => {
      cards[0].findByProps({ className: "flow-card-body nodrag" }).props.onDoubleClick({ stopPropagation() {} });
    });
    const editor = renderer.root.findByProps({ className: "flow-card-editor nodrag nowheel" });
    await act(async () => {
      editor.props.onChange({ target: { value: "## 新的 Markdown 标题" } });
    });
    await act(async () => { renderer.root.findByProps({ className: "flow-card-editor nodrag nowheel" }).props.onBlur(); });
    expect(edited?.nodes[0].body).toBe("## 新的 Markdown 标题");
    expect(edited?.nodes[0].summary).toBeNull();
    await act(async () => { renderer.root.findByProps({ className: "mock-select" }).props.onClick(); });
    expect(props.setSelectedIds).toHaveBeenCalledWith(["idea", "brief"]);
    await act(async () => { renderer.unmount(); });
  });
});
