import { beforeEach as resetTestLanguage } from "vitest";
import { setLocale as setTestLocale } from "./i18n";
resetTestLanguage(() => setTestLocale("zh-CN"));
// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import MarkdownContent from "./MarkdownContent";
import WikiEvidence from "./WikiEvidence";
import { api } from "./api";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("证据表格、粗体、嵌套列表、代码和任务列表按 Markdown 渲染", () => {
  const view = render(<MarkdownContent>{'# 技术判断\n\n| 编号 | 证据要点 | 来源 |\n| --- | --- | --- |\n| E1 | **800V DC** | `power.md` |\n\n- 一级观点\n  - 二级证据\n\n- [x] 已核实\n\n> 适用条件需要验证\n\n```python\nprint("OK")\n```'}</MarkdownContent>);
  expect(view.getByRole("table")).toBeTruthy();
  expect(view.getAllByRole("columnheader")).toHaveLength(3);
  expect(view.getByText("800V DC").tagName).toBe("STRONG");
  expect(view.getByText("power.md").tagName).toBe("CODE");
  expect(view.container.querySelector("ul ul li")?.textContent).toBe("二级证据");
  expect((view.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  expect(view.container.querySelector("pre code")?.textContent).toContain('print("OK")');
  expect(view.container.querySelector(".markdown-table-scroll table")).toBeTruthy();
});
it("用户可从证据摘录展开完整 Wiki 原始词条，长正文末尾也保留", async () => {
  const full = "# 原始词条\n\n" + "完整论证\n".repeat(2000) + "\n末尾的适用范围与限定";
  const call = vi.spyOn(api, "wikiOriginal").mockResolvedValue({ source_id: "wiki", path: "power.md", title: "供电", text: full, content_chars: full.length, read_mode: "full_document" });
  const view = render(<WikiEvidence item={{ chunk_id: "chunk", path: "power.md", excerpt: "短摘录" }} sourceId="wiki" />);
  fireEvent.click(view.getByRole("button", { name: "查看完整 Wiki 原始词条" }));
  await waitFor(() => expect(view.getByText(/末尾的适用范围与限定/)).toBeTruthy());
  expect(call).toHaveBeenCalledWith(expect.objectContaining({ source_id: "wiki", chunk_id: "chunk" }));
  expect(view.getByRole("heading", { name: "原始词条" })).toBeTruthy();
});
