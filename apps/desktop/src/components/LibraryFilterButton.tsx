import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import type { ColorBucket } from "../lib/types";
import { notifyError } from "../lib/notify";

const COLOR_LABELS: Record<string, string> = {
  red: "红", orange: "橙", yellow: "黄", green: "绿", cyan: "青", blue: "蓝",
  purple: "紫", pink: "粉", brown: "棕", gray: "灰", white: "白", black: "黑",
};

export function LibraryFilterButton() {
  const [open, setOpen] = useState(false);
  const [colors, setColors] = useState<ColorBucket[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const color = useStore(s => s.colorFilter);
  const palette = useStore(s => s.palette);
  const colorRebuild = useStore(s => s.colorRebuild);
  const colorBusy = !!colorRebuild;
  const libraryOpen = useStore(s => s.canvasLibraryOpen);
  useLayoutEffect(() => {
    const navigation = root.current?.closest<HTMLElement>(".library-floating-navigation");
    const heading = navigation?.closest<HTMLElement>(".library-browser-heading");
    const control = root.current?.querySelector<HTMLElement>(".library-color-control");
    if (!navigation || !heading || !control) return;
    function fit() {
      const bounds = heading!.getBoundingClientRect();
      const close = heading!.closest(".canvas-source-panel")?.querySelector<HTMLElement>(".library-return-canvas")?.getBoundingClientRect();
      const back = close && close.top < bounds.bottom && close.bottom > bounds.top ? close : undefined;
      const left = back && back.left < bounds.left + bounds.width / 2 ? back.right + 8 : bounds.left;
      const right = back && back.left >= bounds.left + bounds.width / 2 ? back.left - 8 : bounds.right;
      const width = navigation!.offsetWidth;
      const button = bounds.height;
      const available = Math.max(button, right - left - width - 8);
      control!.style.maxWidth = `${available}px`;
      const end = bounds.left + (bounds.width - width) / 2 + width + 8 + control!.getBoundingClientRect().width;
      navigation!.style.setProperty("--library-navigation-shift", `${Math.min(0, right - end)}px`);
    }
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(heading);
    observer.observe(navigation);
    observer.observe(control);
    const back = heading.closest(".canvas-source-panel")?.querySelector<HTMLElement>(".library-return-canvas");
    if (back) observer.observe(back);
    return () => { observer.disconnect(); navigation.style.removeProperty("--library-navigation-shift"); };
  }, [open, loading, failed, colors, color, colorRebuild]);
  function focusTrigger() {
    root.current?.querySelector<HTMLButtonElement>('[data-filter="colors"]')?.focus();
  }
  useEffect(() => { if (!libraryOpen) setOpen(false); }, [libraryOpen]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true); setFailed(false);
    // Global controls must not inherit the currently open project's catalogue.
    const request = api.paletteOverview(null).then(value => { if (alive) setColors(value); });
    request.catch(() => { if (alive) setFailed(true); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, palette, colorBusy, revision]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[role="dialog"]')?.focus());
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      setOpen(false); focusTrigger();
    }
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  function selectColor(key: string | null) {
    const state = useStore.getState();
    state.setColorFilter(color === key ? null : key);
    state.clearSelect();
  }
  async function rebuild() {
    setRebuilding(true);
    try { await api.recomputeColors(); setRevision(value => value + 1); }
    catch (error) { notifyError(error, "色板重建失败"); }
    finally { setRebuilding(false); }
  }
  return <>
    <div ref={root} className="library-floating-filter">
      <div className={`library-color-control${open ? " is-open" : ""}`}>
        <button type="button" data-filter="colors" className="library-filter-trigger" aria-label="颜色筛选"
          title={`颜色筛选${color ? " · 已启用" : ""}`} data-active={!!color || undefined}
          aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined}
          onClick={() => setOpen(value => !value)}>
          <span className="library-rgb-orb" aria-hidden="true" />
          {color && <span className="library-filter-dot" aria-hidden="true" />}
        </button>
        {open && <div id={id} className="library-color-strip" role="dialog" aria-label="颜色筛选" tabIndex={-1}>
          {loading ? <span className="library-filter-notice" role="status">正在加载…</span>
            : failed ? <button type="button" className="library-filter-retry" onClick={() => setRevision(value => value + 1)}>加载失败 · 重试</button>
              : colors.length ? <div className="library-filter-colors">
                {colors.map(bucket => <button type="button" key={bucket.key} aria-label={COLOR_LABELS[bucket.key] ?? bucket.key}
                  title={`${COLOR_LABELS[bucket.key] ?? bucket.key} (${bucket.count})`} aria-pressed={color === bucket.key}
                  style={{ background: bucket.hex }} onClick={() => selectColor(bucket.key)}>
                  {color === bucket.key && <Check size={10} aria-hidden="true" />}
                </button>)}
              </div> : <span className="library-filter-notice">暂无色板，可尝试重建</span>}
          {colorRebuild && <span className="library-filter-notice" role="status">重建中 {colorRebuild.done}/{colorRebuild.total}</span>}
          {color && <button type="button" className="library-color-action" aria-label="清除颜色筛选" title="清除颜色筛选"
            onClick={() => selectColor(null)}><X size={12} aria-hidden="true" /></button>}
          <button type="button" className="library-color-action" aria-label="重建色板" title="后台重新量化全库主色"
            disabled={colorBusy || rebuilding} onClick={() => void rebuild()}><RefreshCw size={12} aria-hidden="true" /></button>
        </div>}
      </div>
    </div>
  </>;
}
