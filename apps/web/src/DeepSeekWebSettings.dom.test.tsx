import { beforeEach as resetTestLanguage } from "vitest";
import { setLocale as setTestLocale } from "./i18n";
resetTestLanguage(() => setTestLocale("zh-CN"));
// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import DeepSeekWebSettings from "./DeepSeekWebSettings";
import { api, DeepSeekWebConfig } from "./api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const config: DeepSeekWebConfig = { base_url: "https://api.deepseek.com", enabled: false, search_enabled: false, fetch_enabled: false, count: 5, need_content: true, fetch_top_k: 2, max_content_chars: 8000, timeout_seconds: 25, network_mode: "inherit", proxy_url: "", proxy_username: "", has_api_key: false };
function setup() {
  vi.spyOn(api, "getDeepSeekWeb").mockResolvedValue(config);
  vi.spyOn(api, "getWebSearch").mockResolvedValue({ provider: "deepseek", message: "优先使用 DeepSeek 网页搜索与抓取", deepseek_ready: true, mcp_ready: true });
  const save = vi.spyOn(api, "saveDeepSeekWeb").mockImplementation(async (c) => ({ ...c, api_key: undefined, has_api_key: true }));
  return save;
}
it("开关与测试独立、可并行测试、保留各自结果并显示实际语法", async () => {
  const save = setup();
  const start = vi.spyOn(api, "startDeepSeekWebTest").mockImplementation(async (op) => ({ job_id: op, status: "running", phase: `正在测试 ${op}`, elapsed_seconds: 0, events: [], result: {} }));
  let searchDone = false;
  vi.spyOn(api, "deepSeekWebTestJob").mockImplementation(async (id) => ({ job_id: id, status: id === "fetch" || searchDone ? "completed" : "running", phase: id === "fetch" ? "抓取通过" : searchDone ? "搜索通过" : "搜索执行中", elapsed_seconds: 1, events: [], result: id === "fetch" ? { fetch: { http_status: 200, latency_ms: 200, route: "系统代理", content_chars: 2400, title: "页面", url: "https://example.org", preview: "# Markdown 正文" } } : searchDone ? { search: { http_status: 200, result_count: 1, latency_ms: 200, route: "系统代理", query: "问题 site:example.org", items: [] } } : {} }));
  const view = render(<DeepSeekWebSettings />);
  await waitFor(() => expect((view.getByLabelText("DeepSeek 网页工具接口地址") as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(view.getByLabelText("启用 DeepSeek 网页搜索"));
  expect((view.getByRole("button", { name: "测试网页抓取" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(view.getByLabelText("启用 DeepSeek 网页抓取"));
  fireEvent.change(view.getByLabelText("DeepSeek 网页工具 API Key"), { target: { value: "test-key" } });
  fireEvent.change(view.getByLabelText("默认检索语法"), { target: { value: "site:example.org" } });
  fireEvent.click(view.getByRole("button", { name: "测试网页搜索" }));
  await waitFor(() => expect(view.getByText("搜索执行中")).toBeTruthy());
  await waitFor(() => expect((view.getByRole("button", { name: "测试网页抓取" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(view.getByRole("button", { name: "测试网页抓取" }));
  await waitFor(() => expect(view.getByText("抓取通过")).toBeTruthy());
  searchDone = true;
  await waitFor(() => expect(view.getByText("搜索通过")).toBeTruthy(), { timeout: 2500 });
  expect(start.mock.calls.map((call) => call[0])).toEqual(["search", "fetch"]);
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ search_enabled: true, fetch_enabled: true, search_syntax: "site:example.org", api_key: "test-key" }));
  expect(view.getByText(/实际检索语句：问题 site:example.org/)).toBeTruthy();
  expect(view.getByText(/正文 2400 字符/)).toBeTruthy();
  expect((view.getByLabelText("DeepSeek 网页工具 API Key") as HTMLInputElement).value).toBe("");
});
it("失败显示真实 HTTP 状态、中文原因与处理建议", async () => {
  setup();
  vi.spyOn(api, "startDeepSeekWebTest").mockResolvedValue({ job_id: "failed", status: "failed", phase: "网页工具测试失败", elapsed_seconds: 1, events: [], result: {}, failure: { operation: "fetch", http_status: 404, reason: "网页无可提取正文", suggestion: "更换来源网页", endpoint: "https://api.deepseek.com/v1/tools/fetch", retryable: false } });
  const view = render(<DeepSeekWebSettings />);
  await waitFor(() => expect((view.getByLabelText("DeepSeek 网页工具接口地址") as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(view.getByLabelText("启用 DeepSeek 网页抓取"));
  fireEvent.click(view.getByRole("button", { name: "测试网页抓取" }));
  await waitFor(() => expect(view.getByText("HTTP 404 · fetch")).toBeTruthy());
  expect(view.getByText("处理建议：更换来源网页")).toBeTruthy();
});
