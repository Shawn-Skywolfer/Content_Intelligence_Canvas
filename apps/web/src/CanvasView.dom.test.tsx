// @vitest-environment jsdom
import { useState } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CanvasView from "./CanvasView";
import type { CanvasData, CanvasNode, Project } from "./api";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const project: Project = {
  id: "history-project", name: "研究项目", idea: "AIDC 液冷", brief: "", status: "active",
  created_at: "2026-09-23T00:00:00Z", updated_at: "2026-09-23T00:00:00Z",
};
const ids = Array.from({ length: 9 }, (_, index) => `research-${index}`);
const nodes: CanvasNode[] = ids.map((id, index) => ({
  id, type: "insight", title: `研究发现 ${index + 1}`, body: `**结论 ${index + 1}**`,
  status: "exploring", locked: false, x: index % 3 * 350, y: Math.floor(index / 3) * 240,
  width: 310, height: 190, metadata: {}, created_by: "research",
}));
const canvas: CanvasData = {
  id: "board", project_id: project.id, nodes, edges: [],
  viewport: { x: 0, y: 0, zoom: 1 }, updated_at: "",
};

describe("真实 React Flow 中的研究历史跳转", () => {
  it("加载九个预选节点后保持稳定，不触发循环更新", async () => {
    const selectionUpdates = vi.fn();
    function HistoryBoard() {
      const [selectedIds, setSelectedIds] = useState(ids);
      const [currentCanvas, setCanvas] = useState<CanvasData | null>(null);
      return <>
        <button onClick={() => setCanvas(canvas)}>进入白板</button>
        <CanvasView project={project} canvas={currentCanvas} selectedIds={selectedIds}
          setSelectedIds={(next) => { selectionUpdates(next); setSelectedIds(next); }}
          onChange={setCanvas} onRefresh={async () => {}} setStatus={() => {}} />
      </>;
    }
    const view = render(<HistoryBoard />);
    await act(async () => { view.getByText("进入白板").click(); });
    await waitFor(() => expect(view.container.querySelectorAll(".flow-card")).toHaveLength(9));
    expect(view.container.querySelectorAll(".flow-card.selected")).toHaveLength(9);
    expect(selectionUpdates).not.toHaveBeenCalled();
    view.unmount();
  });
});
