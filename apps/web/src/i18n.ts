import { useSyncExternalStore } from "react";
import english from "./locales/en.json";
export type Locale = "zh-CN" | "en";
const KEY = "cic.locale";
function initialLocale(): Locale {
  try { const saved = localStorage.getItem(KEY); if (saved === "en" || saved === "zh-CN") return saved; } catch { /* 禁止存储时使用浏览器语言 */ }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("en") ? "en" : "zh-CN";
}
let locale: Locale = initialLocale();
const listeners = new Set<() => void>();
export function getLocale() { return locale; }
export function setLocale(value: Locale) {
  locale = value;
  try { localStorage.setItem(KEY, value); } catch { /* 仍允许本次切换 */ }
  if (typeof document !== "undefined") { document.documentElement.lang = value; document.title = value === "en" ? "Content Intelligence Workspace" : "内容智能工作台"; }
  listeners.forEach((notify) => notify());
}
export function useLocale() {
  return useSyncExternalStore((notify) => { listeners.add(notify); return () => { listeners.delete(notify); }; }, getLocale, () => "zh-CN" as Locale);
}
export function t(source: string, ...values: unknown[]): string {
  const translated = locale === "en" ? (english as Record<string, string>)[source] ?? source : source;
  return translated.replace(/\{(\d+)\}/g, (match, index) => Number(index) < values.length ? String(values[Number(index)]) : match);
}
// 用代理在访问时翻译常量，切换语言不需要重建项目或卸载白板。
export function labels<T extends Record<string, string>>(source: T): T {
  return new Proxy(source, { get(target, key: string) { const value = target[key]; return typeof value === "string" ? t(value) : value; } });
}
setLocale(locale);

const templatePairs = Object.entries(english).filter(([key]) => /\{\d+\}/.test(key));
function matchTemplate(template: string, value: string) {
  const escaped = template.split(/(\{\d+\})/).map((part) => /^\{\d+\}$/.test(part) ? "([\\s\\S]*?)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp("^" + escaped + "$", "u").exec(value);
}
// 只用于应用状态和诊断，不处理用户正文、Wiki、Prompt 或供应商推理文本。
export function uiMessage(value: string | null | undefined): string {
  if (!value) return value ?? "";
  if (locale === "en") {
    if ((english as Record<string, string>)[value]) return t(value);
    for (const [zh, en] of templatePairs) { const match = matchTemplate(zh, value); if (match) return en.replace(/\{(\d+)\}/g, (_, i) => match[Number(i) + 1] ?? ""); }
  } else {
    for (const [zh, en] of Object.entries(english)) { if (value === en) return zh; }
    for (const [zh, en] of templatePairs) { const match = matchTemplate(en, value); if (match) return zh.replace(/\{(\d+)\}/g, (_, i) => match[Number(i) + 1] ?? ""); }
  }
  return value;
}
