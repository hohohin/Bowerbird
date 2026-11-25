import type { CSSProperties } from "react";
import type { DraftRect } from "../lib/draftDocument";
import type { DraftCropHandle } from "../lib/draftCrop";

const HANDLES = [
  ["nw", "左上", 0, 0], ["n", "上边", .5, 0], ["ne", "右上", 1, 0], ["e", "右边", 1, .5],
  ["se", "右下", 1, 1], ["s", "下边", .5, 1], ["sw", "左下", 0, 1], ["w", "左边", 0, .5],
] as const;

export function DraftCropOverlay({ rect, width, height, fit, zoom, disabled, onNudge }: {
  rect: DraftRect; width: number; height: number; fit: number; zoom: number; disabled: boolean;
  onNudge: (handle: DraftCropHandle, dx: number, dy: number) => void;
}) {
  const { x, y, width: w, height: h } = rect;
  return <>
    <svg className="draft-overlay draft-crop-grid" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={`M-100000 -100000H100000V100000H-100000Z M${x} ${y}v${h}h${w}v${-h}Z`} fill="#0007" fillRule="evenodd" />
      <rect {...rect} className="draft-crop-border" vectorEffect="non-scaling-stroke" />
      {[1, 2].map(n => <g key={n}>
        <line x1={x + w * n / 3} x2={x + w * n / 3} y1={y} y2={y + h} vectorEffect="non-scaling-stroke" />
        <line x1={x} x2={x + w} y1={y + h * n / 3} y2={y + h * n / 3} vectorEffect="non-scaling-stroke" />
      </g>)}
    </svg>
    {HANDLES.map(([handle, name, fx, fy]) => <button key={handle} className={`draft-crop-handle is-${handle}`} data-draft-crop-handle={handle}
      aria-label={`裁剪${name}`} title={`${name} · 方向键微调，Shift 加速`} disabled={disabled}
      style={{ left: (x + w * fx) * fit, top: (y + h * fy) * fit, transform: `translate(-50%, -50%) scale(${1 / zoom})` } as CSSProperties}
      onKeyDown={event => {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta) return;
        event.preventDefault(); event.stopPropagation();
        const step = event.shiftKey ? 10 : 1; onNudge(handle, delta[0] * step, delta[1] * step);
      }} />)}
  </>;
}
