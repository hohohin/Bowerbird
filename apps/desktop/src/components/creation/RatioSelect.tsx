import { useState } from "react";
import { RATIOS, ratioIconBox, type Ratio } from "./ratios";

/**
 * 画面比例的 icon：固定外框（box×box）居中一个按 w:h 等比缩放的描边矩形，
 * 视觉直观体现比例。dashed 用于「未指定」占位态。颜色随父级 currentColor（选中反白可读）。
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
 * 创作板编辑框工具条上的「画面比例」选择器。
 *
 * 形态 = inline 展开（非 absolute 浮层）：复用项目既有 inline 面板范式（收藏夹 panel / 维度 chips）
 * —— 点触发按钮 toggle 一个在下方正常文档流里展开的 chip 面板，选中即收 / ✕ 收，
 * 无点外部关闭、无全局 Esc 监听、无 z-index / shadow。
 *
 * value=null 表示「自动」（不指定比例，发送时不注入 instruction，与改动前行为一致）。
 */
export function RatioSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = RATIOS.find((r) => r.key === value) ?? null;

  function pick(key: string | null) {
    onChange(key);
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded bg-panel2 px-2 py-1 text-xs text-ink outline-none ring-1 ring-edge hover:bg-edge focus:ring-accent"
        title="选择画面比例"
      >
        {current ? (
          <>
            <RatioIcon ratio={current} />
            <span>{current.key}</span>
          </>
        ) : (
          <>
            <RatioIcon ratio={{ w: 1, h: 1 }} dashed />
            <span className="text-muted">比例</span>
          </>
        )}
        <span className="text-muted">▾</span>
      </button>

      {open && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded bg-panel2 p-2">
          <button
            type="button"
            onClick={() => pick(null)}
            className={
              "rounded px-1.5 py-1 text-xs " +
              (value === null
                ? "bg-accent font-semibold text-black"
                : "bg-panel text-muted hover:bg-edge hover:text-ink")
            }
          >
            自动
          </button>
          {RATIOS.map((r) => {
            const selected = r.key === value;
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => pick(r.key)}
                className={
                  "flex items-center gap-1 rounded px-1.5 py-1 text-xs " +
                  (selected
                    ? "bg-accent font-semibold text-black"
                    : "bg-panel text-muted hover:bg-edge hover:text-ink")
                }
              >
                <RatioIcon ratio={r} />
                <span>{r.key}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="ml-auto shrink-0 rounded px-1 text-muted hover:bg-panel hover:text-ink"
            title="收起"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
