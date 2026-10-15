import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Tags, X } from "lucide-react";
import { api } from "../lib/api";
import type { TagCount } from "../lib/types";
import { useStore } from "../store";

/** All classification labels, shared with the sidebar's tag filter. */
export function CanvasSourceTags() {
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const filter = useStore(s => s.smartFilter);
  const active = filter?.startsWith("tag:") ? filter.slice(4) : null;

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setStatus("loading");
    // A global label catalogue includes labels without members in this project.
    api.listTags("all", null).then(result => {
      if (alive) { setTags(result); setStatus("ready"); }
    }).catch(() => { if (alive) setStatus("error"); });
    return () => { alive = false; };
  }, [open, retry]);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(320, window.innerWidth - 16);
      setPosition({
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 368)),
      });
    }
    place();
    panelRef.current?.focus();
    const observer = new ResizeObserver(place);
    const header = buttonRef.current?.closest(".canvas-source-header");
    if (header) observer.observe(header);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function outside(event: Event) {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  function select(name: string | null) {
    const store = useStore.getState();
    store.setSearchQuery("");
    store.setSmartFilter(name ? `tag:${name}` : null);
    close();
  }

  return <>
    <button ref={buttonRef} type="button" className={`canvas-source-tag-toggle${active ? " is-active" : ""}`}
      title={active ? `分类标签：${active}` : "分类标签"} aria-label="分类标签"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(value => !value)}><Tags size={14} aria-hidden="true" /></button>
    {open && createPortal(<div ref={panelRef} id={id} role="dialog" aria-label="分类标签" tabIndex={-1}
      className="canvas-source-tag-popover" style={position}>
      <header><strong>分类标签</strong><button type="button" aria-label="关闭分类标签" onClick={close}><X size={14} /></button></header>
      {active && <button type="button" className="canvas-source-tag-clear" onClick={() => select(null)}>清除筛选 · {active}</button>}
      {status === "loading" ? <p role="status">正在加载标签…</p>
        : status === "error" ? <p role="alert">标签加载失败 <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>
        : tags.length === 0 ? <p>暂无分类标签</p>
        : <div className="canvas-source-tag-grid">{tags.map(tag => <button key={tag.id} type="button"
          aria-pressed={active === tag.name} onClick={() => select(active === tag.name ? null : tag.name)}>
          <span aria-hidden="true">#</span><span>{tag.name}</span>
        </button>)}</div>}
    </div>, document.body)}
  </>;
}
