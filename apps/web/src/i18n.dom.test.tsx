// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { api } from "./api";
import { getLocale, setLocale, t, uiMessage } from "./i18n";
import english from "./locales/en.json";
afterEach(() => { cleanup(); setLocale("zh-CN"); vi.restoreAllMocks(); });
it("切换语言保留未提交输入，更新导航、日期语言、标题与语言偏好", async () => {
  setLocale("zh-CN"); localStorage.setItem("cic.sidebar.collapsed", "false");
  vi.spyOn(api, "health").mockResolvedValue({ status: "ok", phase: "test" });
  vi.spyOn(api, "listProjects").mockResolvedValue([]); vi.spyOn(api, "listSources").mockResolvedValue([]);
  const view = render(<App />);
  await waitFor(() => expect(view.getByText("工作台已就绪")).toBeTruthy());
  const text = view.container.querySelector("textarea")!;
  fireEvent.change(text, { target: { value: "My original prompt 原文保持" } });
  fireEvent.change(view.getByLabelText("Language / 界面语言"), { target: { value: "en" } });
  expect(view.getByRole("button", { name: "Quick research" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Create project and explore" })).toBeTruthy();
  expect((view.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("My original prompt 原文保持");
  expect(document.documentElement.lang).toBe("en"); expect(document.title).toBe("Content Intelligence Workspace");
  expect(localStorage.getItem("cic.locale")).toBe("en"); expect(getLocale()).toBe("en");
  fireEvent.change(view.getByLabelText("Language / 界面语言"), { target: { value: "zh-CN" } });
  expect(view.getByRole("button", { name: "快速研究" })).toBeTruthy(); expect(text.value).toBe("My original prompt 原文保持");
});
it("英文术语、插值及历史中文状态可以本地化，不将参数当成翻译指令", () => {
  setLocale("en"); expect(t("AI 加工并生成下游节点")).toBe("Generate a connected node with AI");
  expect(t("已生成 {0} 个白板节点{1}", 9, " · gpt-test")).toBe("Created 9 canvas nodes · gpt-test");
  expect(uiMessage("已按问题召回 12 个候选材料")).toBe("Found 12 candidate sources for this question");
  expect(t("已删除节点 {0}", "{1}原始数据")).toBe("Deleted node {1}原始数据");
  for (const [key, value] of Object.entries(english)) expect(value.match(/\{\d+\}/g)?.sort() ?? []).toEqual(key.match(/\{\d+\}/g)?.sort() ?? []);
});
