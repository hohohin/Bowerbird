import { useRef, useState } from "react";
import { CanvasResizeHandle } from "./CanvasResizeHandle";
import { CanvasBubbleTail } from "./CanvasBubbleTail";
import { AlignCenter, AlignLeft, AlignRight, Bold, Check, ChevronsDownUp, ChevronsUpDown, Copy, GripHorizontal, Italic, Minus, Plus, Type, Undo2 } from "lucide-react";
import { canvasTextMinSize, emptyCanvasCell, type CanvasNotePayload, type CanvasTextCell } from "../lib/canvasNotes";
import { notifyError } from "../lib/notify";

export function CanvasTextCard({ value, selected, width, height, zoom, onChange, onSelect, onResize }: {
  value: CanvasNotePayload;
  selected: boolean;
  width: number;
  height: number;
  zoom: number;
  onChange: (value: CanvasNotePayload) => void;
  onSelect: () => void;
  onResize: (size: { width: number; height: number }, finished: boolean, cancelled?: boolean) => void;
}) {
  const [active, setActive] = useState<[number, number]>([0, 0]);
  const [copied, setCopied] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ axis: "row" | "column"; index: number } | null>(null);
  const [removed, setRemoved] = useState<{ value: CanvasNotePayload; active: [number, number] } | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const cell = value.cells[active[0]]?.[active[1]] ?? value.cells[0][0];
  const lineHeight = value.line_height_percent ?? 165;
  const bubble = value.note_type === "bubble";
  function changeLineHeight(change: number) {
    setRemoved(null);
    onSelect();
    onChange({ ...value, line_height_percent: Math.max(100, Math.min(300, lineHeight + change)) });
  }
  function updateCell(row: number, column: number, change: Partial<CanvasTextCell>) {
    setRemoved(null);
    const cells = value.cells.map((line, r) => line.map((item, c) => r === row && c === column ? { ...item, ...change } : item));
    onChange({ ...value, cells, text: cells.map(line => line.map(item => item.text).join("\t")).join("\n") });
  }
  function insert(axis: "row" | "column", index: number) {
    setRemoved(null);
    setCopied(null);
    const cells = axis === "row"
      ? [...value.cells.slice(0, index), value.cells[0].map(() => emptyCanvasCell()), ...value.cells.slice(index)]
      : value.cells.map(line => [...line.slice(0, index), emptyCanvasCell(), ...line.slice(index)]);
    setActive(axis === "row" ? [index, active[1]] : [active[0], index]);
    onSelect();
    onChange({ ...value, cells, text: cells.map(line => line.map(item => item.text).join("\t")).join("\n") });
  }
  function focusCell(position: [number, number], columns: number) {
    setActive(position);
    window.requestAnimationFrame(() => grid.current?.querySelectorAll("textarea")[position[0] * columns + position[1]]?.focus());
  }
  function remove(axis: "row" | "column", index: number) {
    const count = axis === "row" ? value.cells.length : value.cells[0].length;
    if (count <= 1) return;
    const cells = axis === "row" ? value.cells.filter((_, row) => row !== index)
      : value.cells.map(line => line.filter((_, column) => column !== index));
    const next: [number, number] = [...active];
    const dimension = axis === "row" ? 0 : 1;
    next[dimension] = Math.min(next[dimension] > index ? next[dimension] - 1 : next[dimension], count - 2);
    setRemoved({ value, active });
    setCopied(null);
    setRemoving(null);
    onSelect();
    onChange({ ...value, cells, text: cells.map(line => line.map(item => item.text).join("\t")).join("\n") });
    focusCell(next, cells[0].length);
  }
  return <>
    {selected && <div className="canvas-text-stylebar" role="toolbar" aria-label="文本样式（当前单元格）"
      onPointerDown={event => { event.stopPropagation(); event.preventDefault(); }}>
      <button title="加粗" aria-label="加粗" aria-pressed={cell.bold} onClick={() => updateCell(...active, { bold: !cell.bold })}><Bold size={16} /></button>
      <button title="斜体" aria-label="斜体" aria-pressed={cell.italic} onClick={() => updateCell(...active, { italic: !cell.italic })}><Italic size={16} /></button>
      <span />
      {([["left", "左对齐", AlignLeft], ["center", "居中对齐", AlignCenter], ["right", "右对齐", AlignRight]] as const).map(([align, label, Icon]) =>
        <button key={align} title={label} aria-label={label} aria-pressed={cell.align === align} onClick={() => updateCell(...active, { align })}><Icon size={16} /></button>)}
      {removed && <><span /><button title="撤销删除" aria-label="撤销删除行列" onClick={() => {
        onChange(removed.value);
        focusCell(removed.active, removed.value.cells[0].length);
        setRemoved(null);
      }}><Undo2 size={16} /></button></>}
    </div>}
    <div className="canvas-text-handle" title="拖动文本卡片"><GripHorizontal size={15} /><Type size={14} /></div>
    <div className="canvas-text-spacing" role="group" aria-label="文字行距"
      onPointerDown={event => { event.stopPropagation(); event.preventDefault(); }} onKeyDown={event => event.stopPropagation()}>
      <button aria-label="减小行距" title="减小行距" disabled={lineHeight <= 100} onClick={() => changeLineHeight(-10)}><ChevronsDownUp size={14} /></button>
      <button aria-label="增大行距" title="增大行距" disabled={lineHeight >= 300} onClick={() => changeLineHeight(10)}><ChevronsUpDown size={14} /></button>
    </div>
    <div ref={grid} className="canvas-text-grid" role={bubble ? "group" : "table"} aria-label={bubble ? "气泡便签" : "文本卡片"} onPointerDown={event => { event.stopPropagation(); onSelect(); }} onKeyDown={event => event.stopPropagation()}
      onWheel={event => { if (!event.ctrlKey && !event.metaKey) event.stopPropagation(); }}>
      {value.cells.map((line, row) => <div role={bubble ? undefined : "row"} className="canvas-text-row" key={row}>
        {line.map((item, column) => <div role={bubble ? undefined : "cell"} className={`canvas-text-cell ${removing && (removing.axis === "row" ? removing.index === row : removing.index === column) ? "is-removing" : ""}`} key={column}>
          <textarea aria-label={bubble ? "气泡便签内容" : `第 ${row + 1} 行第 ${column + 1} 列`} placeholder={bubble ? "添加说明或标签…" : "输入文本…"} value={item.text}
            style={{ fontWeight: item.bold ? 700 : 400, fontStyle: item.italic ? "italic" : "normal", textAlign: item.align, lineHeight: lineHeight / 100 }}
            onFocus={() => { setActive([row, column]); onSelect(); }}
            onChange={event => updateCell(row, column, { text: event.target.value })} />
          <button className="canvas-cell-copy" title="复制文本" aria-label={`复制第 ${row + 1} 行第 ${column + 1} 列`}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(item.text);
                const key = `${row}:${column}`;
                setCopied(key);
                window.setTimeout(() => setCopied(current => current === key ? null : current), 1200);
              } catch (error) { notifyError(error, "复制失败"); }
            }}>{copied === `${row}:${column}` ? <Check size={13} /> : <Copy size={13} />}</button>
        </div>)}
      </div>)}
      {!bubble && (["row", "column"] as const).flatMap(axis => {
        const count = axis === "row" ? value.cells.length : value.cells[0].length;
        return Array.from({ length: count + 1 }, (_, index) => <button key={`${axis}-${index}`}
          className={`canvas-text-insert is-${axis}`} aria-label={`在第 ${index + 1} ${axis === "row" ? "行" : "列"}位置插入`}
          title={`插入${axis === "row" ? "行" : "列"}`} style={axis === "row" ? { top: `${index / count * 100}%` } : { left: `${index / count * 100}%` }}
          onPointerDown={event => { event.stopPropagation(); event.preventDefault(); }}
          onClick={() => insert(axis, index)}><Plus size={14} /></button>);
      })}
      {!bubble && (["row", "column"] as const).flatMap(axis => {
        const count = axis === "row" ? value.cells.length : value.cells[0].length;
        if (count <= 1) return [];
        return Array.from({ length: count }, (_, index) => <button key={`remove-${axis}-${index}`}
          className={`canvas-text-remove is-${axis}`} aria-label={`删除第 ${index + 1} ${axis === "row" ? "行" : "列"}`}
          title={`删除第 ${index + 1} ${axis === "row" ? "行" : "列"}`}
          style={axis === "row" ? { top: `${(index + 0.5) / count * 100}%` } : { left: `${(index + 0.5) / count * 100}%` }}
          onPointerEnter={() => setRemoving({ axis, index })} onPointerLeave={() => setRemoving(null)}
          onFocus={() => setRemoving({ axis, index })} onBlur={() => setRemoving(null)}
          onPointerDown={event => { event.stopPropagation(); event.preventDefault(); }}
          onClick={() => remove(axis, index)}><Minus size={14} /></button>);
      })}
    </div>
    {bubble && <CanvasBubbleTail value={value.bubble_tail ?? { side: "bottom", position: 25 }} width={width} height={height}
      onSelect={onSelect} onChange={tail => onChange({ ...value, bubble_tail: tail })} />}
    {selected && <CanvasResizeHandle label="调整文本卡片大小" size={{ width, height }} zoom={zoom}
      minimum={canvasTextMinSize(value.cells)} onResize={onResize} />}
  </>;
}
