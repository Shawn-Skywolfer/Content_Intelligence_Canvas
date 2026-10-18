// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import DeepSeekWebSettings from "./DeepSeekWebSettings";
import { api } from "./api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("先保存当前参数再做真实搜索抓取测试，显示分项结果且不回显密钥", async () => {
  const config = { base_url: "https://api.deepseek.com", enabled: false, count: 5, need_content: true, fetch_top_k: 2, max_content_chars: 8000, timeout_seconds: 25, network_mode: "auto" as const, proxy_url: "", proxy_username: "", has_api_key: false };
  vi.spyOn(api, "getDeepSeekWeb").mockResolvedValue(config);
  vi.spyOn(api, "getWebSearch").mockResolvedValue({ provider: "deepseek", message: "优先使用 DeepSeek 网页搜索与抓取", deepseek_ready: true, mcp_ready: true });
  const save = vi.spyOn(api, "saveDeepSeekWeb").mockResolvedValue({ ...config, enabled: true, has_api_key: true });
  const start = vi.spyOn(api, "startDeepSeekWebTest").mockResolvedValue({ job_id: "test", status: "running", phase: "Search", elapsed_seconds: 0, events: [], result: {} });
  vi.spyOn(api, "deepSeekWebTestJob").mockResolvedValue({ job_id: "test", status: "completed", phase: "真实网页工具测试通过", elapsed_seconds: 2, events: [{ at: 1, detail: "Fetch 通过" }], result: { search: { http_status: 200, result_count: 1, latency_ms: 200, route: "系统代理", query: "问题", items: [{ title: "结果", url: "https://example.org", excerpt: "摘要" }] }, fetch: { http_status: 200, latency_ms: 300, route: "系统代理", content_chars: 2400, title: "页面", url: "https://example.org", preview: "# Markdown 正文" } } });
  const view = render(<DeepSeekWebSettings />);
  await waitFor(() => expect((view.getByLabelText("DeepSeek 网页工具接口地址") as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(view.getByLabelText("启用 DeepSeek 网页搜索与抓取"));
  fireEvent.change(view.getByLabelText("DeepSeek 网页工具 API Key"), { target: { value: "test-key" } });
  fireEvent.change(view.getByLabelText("搜索结果条数（1–50）"), { target: { value: "" } });
  expect((view.getByLabelText("搜索结果条数（1–50）") as HTMLInputElement).value).toBe("");
  fireEvent.change(view.getByLabelText("搜索结果条数（1–50）"), { target: { value: "3" } });
  fireEvent.click(view.getByRole("button", { name: "保存并测试搜索和抓取" }));
  await waitFor(() => expect(start).toHaveBeenCalledWith("both", "DeepSeek API 网页搜索 官方文档", "https://api-docs.deepseek.com/zh-cn/guides/search/"));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ count: 3, api_key: "test-key", enabled: true }));
  await waitFor(() => expect(view.getByText("真实网页工具测试通过")).toBeTruthy());
  expect(view.getByText(/正文 2400 字符/)).toBeTruthy();
  expect((view.getByLabelText("DeepSeek 网页工具 API Key") as HTMLInputElement).value).toBe("");
});
