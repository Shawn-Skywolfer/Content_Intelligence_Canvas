// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import AssetView from "./AssetView";
import { api } from "./api";

afterEach(() => vi.restoreAllMocks());

it("内容资产提供修改、导出和删除，且没有内容生成表单", async () => {
  const project = { id: "p1", name: "甲项目", idea: "主题", brief: "", status: "active", created_at: "2026-10-01", updated_at: "2026-10-01" };
  const asset = { id: "a1", project_id: "p1", node_id: "n1", format: "wechat", title: "原标题", body: "## 原正文", evidence: [], status: "draft", version: 1, created_at: "2026-10-01", updated_at: "2026-10-01" };
  vi.spyOn(api, "listContentFormats").mockResolvedValue([{ id: "wechat", name: "微信公众号", positive_prompt: "", negative_prompt: "" }]);
  const update = vi.spyOn(api, "updateAsset").mockResolvedValue({ ...asset, title: "新标题", body: "## 新正文", version: 2 });
  const remove = vi.spyOn(api, "deleteAsset").mockResolvedValue();
  vi.stubGlobal("confirm", () => true);
  const changed = vi.fn(async () => {});
  const view = render(<AssetView project={project} assets={[asset]} onChanged={changed} onOpenNode={vi.fn()} setStatus={vi.fn()} />);
  expect(view.queryByText("生成新内容")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: /原标题/ }));
  expect(view.getByRole("link", { name: "导出 Markdown" }).getAttribute("href")).toContain("/api/assets/a1/export");
  fireEvent.click(view.getByRole("button", { name: "二次修改" }));
  fireEvent.change(view.getByLabelText("标题"), { target: { value: "新标题" } });
  fireEvent.change(view.getByLabelText("Markdown 正文"), { target: { value: "## 新正文" } });
  fireEvent.click(view.getByRole("button", { name: "保存新版本" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith("p1", "a1", "新标题", "## 新正文"));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  fireEvent.click(view.getByRole("button", { name: "删除资产" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith("p1", "a1"));
  view.unmount();
});
