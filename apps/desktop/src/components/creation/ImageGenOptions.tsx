import { useEffect, useRef, useState } from "react";
import { ChevronDown, Layers } from "lucide-react";

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
}: {
  count: number;
  onCountChange: (v: number) => void;
  transparent: boolean;
  onTransparentChange: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = Math.min(MAX_GEN_COUNT, Math.max(1, Math.round(count) || 1));

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

  const label = transparent && current > 1 ? `透明 · ${current} 张` : transparent ? "透明" : current > 1 ? `${current} 张` : "选项";

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 items-center gap-1.5 rounded-[3px] border border-edge bg-panel2 px-2 text-xs text-ink outline-none hover:border-accent/60 hover:bg-edge focus:border-accent"
        title="生成选项：透明图层 / 张数（即梦与 Cloud 按张数分别提交，消耗相应积分）"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Layers size={13} />
        <span className={transparent || current > 1 ? "" : "text-muted"}>{label}</span>
        <ChevronDown size={12} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          className="app-popover absolute bottom-full left-0 z-30 mb-1 w-52 p-1.5"
          role="dialog"
          aria-label="生成选项"
        >
          <div className="app-popover-title">生成选项</div>
          <label
            className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 text-xs text-ink hover:bg-panel2"
            title="生成带透明背景的 PNG（background: transparent）"
          >
            <input
              type="checkbox"
              aria-label="透明图层"
              className="h-3.5 w-3.5 accent-[var(--bb-blue)]"
              checked={transparent}
              onChange={(event) => onTransparentChange(event.target.checked)}
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
                  onCountChange(n);
                  setOpen(false);
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
        </div>
      )}
    </div>
  );
}
