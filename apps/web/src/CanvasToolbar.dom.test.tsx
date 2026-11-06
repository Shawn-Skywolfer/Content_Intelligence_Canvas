import { beforeEach as resetTestLanguage } from "vitest";
import { setLocale as setTestLocale } from "./i18n";
resetTestLanguage(() => setTestLocale("zh-CN"));
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import CanvasToolbar from "./CanvasToolbar";

afterEach(() => { cleanup(); localStorage.clear(); });
it("工具栏四边停靠、方向可独立切换并记住设置，图标操作仍可执行", () => {
  const add = vi.fn();
  const tools = [{ icon: "add" as const, label: "添加节点", onClick: add }];
  let view = render(<CanvasToolbar tools={tools} />);
  fireEvent.click(view.getByRole("button", { name: "工具栏设置" }));
  for (const [name, dock] of [["左边缘", "left"], ["下边缘", "bottom"], ["上边缘", "top"], ["右边缘", "right"]]) {
    fireEvent.click(view.getByRole("button", { name }));
    expect(view.container.querySelector(".canvas-toolbox")?.getAttribute("data-dock")).toBe(dock);
  }
  fireEvent.click(view.getByRole("button", { name: "横向" }));
  expect(view.getByRole("toolbar").getAttribute("aria-orientation")).toBe("horizontal");
  fireEvent.click(view.getByRole("button", { name: "纵向" }));
  fireEvent.click(view.getByRole("button", { name: "添加节点" }));
  expect(add).toHaveBeenCalledOnce();
  view.unmount();
  view = render(<CanvasToolbar tools={tools} />);
  expect(view.container.querySelector(".canvas-toolbox")?.getAttribute("data-dock")).toBe("right");
  expect(view.getByRole("toolbar").getAttribute("aria-orientation")).toBe("vertical");
});
