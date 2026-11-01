import { useEffect, useRef } from "react";
import { annotationTextLayout, finishTextShape, type AnnotationTool, type DrawShape } from "../lib/annotation";
import "./AnnotationTextEditor.css";

const FONTS = [
  { name: "黑体", value: '"Microsoft YaHei", "PingFang SC", sans-serif' },
  { name: "宋体", value: 'SimSun, "Songti SC", serif' },
  { name: "等宽", value: 'Consolas, "Microsoft YaHei", monospace' },
];

export function AnnotationTextEditor<T extends AnnotationTool>({ shape, width, height, onChange, onCommit, onCancel, label = "文字内容" }: {
  shape: DrawShape<T>; width: number; height: number; label?: string;
  onChange: (shape: DrawShape<T>) => void; onCommit: () => void; onCancel: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<{ x: number; y: number; width: number } | null>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const { source, size, boxWidth } = annotationTextLayout(shape, width);
  const layout = finishTextShape(shape, width, height);
  const rows = Math.max(1, layout?.text?.split("\n").length ?? 1);
  const update = (patch: Partial<DrawShape<T>>) => onChange({ ...shape, ...patch });
  return <div data-annotation-text-editor className="annotation-text-editor">
    <div role="toolbar" aria-label="文本样式" className="annotation-text-style"
      style={{ left: Math.max(0, Math.min(shape.x1 * width, width - 340)),
        top: shape.y1 * height < 48 ? shape.y1 * height + rows * size * 1.25 + 12 : shape.y1 * height - 48, maxWidth: width,
        background: "var(--bb-surface, #272d2f)", color: "var(--bb-ink, #f4f4f5)", borderColor: "var(--bb-line, #747474)" }}>
      <select aria-label="字体" value={shape.fontFamily} onChange={e => update({ fontFamily: e.target.value })}
        style={{ color: "inherit", background: "transparent" }}>
        {FONTS.map(font => <option key={font.name} value={font.value}>{font.name}</option>)}
      </select>
      <input aria-label="字号" type="number" min={8} max={200} value={Math.round(size)}
        onChange={e => update({ fontRatio: Math.max(8, Math.min(200, Number(e.target.value) || 8)) / width })}
        style={{ width: 56, background: "transparent" }} />
      <button type="button" aria-pressed={shape.fontWeight === 700}
        onClick={() => update({ fontWeight: shape.fontWeight === 700 ? 400 : 700 })}>粗体</button>
      <input aria-label="文字颜色" type="color" value={shape.color}
        onChange={e => update({ color: e.target.value })} style={{ height: 24, width: 28, background: "transparent" }} />
    </div>
    <div style={{ position: "absolute", zIndex: 10, left: shape.x1 * width, top: shape.y1 * height,
      width: boxWidth, transformOrigin: "0 0",
      transform: `rotate(${shape.rotation ?? 0}deg) scaleX(${shape.mirrored ? -1 : 1})` }}>
      <textarea ref={input} aria-label={label} value={source}
        onChange={e => update({ textSource: e.target.value })}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onCommit(); }
        }}
        style={{ display: "block", width: "100%", height: Math.max(size * 1.25, rows * size * 1.25 + 4),
          padding: 0, border: 0, outline: "1px solid var(--bb-blue, #8faab8)", resize: "none", overflow: "hidden",
          background: "transparent", userSelect: "text", color: shape.color, fontSize: size, fontFamily: shape.fontFamily,
          fontWeight: shape.fontWeight, lineHeight: 1.25, overflowWrap: "anywhere", wordBreak: "break-all" }} />
      <button type="button" aria-label="调整文本框宽度" title="调整文本框宽度"
        className="annotation-text-resize"
        style={{ background: "var(--bb-surface, #272d2f)", borderColor: "var(--bb-blue, #8faab8)" }}
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
