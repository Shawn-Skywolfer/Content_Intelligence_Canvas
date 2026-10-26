// @vitest-environment jsdom
import { useState } from "react";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CanvasView from "./CanvasView";
import { api } from "./api";
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

  it("任务监测可折叠并记忆，折叠时保留任务计数", async () => {
    localStorage.removeItem("cic.canvas.tasks.collapsed");
    const poll = vi.spyOn(api, "listMagicJobs").mockResolvedValue([{ job_id: "active-job", project_id: project.id, node_ids: [ids[0]], status: "running", phase: "检索网络资料", progress: 40, detail: "搜索 MCP", created_at: "" }]);
    const props = { project, canvas, selectedIds: [], setSelectedIds: () => {}, onChange: () => {}, onRefresh: async () => {}, setStatus: () => {} };
    let view = render(<CanvasView {...props} />);
    await waitFor(() => expect(view.getByLabelText("AI 任务状态").textContent).toContain("正在生成 1"));
    fireEvent.click(view.getByRole("button", { name: "折叠任务监测" }));
    expect(view.queryByText("暂停选中")).toBeNull();
    expect(view.getByLabelText("AI 任务状态").textContent).toContain("正在生成 1");
    view.unmount();
    view = render(<CanvasView {...props} />);
    expect(view.getByRole("button", { name: "展开任务监测" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(view.getByRole("button", { name: "展开任务监测" }));
    expect(view.getByText("暂停选中")).toBeTruthy();
    view.unmount(); poll.mockRestore(); localStorage.removeItem("cic.canvas.tasks.collapsed");
  });
  it("卡片展示完整短摘要，展开后渲染完整 Markdown 正文", async () => {
    const full = "## 完整分析\n\n| 编号 | 事实 |\n| --- | --- |\n| E1 | 800V DC |\n\n正文末尾的关键限定条件。";
    const board = { ...canvas, nodes: [{ ...nodes[0], body: full, summary: "浓缩后的关键判断。" }] };
    const view = render(<CanvasView project={project} canvas={board} selectedIds={[]}
      setSelectedIds={() => {}} onChange={() => {}} onRefresh={async () => {}} setStatus={() => {}} />);
    await waitFor(() => expect(view.container.querySelector(".flow-card-summary")?.textContent).toBe("浓缩后的关键判断。"));
    expect(view.container.querySelector(".flow-card")?.textContent).not.toContain("正文末尾的关键限定条件");
    fireEvent.click(view.container.querySelector(".flow-card-expand")!);
    const dialog = view.getByRole("dialog", { name: /完整内容/ });
    expect(within(dialog).getByText("正文末尾的关键限定条件。")).toBeTruthy();
    expect(within(dialog).getByRole("table")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "收起全文" }));
    expect(view.queryByRole("dialog")).toBeNull();
    view.unmount();
  });
});

describe("任务日志、删除与视频时长", () => {
  it("时长可以清空后重新输入，去掉前导零并按整数提交", async () => {
    vi.spyOn(api, "listMagicJobs").mockResolvedValue([]);
    vi.spyOn(api, "listContentFormats").mockResolvedValue([{ id: "video_script", name: "视频脚本", positive_prompt: "", negative_prompt: "" }]);
    vi.spyOn(api, "saveCanvas").mockResolvedValue(canvas);
    const start = vi.spyOn(api, "startMagic").mockResolvedValue({ job_id: "new-task", project_id: project.id, node_ids: [ids[0]], status: "running", progress: 2, phase: "准备", detail: "", created_at: new Date().toISOString() });
    const status = vi.fn();
    const view = render(<CanvasView project={project} canvas={canvas} selectedIds={[ids[0]]} setSelectedIds={() => {}} onChange={() => {}} onRefresh={async () => {}} setStatus={status} />);
    fireEvent.change(view.getByLabelText("新节点类型"), { target: { value: "output" } });
    await waitFor(() => expect(view.getByLabelText("内容输出形态").textContent).toContain("视频脚本"));
    fireEvent.change(view.getByLabelText("内容输出形态"), { target: { value: "video_script" } });
    const input = view.getByLabelText("目标时长（秒）") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.click(view.getByRole("button", { name: "生成内容输出节点" }));
    expect(status).toHaveBeenCalledWith("目标时长：请输入 15–600 秒范围内的整数");
    expect(start).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "030" } });
    expect(input.value).toBe("30");
    fireEvent.click(view.getByRole("button", { name: "生成内容输出节点" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(project.id, [ids[0]], expect.any(String), "output", "", false, "video_script", 30, 6));
    view.unmount(); vi.restoreAllMocks();
  });

  it("运行任务禁止删除，停止任务可删除；详情展示实时日志与导出入口", async () => {
    localStorage.removeItem("cic.canvas.tasks.collapsed");
    const jobs = [
      { job_id: "running", project_id: project.id, node_ids: [ids[0]], status: "running" as const, phase: "模型处理中", progress: 45, detail: "正在接收正文", created_at: new Date().toISOString(), attempt: 1, events: [{ at: new Date().toISOString(), attempt: 1, phase: "模型处理中", detail: "HTTP 200 已连接", level: "info", metrics: { http_status: 200, content_chars: 120, reasoning_chars: 80, provider_reasoning: "正在核对 Wiki 适用条件。", route: "直连", elapsed_seconds: 4 } }] },
      { job_id: "stopped", project_id: project.id, node_ids: [ids[1]], status: "failed" as const, phase: "生成失败", progress: 30, detail: "HTTP 429 额度不足", error: "HTTP 429 额度不足", created_at: new Date().toISOString() },
    ];
    vi.spyOn(api, "listMagicJobs").mockResolvedValue(jobs);
    const del = vi.spyOn(api, "deleteMagicJob").mockResolvedValue(undefined);
    const view = render(<CanvasView project={project} canvas={canvas} selectedIds={[]} setSelectedIds={() => {}} onChange={() => {}} onRefresh={async () => {}} setStatus={() => {}} />);
    await waitFor(() => expect(view.container.querySelectorAll(".canvas-task")).toHaveLength(2));
    const running = view.container.querySelector(".canvas-task.running")! as HTMLElement;
    const stopped = view.container.querySelector(".canvas-task.failed")! as HTMLElement;
    expect((within(running).getByRole("button", { name: "删除任务" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(running).getByRole("button", { name: "查看详情" }));
    const dialog = view.getByRole("dialog", { name: "任务完整详情" });
    expect(within(dialog).getByText("实时执行 LOG")).toBeTruthy();
    expect(within(dialog).getByText("HTTP 200 已连接")).toBeTruthy();
    expect(within(dialog).getByText("正文 120 字符")).toBeTruthy();
    expect(within(dialog).getByText("供应商模型推理输出（实时）")).toBeTruthy();
    expect(within(dialog).getAllByText("正在核对 Wiki 适用条件。").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("推理 80 字符")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "导出 LOG（JSON）" }).getAttribute("href")).toContain("/api/magic/jobs/running/logs/export?format=json");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭详情" }));
    fireEvent.click(within(stopped).getByRole("button", { name: "删除任务" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("stopped"));
    await waitFor(() => expect(view.container.querySelectorAll(".canvas-task")).toHaveLength(1));
    expect(view.getByText("任务及其日志已删除，生成的节点和内容资产保留")).toBeTruthy();
    view.unmount(); vi.restoreAllMocks();
  });
});
