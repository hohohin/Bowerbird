import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Layers } from "lucide-react";
import { tacticalSelectPosition } from "../tacticalSelectLogic";

export const MAX_GEN_COUNT = 4;

/**
 * 创作板编辑框工具条上的「生成选项」弹层（仅即梦与 Cloud 生图引擎显示；codex 沿用
 * 提示词驱动张数；视频与 Agent 模式不适用）。张数不再常驻工具条（默认 1 张不占位），
 * 与「透明图层」复选框一起收进本弹层：勾选透明图层后生图请求携带
 * background: transparent（Ark 官方参数；即梦 CLI 无对应 flag，由后端以提示词注入近似）。
 * 触发钮形态与 RatioSelect 一致，非默认选项激活时以文字回显当前状态。
 */
export function ImageGenOptions({
  count,
  onCountChange,
  transparent,
  onTransparentChange,
  alwaysShowCount = false,
}: {
  count: number;
  onCountChange: (v: number) => void;
  transparent: boolean;
  onTransparentChange: (v: boolean) => void;
  alwaysShowCount?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof tacticalSelectPosition> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const current = Math.min(MAX_GEN_COUNT, Math.max(1, Math.round(count) || 1));

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    if (open && triggerRef.current?.matches(":disabled")) close();
  });
  useLayoutEffect(() => {
    if (!open) return;
    function place(event?: Event) {
      if (event?.target instanceof Node && menuRef.current?.contains(event.target)) return;
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect || !menuRef.current) return;
      setPosition(tacticalSelectPosition(rect, { width: 208, height: menuRef.current.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }));
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) close();
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    }
    function closeOnOutsideWheel(event: WheelEvent) {
      if (!menuRef.current?.contains(event.target as Node)) close();
    }
    document.addEventListener("pointerdown", closeOnOutsideClick, true);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("wheel", closeOnOutsideWheel, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick, true);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("wheel", closeOnOutsideWheel, true);
    };
  }, [open]);

  const label = transparent && current > 1 ? `透明 · ${current} 张` : transparent ? "透明" : current > 1 || alwaysShowCount ? `${current} 张` : "选项";

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); setOpen((v) => !v); }}
        onKeyDown={event => {
          if (!open) return;
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
          if (event.key === "Tab" && !event.shiftKey) { event.preventDefault(); menuRef.current?.querySelector<HTMLInputElement>("input")?.focus(); }
        }}
        className="tactical-menu-trigger flex h-7 items-center gap-1.5 border px-2 text-xs outline-none"
        title="生成选项：透明图层 / 张数（即梦与 Cloud 按张数分别提交，消耗相应积分）"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <Layers size={13} />
        <span className={transparent || current > 1 ? "" : "text-muted"}>{label}</span>
        <ChevronDown size={12} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="app-popover image-options-menu w-52 p-1.5"
          style={{ position: "fixed", ...position, overflowY: "auto", visibility: position ? "visible" : "hidden" }}
          role="dialog"
          aria-label="生成选项"
          onPointerDown={event => { if (!(event.target instanceof Element && event.target.closest("label"))) event.preventDefault(); event.stopPropagation(); }}
          onPointerUp={event => event.stopPropagation()}
          onMouseDown={event => { if (!(event.target instanceof Element && event.target.closest("label"))) event.preventDefault(); event.stopPropagation(); }}
          onClick={event => event.stopPropagation()}
          onWheel={event => event.stopPropagation()}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === "Escape") { event.preventDefault(); close(true); }
            if (event.key === "Tab") {
              const controls = menuRef.current?.querySelectorAll<HTMLElement>("input,button");
              if (event.shiftKey && event.target === controls?.[0]) { event.preventDefault(); close(true); }
              else if (!event.shiftKey && event.target === controls?.[(controls?.length ?? 0) - 1]) close(true);
            }
          }}
        >
          <div className="app-popover-title">生成选项</div>
          <label
            className="image-options-toggle flex cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 text-xs text-ink hover:bg-panel2"
            title="生成带透明背景的 PNG（background: transparent）"
          >
            <input
              type="checkbox"
              aria-label="透明图层"
              className="h-3.5 w-3.5 accent-[var(--bb-blue)]"
              checked={transparent}
              onChange={(event) => { if (!triggerRef.current?.matches(":disabled")) onTransparentChange(event.target.checked); }}
            />
            透明图层
          </label>
          <div className="px-1.5 pb-1 pt-2 text-[10px] leading-3 text-muted">
            张数（即梦与 Cloud 按张数分别提交，消耗相应积分）
          </div>
          <div className="flex gap-1">
            {Array.from({ length: MAX_GEN_COUNT }, (_, index) => index + 1).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  if (triggerRef.current?.matches(":disabled")) { close(); return; }
                  onCountChange(n);
                  close(true);
                }}
                role="option"
                aria-selected={n === current}
                title={`生成 ${n} 张图片`}
                className="app-popover-option count-select-option"
              >
                {n} 张
              </button>
            ))}
          </div>
        </div>, document.body
      )}
    </div>
  );
}
