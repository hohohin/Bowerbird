import { useEffect, useRef } from "react";
import type { DrawShape } from "./ImageAnnotator";

const FONTS = [
  { name: "黑体", value: '"Microsoft YaHei", "PingFang SC", sans-serif' },
  { name: "宋体", value: 'SimSun, "Songti SC", serif' },
  { name: "等宽", value: 'Consolas, "Microsoft YaHei", monospace' },
];

/** 在当前图像坐标中排版；保存软换行，预览和导出使用同一组行。 */
export function finishTextShape(shape: DrawShape, width: number, height: number): DrawShape | null {
  const source = shape.textSource ?? shape.text ?? "";
  if (!source.trim()) return null;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;
  const size = (shape.fontRatio ?? 0.03) * width;
  const boxWidth = (shape.textWidthRatio ?? 0.35) * width;
  context.font = `${shape.fontWeight} ${size}px ${shape.fontFamily}`;
  const lines = source.split("\n").flatMap(paragraph => {
    const wrapped: string[] = [];
    let line = "";
    for (const char of Array.from(paragraph)) {
      if (line && context.measureText(line + char).width > boxWidth) {
        wrapped.push(line);
        line = "";
      }
      line += char;
    }
    return [...wrapped, line];
  });
  const angle = (shape.rotation ?? 0) * Math.PI / 180;
  const textWidth = Math.max(...lines.map(line => context.measureText(line).width));
  const textHeight = size * lines.length * 1.25;
  const points = [[0, 0], [textWidth, 0], [textWidth, textHeight], [0, textHeight]].map(([x, y]) => {
    const dx = shape.mirrored ? -x : x;
    return { x: shape.x1 + (dx * Math.cos(angle) - y * Math.sin(angle)) / width,
      y: shape.y1 + (dx * Math.sin(angle) + y * Math.cos(angle)) / height };
  });
  return { ...shape, textSource: source, text: lines.join("\n"), points,
    x2: points[2].x, y2: points[2].y };
}

export function AnnotationTextEditor({ shape, width, height, onChange, onCommit, onCancel }: {
  shape: DrawShape; width: number; height: number;
  onChange: (shape: DrawShape) => void; onCommit: () => void; onCancel: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<{ x: number; y: number; width: number } | null>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const size = (shape.fontRatio ?? 0.03) * width;
  const boxWidth = (shape.textWidthRatio ?? 0.35) * width;
  const layout = finishTextShape(shape, width, height);
  const rows = Math.max(1, layout?.text?.split("\n").length ?? 1);
  const update = (patch: Partial<DrawShape>) => onChange({ ...shape, ...patch });
  return <div data-annotation-text-editor>
    <div role="toolbar" aria-label="文本样式" className="absolute z-20 flex flex-wrap items-center gap-2 border p-2 text-xs shadow-lg"
      style={{ left: Math.max(0, Math.min(shape.x1 * width, width - 340)),
        top: shape.y1 * height < 48 ? shape.y1 * height + rows * size * 1.25 + 12 : shape.y1 * height - 48, maxWidth: width,
        background: "var(--bb-surface)", color: "var(--bb-ink)", borderColor: "var(--bb-line)" }}>
      <select aria-label="字体" value={shape.fontFamily} onChange={e => update({ fontFamily: e.target.value })}
        className="bg-transparent" style={{ color: "inherit" }}>
        {FONTS.map(font => <option key={font.name} value={font.value}>{font.name}</option>)}
      </select>
      <input aria-label="字号" type="number" min={8} max={200} value={Math.round(size)}
        onChange={e => update({ fontRatio: Math.max(8, Math.min(200, Number(e.target.value) || 8)) / width })}
        className="w-14 bg-transparent" />
      <button type="button" aria-pressed={shape.fontWeight === 700}
        onClick={() => update({ fontWeight: shape.fontWeight === 700 ? 400 : 700 })}>粗体</button>
      <input aria-label="文字颜色" type="color" value={shape.color}
        onChange={e => update({ color: e.target.value })} className="h-6 w-7 bg-transparent" />
    </div>
    <div className="absolute z-10" style={{ left: shape.x1 * width, top: shape.y1 * height,
      width: boxWidth, transformOrigin: "0 0",
      transform: `rotate(${shape.rotation ?? 0}deg) scaleX(${shape.mirrored ? -1 : 1})` }}>
      <textarea ref={input} aria-label="文字内容" value={shape.textSource ?? shape.text ?? ""}
        onChange={e => update({ textSource: e.target.value })}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onCommit(); }
        }}
        style={{ display: "block", width: "100%", height: Math.max(size * 1.25, rows * size * 1.25 + 4),
          padding: 0, border: 0, outline: "1px solid var(--bb-blue)", resize: "none", overflow: "hidden",
          background: "transparent", color: shape.color, fontSize: size, fontFamily: shape.fontFamily,
          fontWeight: shape.fontWeight, lineHeight: 1.25, overflowWrap: "anywhere", wordBreak: "break-all" }} />
      <button type="button" aria-label="调整文本框宽度" title="调整文本框宽度"
        className="absolute -right-2 -bottom-2 h-4 w-4 cursor-ew-resize border"
        style={{ background: "var(--bb-surface)", borderColor: "var(--bb-blue)" }}
        onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, width: boxWidth }; }}
        onPointerMove={e => {
          if (!drag.current) return;
          const angle = (shape.rotation ?? 0) * Math.PI / 180;
          const distance = ((e.clientX - drag.current.x) * Math.cos(angle) + (e.clientY - drag.current.y) * Math.sin(angle)) * (shape.mirrored ? -1 : 1);
          update({ textWidthRatio: Math.max(40, Math.min(width, drag.current.width + distance)) / width });
        }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
    </div>
  </div>;
}
