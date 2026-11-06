import { useId, useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { t } from "./i18n";

export default function InfoTip({ children }: { children: string }) {
  const id = useId();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  function enter() {
    clearTimeout(closeTimer.current);
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 6, left: Math.max(16, Math.min(rect.left, window.innerWidth - Math.min(320, window.innerWidth - 32) - 16)) });
    setHover(true); setDismissed(false);
  }
  function leave() { closeTimer.current = setTimeout(() => setHover(false), 120); }
  const open = (hover || focus) && !dismissed;
  const popup = useRef<HTMLSpanElement>(null);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const rect = trigger.current?.getBoundingClientRect();
    const height = popup.current?.getBoundingClientRect().height ?? 0;
    if (rect && rect.bottom + 6 + height > window.innerHeight) setPosition((current) => ({ ...current, top: Math.max(8, rect.top - height - 6) }));
  }, [open]);
  return <span className="info-tip" onMouseEnter={enter} onMouseLeave={leave}>
    <button ref={trigger} type="button" className="info-tip-trigger" aria-label={t("更多信息")} aria-describedby={open ? id : undefined}
      onFocus={() => { enter(); setHover(false); setFocus(true); }} onBlur={() => setFocus(false)}
      onClick={() => { setFocus(true); setDismissed(false); }} onKeyDown={(event) => { if (event.key === "Escape") { setDismissed(true); event.stopPropagation(); } }}>
      <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10" cy="10" r="7.5" /><path d="M10 9v5M10 5.7v.6" /></svg>
    </button>
    {open && createPortal(<span ref={popup} id={id} role="tooltip" className="info-tip-popup" style={position} onMouseEnter={enter} onMouseLeave={leave}>{children}</span>, document.body)}
  </span>;
}
