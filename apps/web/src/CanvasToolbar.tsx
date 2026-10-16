import { PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

type Dock = "top" | "bottom" | "left" | "right";
type Layout = "horizontal" | "vertical";
type IconName = "undo" | "redo" | "add" | "delete" | "group" | "connections" | "organize" | "grip" | "settings";
export type CanvasTool = { icon: IconName; label: string; shortcut?: string; disabled?: boolean; onClick: () => void };
const PATHS: Record<IconName, string> = {
  undo: "M9 4 4 9l5 5M4 9h10a6 6 0 0 1 0 12",
  redo: "m15 4 5 5-5 5M20 9H10a6 6 0 0 0 0 12",
  add: "M12 5v14M5 12h14",
  delete: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6",
  group: "M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 8h8v8H8z",
  connections: "M3 5h5v5H3zM16 14h5v5h-5zM8 7h4v10h4m-3-3 3 3-3 3",
  organize: "M3 4h7v6H3zM14 4h7v6h-7zM3 14h7v6H3zM14 14h7v6h-7z",
  grip: "M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01",
  settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
};
function Icon({ name }: { name: IconName }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === "grip" ? 3.5 : 1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[name]} /></svg>;
}
function readPreferences(): { dock: Dock; layout: Layout } {
  try {
    const value = JSON.parse(localStorage.getItem("cic.canvas.toolbar") || "{}");
    return { dock: ["top", "bottom", "left", "right"].includes(value.dock) ? value.dock : "top", layout: value.layout === "vertical" ? "vertical" : "horizontal" };
  } catch { return { dock: "top", layout: "horizontal" }; }
}

export default function CanvasToolbar({ tools }: { tools: CanvasTool[] }) {
  const [preferences, setPreferences] = useState(readPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preview, setPreview] = useState<Dock | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const settings = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; dock: Dock; moved: boolean } | null>(null);
  useEffect(() => { try { localStorage.setItem("cic.canvas.toolbar", JSON.stringify(preferences)); } catch { /* 仍可在当前页面使用 */ } }, [preferences]);
  useEffect(() => {
    if (!settingsOpen) return;
    const close = (event: globalThis.PointerEvent) => { if (!toolbar.current?.contains(event.target as Node)) setSettingsOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [settingsOpen]);
  useLayoutEffect(() => {
    if (!settingsOpen || !toolbar.current?.parentElement || !settings.current) return;
    const parent = toolbar.current.parentElement;
    const panel = settings.current;
    const keepInside = () => {
      panel.style.translate = "0px 0px";
      const board = parent.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      const left = Math.max(board.left + 8, 8), top = Math.max(board.top + 8, 8);
      const right = Math.min(board.right - 8, window.innerWidth - 8), bottom = Math.min(board.bottom - 8, window.innerHeight - 8);
      const dx = Math.max(left - bounds.left, Math.min(0, right - bounds.right));
      const dy = Math.max(top - bounds.top, Math.min(0, bottom - bounds.bottom));
      panel.style.translate = `${dx}px ${dy}px`;
    };
    keepInside();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keepInside);
    observer?.observe(parent);
    window.addEventListener("resize", keepInside);
    return () => { observer?.disconnect(); window.removeEventListener("resize", keepInside); };
  }, [settingsOpen, preferences]);
  function begin(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    setSettingsOpen(false);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, dock: preferences.dock, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    const bounds = toolbar.current?.parentElement?.getBoundingClientRect();
    if (!current || current.pointerId !== event.pointerId || !bounds) return;
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5 && !current.moved) return;
    current.moved = true;
    const distances: [Dock, number][] = [["top", Math.abs(event.clientY - bounds.top)], ["bottom", Math.abs(event.clientY - bounds.bottom)], ["left", Math.abs(event.clientX - bounds.left)], ["right", Math.abs(event.clientX - bounds.right)]];
    current.dock = distances.sort((a, b) => a[1] - b[1])[0][0];
    setPreview(current.dock);
  }
  function end(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.moved && event.type === "pointerup") setPreferences((value) => ({ ...value, dock: current.dock, layout: current.dock === "left" || current.dock === "right" ? "vertical" : "horizontal" }));
    drag.current = null; setPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <>
    {preview && <div className={`toolbar-dock-preview dock-${preview}`} aria-hidden="true" />}
    <div ref={toolbar} className={`canvas-toolbox dock-${preferences.dock} layout-${preferences.layout}`} data-dock={preferences.dock} data-layout={preferences.layout} onKeyDown={(event) => { if (event.key === "Escape" && settingsOpen) { event.stopPropagation(); setSettingsOpen(false); } }}>
      <div role="toolbar" aria-label="白板工具栏" aria-orientation={preferences.layout} className="canvas-tool-strip">
        <button type="button" className="tool-grip" title="拖动到画布四边吸附；也可在工具栏设置中选择位置" aria-label="拖动工具栏" onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}><Icon name="grip" /></button>
        <span className="tool-separator" />
        {tools.map((tool) => <button type="button" key={tool.icon} className={`canvas-tool tool-${tool.icon}`} aria-label={tool.label} title={`${tool.label}${tool.shortcut ? `（${tool.shortcut}）` : ""}`} disabled={tool.disabled} onClick={tool.onClick}><Icon name={tool.icon} /><span className="tool-tooltip">{tool.label}</span></button>)}
        <span className="tool-separator" />
        <button type="button" className="canvas-tool" aria-label="工具栏设置" title="工具栏设置" aria-expanded={settingsOpen} aria-controls="canvas-toolbar-settings" onClick={() => setSettingsOpen((value) => !value)}><Icon name="settings" /></button>
      </div>
      {settingsOpen && <div ref={settings} className="canvas-toolbar-settings" id="canvas-toolbar-settings" role="group" aria-label="工具栏布局与停靠"><strong>工具栏</strong><p>显示方向</p><div>{([["horizontal", "横向"], ["vertical", "纵向"]] as const).map(([layout, label]) => <button type="button" key={layout} aria-pressed={preferences.layout === layout} onClick={() => setPreferences((value) => ({ ...value, layout }))}>{label}</button>)}</div><p>吸附位置</p><div>{([["top", "上边缘"], ["bottom", "下边缘"], ["left", "左边缘"], ["right", "右边缘"]] as const).map(([dock, label]) => <button type="button" key={dock} aria-pressed={preferences.dock === dock} onClick={() => setPreferences({ dock, layout: dock === "left" || dock === "right" ? "vertical" : "horizontal" })}>{label}</button>)}</div><small>拖动六点手柄可快速停靠，位置和方向会自动记住。</small></div>}
    </div>
  </>;
}
