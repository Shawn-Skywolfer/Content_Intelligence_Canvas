// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import InfoTip from "./InfoTip";
import { setLocale } from "./i18n";
afterEach(cleanup);
it("帮助默认收起，键盘聚焦可读，Escape 关闭，不截获表单提交", async () => {
  setLocale("zh-CN");
  const view = render(<form><InfoTip>完整阅读 Wiki 原文</InfoTip></form>);
  const trigger = view.getByRole("button", { name: "更多信息" });
  expect(trigger.getAttribute("type")).toBe("button");
  expect(view.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(trigger);
  const tip = view.getByRole("tooltip");
  expect(tip.textContent).toBe("完整阅读 Wiki 原文");
  expect(trigger.getAttribute("aria-describedby")).toBe(tip.id);
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(view.queryByRole("tooltip")).toBeNull();
  fireEvent.blur(trigger); fireEvent.mouseEnter(trigger.parentElement!);
  expect(view.getByRole("tooltip")).toBeTruthy();
  fireEvent.mouseLeave(trigger.parentElement!);
  await waitFor(() => expect(view.queryByRole("tooltip")).toBeNull());
});
