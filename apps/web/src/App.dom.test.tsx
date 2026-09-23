// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { api } from "./api";
import type { CanvasData, CanvasNode, Project, ResearchRun } from "./api";

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const project: Project = {
  id: "historical", name: "AIDC 液冷研究", idea: "AIDC 一定要使用液冷吗？", brief: "",
  status: "active", created_at: "2026-09-23T00:00:00Z", updated_at: "2026-09-23T00:00:00Z",
};
const resultIds = Array.from({ length: 9 }, (_, index) => `result-${index}`);
const nodes: CanvasNode[] = resultIds.map((id, index) => ({
  id, type: "insight", title: `研究结果 ${index + 1}`, body: `第 ${index + 1} 条结论`,
  status: "exploring", locked: false, x: index % 3 * 350, y: Math.floor(index / 3) * 240,
  width: 310, height: 190, metadata: {}, created_by: "research",
}));
const canvas: CanvasData = {
  id: "canvas", project_id: project.id, nodes, edges: [],
  viewport: { x: 0, y: 0, zoom: 1 }, updated_at: "",
};
const run: ResearchRun = {
  id: "run-1", project_id: project.id, action: "quick_research", prompt: project.idea,
  input_node_ids: [], output_node_ids: resultIds, status: "completed",
  provider_name: null, model_name: null, error: null,
  created_at: "2026-09-23T00:00:00Z", completed_at: "2026-09-23T00:02:00Z",
};

afterEach(() => vi.restoreAllMocks());

describe("历史研究与项目入口", () => {
  it("从历史研究和项目卡片进入同一白板均正常显示", async () => {
    vi.spyOn(api, "health").mockResolvedValue({ status: "ok", phase: "test" });
    vi.spyOn(api, "listProjects").mockResolvedValue([project]);
    vi.spyOn(api, "listSources").mockResolvedValue([]);
    vi.spyOn(api, "getCanvas").mockResolvedValue(canvas);
    vi.spyOn(api, "listAssets").mockResolvedValue([]);
    vi.spyOn(api, "listRuns").mockResolvedValue([run]);
    const view = render(<App />);
    await waitFor(() => expect(view.getByRole("button", { name: /AIDC 液冷研究/ })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: /快速研究/ }));
    await waitFor(() => expect(view.getByRole("button", { name: "查看白板节点" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "查看白板节点" }));
    await waitFor(() => expect(view.container.querySelectorAll(".flow-card.selected")).toHaveLength(9));
    expect(view.queryByText("白板未能正确初始化")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "项目" }));
    fireEvent.click(view.getByRole("button", { name: /AIDC 液冷研究/ }));
    await waitFor(() => expect(view.container.querySelectorAll(".flow-card")).toHaveLength(9));
    expect(view.queryByText("白板未能正确初始化")).toBeNull();
    view.unmount();
  });
});
