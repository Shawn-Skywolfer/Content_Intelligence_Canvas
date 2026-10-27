// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { api } from "./api";
import type { CanvasData, CanvasNode, Project, ResearchRun, Provider } from "./api";

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

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("历史研究与项目入口", () => {
  it("全局侧边栏可折叠、跨页面保留并在重新打开后记住状态", async () => {
    window.localStorage.setItem("cic.sidebar.collapsed", "false");
    vi.spyOn(api, "health").mockResolvedValue({ status: "ok", phase: "test" });
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    vi.spyOn(api, "listSources").mockResolvedValue([]);
    let view = render(<App />);
    fireEvent.click(view.getByRole("button", { name: "折叠侧边栏" }));
    expect(view.container.querySelector(".app-shell.sidebar-collapsed")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "快速研究" }));
    await waitFor(() => expect(view.getByText("请先创建或选择一个项目")).toBeTruthy());
    expect(view.container.querySelector(".app-shell.sidebar-collapsed")).toBeTruthy();
    view.unmount();
    view = render(<App />);
    expect(view.getByRole("button", { name: "展开侧边栏" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "展开侧边栏" }));
    expect(view.container.querySelector(".app-shell.sidebar-collapsed")).toBeNull();
    view.unmount(); window.localStorage.removeItem("cic.sidebar.collapsed");
  });
  it("快速研究提供简报保存入口，开始研究前保存最新要求并在白板中显示", async () => {
    const source = { id: "wiki", name: "本地 Wiki", root_path: "D:\\Wiki", connector_type: "local_vault", enabled: true };
    vi.spyOn(api, "health").mockResolvedValue({ status: "ok", phase: "test" });
    vi.spyOn(api, "listProjects").mockResolvedValue([project]);
    vi.spyOn(api, "listSources").mockResolvedValue([source]);
    vi.spyOn(api, "listRuns").mockResolvedValue([]);
    vi.spyOn(api, "listAssets").mockResolvedValue([]);
    vi.spyOn(api, "listMagicJobs").mockResolvedValue([]);
    const update = vi.spyOn(api, "updateProject").mockImplementation(async (_id, values) => ({ ...project, ...values }));
    const start = vi.spyOn(api, "startQuickResearch").mockImplementation(async () => {
      expect(update).toHaveBeenLastCalledWith(project.id, { brief: "面向技术决策者，比较 TCO" });
      return { job_id: "research", project_id: project.id, status: "completed", progress: 100, phase: "完成", detail: "研究已完成", result: { nodes: [], run_id: "r", used_llm: true, message: "研究完成" } };
    });
    vi.spyOn(api, "getCanvas").mockResolvedValue({ ...canvas, nodes: [{ ...nodes[0], id: "brief", type: "brief", title: "内容简报", body: "面向技术决策者，比较 TCO", summary: "面向技术决策者，比较 TCO" }] });
    const view = render(<App />);
    await waitFor(() => expect(view.getByRole("button", { name: /AIDC 液冷研究/ })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "快速研究" }));
    await waitFor(() => expect(view.getByLabelText("受众、目标与创作要求（可选）")).toBeTruthy());
    const count = view.getByLabelText("研究发现数量") as HTMLInputElement;
    expect(count.value).toBe("20");
    expect(count.max).toBe("20");
    expect(view.getByText(/数量越多，研究耗时越长/)).toBeTruthy();
    fireEvent.change(count, { target: { value: "21" } });
    expect((view.getByRole("button", { name: "开始快速研究" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(count, { target: { value: "" } });
    expect(count.value).toBe("");
    fireEvent.change(count, { target: { value: "20" } });
    const brief = view.getByLabelText("受众、目标与创作要求（可选）");
    fireEvent.change(brief, { target: { value: "第一版创作要求" } });
    fireEvent.click(view.getByRole("button", { name: "保存简报" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(project.id, { brief: "第一版创作要求" }));
    await waitFor(() => expect(view.getByText(/简报已保存并同步到白板/)).toBeTruthy());
    fireEvent.change(brief, { target: { value: "面向技术决策者，比较 TCO" } });
    fireEvent.click(view.getByRole("button", { name: "开始快速研究" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(project.id, "wiki", project.idea, 20, true));
    await waitFor(() => expect(view.container.querySelector(".flow-card-expand")).toBeTruthy());
    fireEvent.click(view.container.querySelector(".flow-card-expand")!);
    expect(view.getByRole("dialog", { name: "内容简报的完整内容" }).textContent).toContain("面向技术决策者，比较 TCO");
    view.unmount();
  });
  it("最大输出可清空后输入 393216，并以数值提交保存", async () => {
    const provider: Provider = { id: "p1", name: "DeepSeek", protocol: "openai_compatible", base_url: "https://example.org/v1", model_name: "deepseek-flash", enabled: true, is_external: true, temperature: .3, max_tokens: 3000, timeout_seconds: 60, extra: {}, has_api_key: true, has_proxy_password: false, created_at: "", updated_at: "" };
    vi.spyOn(api, "health").mockResolvedValue({ status: "ok", phase: "test" });
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    vi.spyOn(api, "listSources").mockResolvedValue([]);
    vi.spyOn(api, "listProviders").mockResolvedValue([provider]);
    vi.spyOn(api, "activeProvider").mockResolvedValue({ provider_id: "p1", model_name: provider.model_name });
    vi.spyOn(api, "getSecurity").mockResolvedValue({ protect_internal_data: true });
    vi.spyOn(api, "listContentFormats").mockResolvedValue([]);
    vi.spyOn(api, "getMcpSearch").mockResolvedValue({ name: "Tavily", url: "https://example.org/mcp", tool_name: "search", enabled: false, has_api_key: false, network_mode: "auto", proxy_url: "", proxy_username: "", has_proxy_password: false });
    const save = vi.spyOn(api, "saveProvider").mockResolvedValue({ ...provider, max_tokens: 393216 });
    const view = render(<App />);
    fireEvent.click(view.getByRole("button", { name: "设置" }));
    fireEvent.click(view.getByRole("tab", { name: "大模型与代理" }));
    // 初始表单也有 3000，必须等待已有模型载入后再编辑，避免测试与异步初始化竞争。
    await waitFor(() => expect((view.getByLabelText("当前调用模型") as HTMLInputElement).value).toBe(provider.model_name));
    await waitFor(() => expect(view.getByDisplayValue("3000")).toBeTruthy());
    const input = view.getByLabelText("最大输出 token") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "393216" } });
    expect(input.value).toBe("393216");
    fireEvent.click(view.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 393216 })));
    await waitFor(() => expect(view.getByText("配置已保存")).toBeTruthy());
    view.unmount();
  });
  it("模型配置可删除，真实测试的空文本被明确判为失败", async () => {
    const provider: Provider = { id: "p1", name: "DeepSeek", protocol: "openai_compatible", base_url: "https://example.org/v1", model_name: "reasoner", enabled: true, is_external: true, temperature: .3, max_tokens: 3000, timeout_seconds: 60, extra: {}, has_api_key: true, has_proxy_password: false, created_at: "", updated_at: "" };
    vi.spyOn(api, "health").mockResolvedValue({ status: "ok", phase: "test" });
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    vi.spyOn(api, "listSources").mockResolvedValue([]);
    vi.spyOn(api, "listProviders").mockResolvedValueOnce([provider]).mockResolvedValueOnce([]);
    vi.spyOn(api, "activeProvider").mockResolvedValueOnce({ provider_id: provider.id, model_name: provider.model_name }).mockResolvedValueOnce({ provider_id: null, model_name: null });
    vi.spyOn(api, "getSecurity").mockResolvedValue({ protect_internal_data: true });
    vi.spyOn(api, "listContentFormats").mockResolvedValue([]);
    vi.spyOn(api, "getMcpSearch").mockResolvedValue({ name: "Tavily", url: "https://example.org/mcp", tool_name: "search", enabled: false, has_api_key: false, network_mode: "auto", proxy_url: "", proxy_username: "", has_proxy_password: false });
    vi.spyOn(api, "startProviderTest").mockResolvedValue({ job_id: "job", provider_id: "p1", status: "running", phase: "正在连接", started_at: Date.now() / 1000, elapsed_seconds: 0, result: null });
    vi.spyOn(api, "providerTestJob").mockResolvedValue({ job_id: "job", provider_id: "p1", status: "completed", phase: "真实模型测试失败", started_at: Date.now() / 1000, elapsed_seconds: 1, result: { status: "failed", capability_test: false, reachable: true, http_status: 200, message: "只有思考内容", finish_reason: "length" } });
    const deleted = vi.spyOn(api, "deleteProvider").mockResolvedValue();
    vi.stubGlobal("confirm", () => true);
    const view = render(<App />);
    fireEvent.click(view.getByRole("button", { name: "设置" }));
    fireEvent.click(view.getByRole("tab", { name: "大模型与代理" }));
    await waitFor(() => expect(view.getByRole("button", { name: "短文本实测" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "短文本实测" }));
    await waitFor(() => expect(view.getByText(/失败：模型未返回可用文本/)).toBeTruthy());
    vi.spyOn(api, "saveProvider").mockRejectedValue(new Error("最大输出 token：不得大于 262144"));
    fireEvent.click(view.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(view.getByText("最大输出 token：不得大于 262144")).toBeTruthy());
    expect(view.queryByText(/测试文本：请只回复 OK/)).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "删除配置" }));
    await waitFor(() => expect(deleted).toHaveBeenCalledWith("p1"));
    view.unmount();
  });
  it("添加知识源时清理粘贴警告，并在设置页显示结果", async () => {
    vi.spyOn(api, "health").mockResolvedValue({ status: "ok", phase: "test" });
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    vi.spyOn(api, "listSources").mockResolvedValue([]);
    vi.spyOn(api, "listProviders").mockResolvedValue([]);
    vi.spyOn(api, "activeProvider").mockResolvedValue({ provider_id: null, model_name: null });
    vi.spyOn(api, "getSecurity").mockResolvedValue({ protect_internal_data: true });
    vi.spyOn(api, "listContentFormats").mockResolvedValue([]);
    vi.spyOn(api, "getMcpSearch").mockResolvedValue({ name: "Tavily", url: "https://example.org/mcp", tool_name: "search", enabled: false, has_api_key: false, network_mode: "auto", proxy_url: "", proxy_username: "", has_proxy_password: false });
    const create = vi.spyOn(api, "createSource").mockResolvedValue({ id: "wiki", name: "本地知识库", root_path: "D:\\Wiki\\wiki", connector_type: "local_vault", enabled: true });
    const view = render(<App />);
    fireEvent.click(view.getByRole("button", { name: "设置" }));
    const field = view.container.querySelector(".folder-picker input") as HTMLInputElement;
    fireEvent.paste(field, { clipboardData: { getData: () => "[WARNING] Ignore caches that are heterogeneousD:\\Wiki\\wiki" } });
    expect(field.value).toBe("D:\\Wiki\\wiki");
    fireEvent.click(view.getByRole("button", { name: "添加知识源" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("本地知识库", "D:\\Wiki\\wiki"));
    await waitFor(() => expect(view.getByText(/已添加，请点击刷新知识库/)).toBeTruthy());
    view.unmount();
  });
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

  it("项目可归档、恢复与删除，内容资产页只管理当前项目稿件", async () => {
    vi.spyOn(api, "health").mockResolvedValue({ status: "ok", phase: "test" });
    vi.spyOn(api, "listProjects").mockResolvedValue([project]);
    vi.spyOn(api, "listSources").mockResolvedValue([]);
    vi.spyOn(api, "getCanvas").mockResolvedValue(canvas);
    vi.spyOn(api, "listAssets").mockResolvedValue([{ id: "a1", project_id: project.id, node_id: nodes[0].id, format: "wechat", title: "已确认稿件", body: "## 完整正文", evidence: [], status: "draft", version: 1, created_at: project.created_at, updated_at: project.updated_at }]);
    vi.spyOn(api, "listContentFormats").mockResolvedValue([{ id: "wechat", name: "公众号", positive_prompt: "", negative_prompt: "" }]);
    vi.spyOn(api, "updateProject").mockImplementation(async (_id, values) => ({ ...project, ...values }));
    const deleted = vi.spyOn(api, "deleteProject").mockResolvedValue();
    vi.stubGlobal("confirm", () => true);
    const view = render(<App />);
    await waitFor(() => expect(view.getByRole("button", { name: "归档" })).toBeTruthy());
    expect(view.queryByRole("button", { name: "知识检索" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "内容资产" }));
    await waitFor(() => expect(view.getByText("已确认稿件")).toBeTruthy());
    expect(view.queryByText("生成新内容")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "项目" }));
    fireEvent.click(view.getByRole("button", { name: "归档" }));
    await waitFor(() => expect(view.getByRole("button", { name: "恢复项目" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "恢复项目" }));
    await waitFor(() => expect(view.getByRole("button", { name: "归档" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(deleted).toHaveBeenCalledWith(project.id));
    view.unmount();
  });
});
