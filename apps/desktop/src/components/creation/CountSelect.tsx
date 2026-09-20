import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Layers } from "lucide-react";

export const MAX_GEN_COUNT = 4;

/**
 * 创作板编辑框工具条上的「生成数量」选择器（1–4 张）。形态与 RatioSelect 一致：
 * 定宽 popover 下拉，点外部 / Esc 关闭，选中项打勾。仅即梦与 Cloud 生图引擎
 * 显示（codex 沿用提示词驱动张数）；视频与 Agent 模式不适用。
 */
export function CountSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = Math.min(MAX_GEN_COUNT, Math.max(1, Math.round(value) || 1));

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 items-center gap-1.5 rounded-[3px] border border-edge bg-panel2 px-2 text-xs text-ink outline-none hover:border-accent/60 hover:bg-edge focus:border-accent"
        title="选择生成数量"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Layers size={13} />
        <span>{current} 张</span>
        <ChevronDown size={12} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          className="app-popover absolute bottom-full left-0 z-30 mb-1 w-36 p-1.5"
          role="listbox"
          aria-label="生成数量"
        >
          <div className="app-popover-title">生成数量</div>
          {Array.from({ length: MAX_GEN_COUNT }, (_, index) => index + 1).map((n) => {
            const selected = n === current;
            return (
              <button
                key={n}
                type="button"
                onClick={() => {
                  onChange(n);
                  setOpen(false);
                }}
                role="option"
                aria-selected={selected}
                title={`生成 ${n} 张图片`}
                className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1.5 text-xs ${
                  selected
                    ? "bg-panel2 font-medium text-ink"
                    : "text-muted hover:bg-panel2 hover:text-ink"
                }`}
              >
                <span className="min-w-0 flex-1 text-left">{n} 张</span>
                {selected && <Check size={13} className="shrink-0 text-accent" />}
              </button>
            );
          })}
          <div className="px-1.5 pt-1 text-[10px] leading-3 text-muted">
            即梦与 Cloud 按张数分别提交，消耗相应积分
          </div>
        </div>
      )}
    </div>
  );
}
