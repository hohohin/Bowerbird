import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { RATIOS, ratioIconBox, type Ratio } from "./ratios";

/**
 * 画面比例的 icon：固定外框（box×box）居中一个按 w:h 等比缩放的描边矩形，
 * 视觉直观体现比例。dashed 用于「自动（未指定）」占位态。颜色随父级 currentColor（选中反白可读）。
 */
function RatioIcon({
  ratio,
  box = 16,
  dashed,
}: {
  ratio: Pick<Ratio, "w" | "h">;
  box?: number;
  dashed?: boolean;
}) {
  const { width, height } = ratioIconBox(ratio, box);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center align-middle"
      style={{ width: box, height: box }}
      aria-hidden
    >
      <span
        className={"block border border-current" + (dashed ? " border-dashed" : "")}
        style={{ width, height }}
      />
    </span>
  );
}

/**
 * 创作板编辑框工具条上的「画面比例」选择器。形态与 ProviderSelect 一致：
 * 定宽 popover 下拉（absolute 浮层 + 点外部 / Esc 关闭），选项三列网格
 * （自动 + 各比例 icon），选中项打勾；value=null 表示「自动」——发送时若有
 * 参考图则跟随首张参考图的宽高比选档（store.startGeneration 解析），否则交引擎默认。
 */
export function RatioSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = RATIOS.find((r) => r.key === value) ?? null;

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

  function pick(key: string | null) {
    onChange(key);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 items-center gap-1.5 rounded-[3px] border border-edge bg-panel2 px-2 text-xs text-ink outline-none hover:border-accent/60 hover:bg-edge focus:border-accent"
        title="选择画面比例"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current ? (
          <>
            <RatioIcon ratio={current} />
            <span>{current.key}</span>
          </>
        ) : (
          <>
            <RatioIcon ratio={{ w: 1, h: 1 }} dashed />
            <span className="text-muted">自动</span>
          </>
        )}
        <ChevronDown size={12} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          className="app-popover absolute bottom-full left-0 z-30 mb-1 w-52 p-1.5"
          role="listbox"
          aria-label="画面比例"
        >
          <div className="app-popover-title">画面比例</div>
          <div className="grid grid-cols-3 gap-1">
            <button
              type="button"
              onClick={() => pick(null)}
              role="option"
              aria-selected={value === null}
              title="有参考图时跟随首张参考图的比例，否则由引擎决定"
              className={`flex items-center gap-1.5 rounded px-1.5 py-1.5 text-xs ${
                value === null
                  ? "bg-panel2 font-medium text-ink"
                  : "text-muted hover:bg-panel2 hover:text-ink"
              }`}
            >
              <RatioIcon ratio={{ w: 1, h: 1 }} dashed />
              <span className="min-w-0 flex-1 text-left">自动</span>
              {value === null && <Check size={13} className="shrink-0 text-accent" />}
            </button>
            {RATIOS.map((r) => {
              const selected = r.key === value;
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => pick(r.key)}
                  role="option"
                  aria-selected={selected}
                  title={`画面比例 ${r.key}`}
                  className={`flex items-center gap-1.5 rounded px-1.5 py-1.5 text-xs ${
                    selected
                      ? "bg-panel2 font-medium text-ink"
                      : "text-muted hover:bg-panel2 hover:text-ink"
                  }`}
                >
                  <RatioIcon ratio={r} />
                  <span className="min-w-0 flex-1 text-left">{r.key}</span>
                  {selected && <Check size={13} className="shrink-0 text-accent" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
