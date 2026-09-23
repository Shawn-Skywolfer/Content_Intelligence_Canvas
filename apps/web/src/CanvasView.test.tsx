import { act, createElement } from "react";
import { create, ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import CanvasView from "./CanvasView";
import type { CanvasData, Project } from "./api";

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ nodes, nodeTypes }: { nodes: Array<{ id: string; data: unknown; selected?: boolean }>; nodeTypes: Record<string, React.ComponentType<any>> }) =>
    createElement("div", { className: "mock-flow" }, nodes.map((node) =>
      createElement(nodeTypes.canvas, { key: node.id, data: node.data, selected: node.selected }))),
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Handle: () => null,
  applyNodeChanges: (_changes: unknown[], nodes: unknown[]) => nodes,
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
    { id: "idea", type: "idea", title: "想法", body: "**重要结论**", status: "exploring", locked: false, x: 0, y: 0, width: 300, height: 180, metadata: {}, created_by: "user" },
    { id: "brief", type: "brief", title: "简报", body: "目标", status: "exploring", locked: false, x: 400, y: 0, width: 300, height: 180, metadata: {}, created_by: "user" },
  ],
  edges: [{ id: "e1", source_node_id: "idea", target_node_id: "brief", relation: "context", metadata: {} }],
};

describe("白板进入与节点编辑", () => {
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
    expect(cards[0].findAllByType("strong")[0].children).toContain("重要结论");
    await act(async () => {
      cards[0].findByProps({ className: "flow-card-body nodrag" }).props.onDoubleClick({ stopPropagation() {} });
    });
    const editor = renderer.root.findByProps({ className: "flow-card-editor nodrag nowheel" });
    await act(async () => {
      editor.props.onChange({ target: { value: "## 新的 Markdown 标题" } });
    });
    await act(async () => { renderer.root.findByProps({ className: "flow-card-editor nodrag nowheel" }).props.onBlur(); });
    expect(edited?.nodes[0].body).toBe("## 新的 Markdown 标题");
    await act(async () => { renderer.unmount(); });
  });
});
