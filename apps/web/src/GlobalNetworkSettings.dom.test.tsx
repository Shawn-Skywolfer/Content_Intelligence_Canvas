import { beforeEach as resetTestLanguage } from "vitest";
import { setLocale as setTestLocale } from "./i18n";
resetTestLanguage(() => setTestLocale("zh-CN"));
// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import GlobalNetworkSettings from "./GlobalNetworkSettings";
import { api } from "./api";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("保存全局代理后测试并在当前页面显示可达性，密码不回显", async () => {
  vi.spyOn(api, "getGlobalNetwork").mockResolvedValue({ network_mode: "custom_proxy", proxy_url: "http://proxy.local:8080", proxy_username: "user" });
  const save = vi.spyOn(api, "saveGlobalNetwork").mockResolvedValue({ network_mode: "custom_proxy", proxy_url: "http://proxy.local:8080", proxy_username: "user", has_proxy_password: true });
  vi.spyOn(api, "testGlobalNetwork").mockResolvedValue({ reachable: true, http_status: 404, latency_ms: 120, route: "企业代理", message: "仅代表网络可达" });
  const view = render(<GlobalNetworkSettings />);
  await waitFor(() => expect((view.getByLabelText("全局代理地址") as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(view.getByLabelText("全局代理密码"), { target: { value: "private-password" } });
  fireEvent.click(view.getByRole("button", { name: "保存并测试网络" }));
  await waitFor(() => expect(view.getByText(/HTTP 404.*120 ms/)).toBeTruthy());
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ proxy_password: "private-password" }));
  expect((view.getByLabelText("全局代理密码") as HTMLInputElement).value).toBe("");
});
