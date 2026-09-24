import { useEffect, useRef, useState, type PointerEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import type { Asset } from "../lib/types";
import { canvasAssetMediaPath } from "../lib/creativeCanvas";
import { BoardChipPreview } from "./creation/BoardChipPreview";
import { CanvasResizeHandle } from "./CanvasResizeHandle";
import { CanvasBubbleTail } from "./CanvasBubbleTail";
import { AlignCenter, AlignLeft, AlignRight, Bold, Check, ChevronsDownUp, ChevronsUpDown, Copy, GripHorizontal, Images, Italic, Minus, Plus, Type, Undo2 } from "lucide-react";
import { canvasCellValue, canvasGridWeights, canvasTextCsv, canvasTextMinSize, emptyCanvasCell, type CanvasNotePayload, type CanvasTextCell } from "../lib/canvasNotes";
import { notifyError } from "../lib/notify";

const MIN_GRID_WEIGHT_SHARE = 0.04;

export function CanvasTextCard({ value, selected, width, height, zoom, onChange, onSelect, onResize, onConnectCell, onInput, inputLocked, onOpenPreview }: {
  onOpenPreview?: (asset: Asset, group?: Asset[]) => void;
  onInput?: (cellId?: string, disconnect?: boolean, type?: "text" | "image") => void;
  inputLocked?: boolean;
  onConnectCell?: (cellId: string, clientX: number, clientY: number) => void;
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
  const [resizing, setResizing] = useState<{ axis: "row" | "column"; weights: number[] } | null>(null);
  const resizeDrag = useRef<{ axis: "row" | "column"; boundary: number; start: number; base: number; original: number[]; latest: number[]; pointerId: number } | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [referenceAssets, setReferenceAssets] = useState<Asset[]>([]);
  const referenceKey = [...new Set(value.cells.flat().flatMap(cell => canvasCellValue(cell).assetIds))].sort().join("|");
  useEffect(() => {
    let current = true;
    if (!referenceKey) { setReferenceAssets([]); return; }
    void api.getAssetsByIds(referenceKey.split("|")).then(assets => { if (current) setReferenceAssets(assets); }).catch(() => {});
    return () => { current = false; };
  }, [referenceKey]);
  const cell = value.cells[active[0]]?.[active[1]] ?? value.cells[0][0];
  const lineHeight = value.line_height_percent ?? 165;
  const bubble = value.note_type === "bubble";
  const images = cell.content_type === "image";
  const rows = value.cells.length;
  const columns = value.cells[0]?.length ?? 1;
  const columnWeights = canvasGridWeights(resizing?.axis === "column" ? resizing.weights : value.column_widths, columns);
  const rowWeights = canvasGridWeights(resizing?.axis === "row" ? resizing.weights : value.row_heights, rows);
  const boundaryFraction = (weights: number[], index: number) => weights.slice(0, index).reduce((sum, weight) => sum + weight, 0) / weights.reduce((sum, weight) => sum + weight, 0);
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
    if (inputLocked) return;
    setRemoved(null);
    setCopied(null);
    const cells = axis === "row"
      ? [...value.cells.slice(0, index), value.cells[0].map(() => ({ ...emptyCanvasCell(), id: crypto.randomUUID() })), ...value.cells.slice(index)]
      : value.cells.map(line => [...line.slice(0, index), { ...emptyCanvasCell(), id: crypto.randomUUID() }, ...line.slice(index)]);
    const weights = [...(axis === "row" ? rowWeights : columnWeights)];
    weights.splice(index, 0, 1);
    setActive(axis === "row" ? [index, active[1]] : [active[0], index]);
    onSelect();
    onChange({
      ...value,
      cells,
      text: cells.map(line => line.map(item => item.text).join("\t")).join("\n"),
      ...(axis === "row" ? { row_heights: weights } : { column_widths: weights }),
    });
  }
  function focusCell(position: [number, number], columns: number) {
    setActive(position);
    window.requestAnimationFrame(() => grid.current?.querySelectorAll("textarea")[position[0] * columns + position[1]]?.focus());
  }
  function remove(axis: "row" | "column", index: number) {
    if (inputLocked) return;
    const count = axis === "row" ? value.cells.length : value.cells[0].length;
    if (count <= 1) return;
    const cells = axis === "row" ? value.cells.filter((_, row) => row !== index)
      : value.cells.map(line => line.filter((_, column) => column !== index));
    const weights = [...(axis === "row" ? rowWeights : columnWeights)];
    weights.splice(index, 1);
    const next: [number, number] = [...active];
    const dimension = axis === "row" ? 0 : 1;
    next[dimension] = Math.min(next[dimension] > index ? next[dimension] - 1 : next[dimension], count - 2);
    setRemoved({ value, active });
    setCopied(null);
    setRemoving(null);
    onSelect();
    onChange({
      ...value,
      cells,
      text: cells.map(line => line.map(item => item.text).join("\t")).join("\n"),
      ...(axis === "row" ? { row_heights: weights } : { column_widths: weights }),
    });
    focusCell(next, cells[0].length);
  }
  function beginGridResize(event: PointerEvent<HTMLButtonElement>, axis: "row" | "column", boundary: number) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const rect = grid.current?.getBoundingClientRect();
    if (!rect || (axis === "column" ? rect.width : rect.height) <= 0) return;
    const weights = [...(axis === "column" ? columnWeights : rowWeights)];
    resizeDrag.current = {
      axis,
      boundary,
      start: axis === "column" ? event.clientX : event.clientY,
      base: axis === "column" ? rect.width : rect.height,
      original: weights,
      latest: weights,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    // preventDefault above suppresses the browser's implicit focus; without it
    // Escape during a drag would never reach this handle's keydown handler.
    event.currentTarget.focus();
    setRemoved(null);
    onSelect();
  }
  function moveGridResize(event: PointerEvent<HTMLButtonElement>) {
    const drag = resizeDrag.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    // Always measure from the weights captured at pointer down; re-adding the
    // running delta to live weights would compound it on every pointermove.
    const total = drag.original.reduce((sum, weight) => sum + weight, 0);
    const pair = drag.original[drag.boundary - 1] + drag.original[drag.boundary];
    const delta = ((drag.axis === "column" ? event.clientX : event.clientY) - drag.start) / drag.base * total;
    const minimum = total * MIN_GRID_WEIGHT_SHARE;
    const first = Math.min(Math.max(drag.original[drag.boundary - 1] + delta, minimum), pair - minimum);
    const weights = [...drag.original];
    weights[drag.boundary - 1] = first;
    weights[drag.boundary] = pair - first;
    drag.latest = weights;
    setResizing({ axis: drag.axis, weights });
  }
  function endGridResize(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const drag = resizeDrag.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    resizeDrag.current = null;
    setResizing(null);
    if (!cancelled) {
      onChange({ ...value, ...(drag.axis === "column" ? { column_widths: drag.latest } : { row_heights: drag.latest }) });
    }
  }
  function cancelGridResize() {
    resizeDrag.current = null;
    setResizing(null);
  }
  async function copyCsv() {
    try {
      await navigator.clipboard.writeText(canvasTextCsv(value.cells));
      setCopied("csv");
      window.setTimeout(() => setCopied(current => current === "csv" ? null : current), 1200);
    } catch (error) { notifyError(error, "复制失败"); }
  }
  return <>
    <BoardChipPreview hostRef={grid} extraAssets={referenceAssets} clickToFocus={false} />
    {!bubble && onInput && <button className="workflow-cell-port workflow-text-input" data-workflow-text-input="" aria-label="内容卡片输入"
      disabled={inputLocked} title="输入到第一列的新行；右键断开整体输入"
      onPointerDown={event => { event.stopPropagation(); event.preventDefault(); }}
      onClick={event => { event.stopPropagation(); if (event.detail === 0) onInput(); }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onInput(undefined, true); }} />}
    {!bubble && onInput && <button className="workflow-cell-port workflow-text-input workflow-content-image-input is-image-output" data-workflow-text-input="" data-content-input-type="image" aria-label="内容卡片图片输入"
      disabled={inputLocked} title="输入图片，每张图片新建一行；右键断开图片输入"
      onPointerDown={event => { event.stopPropagation(); event.preventDefault(); }}
      onClick={event => { event.stopPropagation(); if (event.detail === 0) onInput(undefined, false, "image"); }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onInput(undefined, true, "image"); }} />}
    {selected && !images && <div className="canvas-text-stylebar" role="toolbar" aria-label="文本样式（当前单元格）"
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
    <div className="canvas-text-handle" title="拖动内容卡片"><GripHorizontal size={15} />{images ? <Images size={14} /> : <Type size={14} />}
      {!bubble && <input className="canvas-text-title" aria-label="内容卡片标题" placeholder="内容卡片" value={value.title ?? ""}
        onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onFocus={onSelect}
        onChange={event => onChange({ ...value, title: event.target.value })} />}
    </div>
    {!bubble && onConnectCell && <button className="workflow-cell-port workflow-image-output" data-workflow-cell="*" aria-label="输出容器图片" title="输出全部图片"
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); onConnectCell("*", event.clientX, event.clientY); }}
      onClick={event => { if (event.detail === 0) onConnectCell("*", event.clientX, event.clientY); }} />}
    {!bubble && onConnectCell && <button className="workflow-cell-port workflow-content-text-output" data-workflow-cell="*text" aria-label="输出全部文本" title="汇总文本单元格"
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); onConnectCell("*text", event.clientX, event.clientY); }}
      onClick={event => { if (event.detail === 0) onConnectCell("*text", event.clientX, event.clientY); }} />}
    {images && removed && selected && <div className="canvas-text-spacing"><button aria-label="撤销删除行列" onClick={() => { onChange(removed.value); setActive(removed.active); setRemoved(null); }}><Undo2 size={14} /></button></div>}
    {!images && <div className="canvas-text-spacing" role="group" aria-label="文本工具"
      onPointerDown={event => { event.stopPropagation(); event.preventDefault(); }} onKeyDown={event => event.stopPropagation()}>
      <button aria-label="减小行距" title="减小行距" disabled={lineHeight <= 100} onClick={() => changeLineHeight(-10)}><ChevronsDownUp size={14} /></button>
      <button aria-label="增大行距" title="增大行距" disabled={lineHeight >= 300} onClick={() => changeLineHeight(10)}><ChevronsUpDown size={14} /></button>
      {!bubble && <button aria-label="复制表格为 CSV" title="复制表格为 CSV" onClick={copyCsv}>{copied === "csv" ? <Check size={13} /> : <Copy size={13} />}</button>}
    </div>}
    <div ref={grid} className="canvas-text-grid" role={bubble ? "group" : "table"} aria-label={bubble ? "气泡便签" : "内容卡片"} onPointerDown={event => { event.stopPropagation(); onSelect(); }} onKeyDown={event => event.stopPropagation()}
      onWheel={event => { if (!event.ctrlKey && !event.metaKey) event.stopPropagation(); }}>
      {value.cells.map((line, row) => <div role={bubble ? undefined : "row"} className="canvas-text-row" key={row} style={{ flexGrow: rowWeights[row] }}>
        {line.map((item, column) => { const images = item.content_type === "image"; return <div role={bubble ? undefined : "cell"} data-canvas-cell={bubble ? undefined : item.id} className={`canvas-text-cell ${images ? "is-image-cell" : ""} ${canvasCellValue(item).imageRefs.length ? "has-image-refs" : ""} ${removing && (removing.axis === "row" ? removing.index === row : removing.index === column) ? "is-removing" : ""}`} key={column} style={{ flexGrow: columnWeights[column] }} onPointerDown={() => setActive([row, column])}>
          {!bubble && onInput && <button className="workflow-cell-port is-input" data-workflow-text-input={item.id} aria-label={`输入第 ${row + 1} 行第 ${column + 1} 列`}
            disabled={inputLocked} title="输入文本或图片，替换此单元格；右键断开输入"
            onPointerDown={event => { event.stopPropagation(); event.preventDefault(); }}
            onClick={event => { event.stopPropagation(); if (event.detail === 0) onInput(item.id); }}
            onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onInput(item.id, true); }} />}
          {!bubble && onInput && <button className="workflow-cell-port is-input is-image-output workflow-cell-image-input" data-workflow-text-input={item.id} data-content-input-type="image" aria-label={`输入第 ${row + 1} 行第 ${column + 1} 列图片`}
            disabled={inputLocked} title="输入图片，替换此单元格；右键断开图片输入"
            onPointerDown={event => { event.stopPropagation(); event.preventDefault(); }}
            onClick={event => { event.stopPropagation(); if (event.detail === 0) onInput(item.id, false, "image"); }}
            onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onInput(item.id, true, "image"); }} />}
          {onConnectCell && <button className={`workflow-cell-port ${images ? "is-image-output" : ""}`} data-workflow-cell={item.id} aria-label={`输出第 ${row + 1} 行第 ${column + 1} 列${images ? "图片" : "文本"}`}
            title={images ? "拖动连接图片输入" : "拖动连接文本输入"} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); onConnectCell(item.id!, event.clientX, event.clientY); }}
            onClick={event => { if (event.detail === 0) onConnectCell(item.id!, event.clientX, event.clientY); }} />}
          {!images && <textarea aria-label={bubble ? "气泡便签内容" : `第 ${row + 1} 行第 ${column + 1} 列`} placeholder={bubble ? "添加说明或标签…" : "输入文本…"} value={item.text}
            readOnly={inputLocked}
            style={{ fontWeight: item.bold ? 700 : 400, fontStyle: item.italic ? "italic" : "normal", textAlign: item.align, lineHeight: lineHeight / 100 }}
            onFocus={() => { setActive([row, column]); onSelect(); }}
            onChange={event => updateCell(row, column, { text: event.target.value })} />}
          {images && !item.image_refs?.length && <div className="canvas-image-empty">连接图片输入</div>}
          {!!canvasCellValue(item).imageRefs.length && <div className={images ? "canvas-image-content" : "canvas-cell-images"}>{canvasCellValue(item).imageRefs.map(ref => {
            const asset = referenceAssets.find(asset => asset.id === ref.asset_id);
            const path = asset && canvasAssetMediaPath({ storePath: asset.store_path ?? null, thumbPath: asset.thumb_path ?? null });
            if (images) return <button type="button" className="canvas-image-preview" key={ref.token} disabled={!path || !onOpenPreview}
              title={path ? "点击放大" : "图片已不可用"} aria-label={`放大图片：${asset?.name ?? "图片已不可用"}`}
              onClick={event => {
                event.stopPropagation();
                if (asset) onOpenPreview?.(asset, value.cells.flat().flatMap(cell => canvasCellValue(cell).assetIds)
                  .filter((id, index, ids) => ids.indexOf(id) === index)
                  .flatMap(id => { const image = referenceAssets.find(candidate => candidate.id === id); return image ? [image] : []; }));
              }}>
              {path && <img draggable={false} src={path.startsWith("data:") ? path : convertFileSrc(path)} alt={asset?.name ?? "图片"} />}
            </button>;
            return <span key={ref.token} data-asset-id={ref.asset_id} title={asset?.name ?? "图片已不可用"}>
              {path && <img src={path.startsWith("data:") ? path : convertFileSrc(path)} alt={images ? asset?.name ?? "图片" : ""} />}{!images && ref.token}
            </span>;
          })}</div>}
          {images && !!item.image_refs?.length && <button className="canvas-cell-copy" title="清空图片" aria-label={`清空第 ${row + 1} 行第 ${column + 1} 列图片`} disabled={inputLocked} onClick={() => updateCell(row, column, { content_type: "text", text: "", image_refs: [] })}><Minus size={13} /></button>}
          {!images && <button className="canvas-cell-copy" title="复制文本" aria-label={`复制第 ${row + 1} 行第 ${column + 1} 列`}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(item.text);
                const key = `${row}:${column}`;
                setCopied(key);
                window.setTimeout(() => setCopied(current => current === key ? null : current), 1200);
              } catch (error) { notifyError(error, "复制失败"); }
            }}>{copied === `${row}:${column}` ? <Check size={13} /> : <Copy size={13} />}</button>}
        </div>; })}
      </div>)}
      {!bubble && Array.from({ length: columns - 1 }, (_, index) => index + 1).map(boundary => <button key={`resize-column-${boundary}`}
        className="canvas-text-resize is-column" role="separator" aria-orientation="vertical"
        aria-label={`调整第 ${boundary} 列宽度`} title={`调整第 ${boundary} 列宽度`} style={{ left: `${boundaryFraction(columnWeights, boundary) * 100}%` }}
        onPointerDown={event => beginGridResize(event, "column", boundary)}
        onPointerMove={moveGridResize} onPointerUp={event => endGridResize(event)} onPointerCancel={event => endGridResize(event, true)}
        onLostPointerCapture={event => endGridResize(event, true)}
        onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); cancelGridResize(); } }} />)}
      {!bubble && Array.from({ length: rows - 1 }, (_, index) => index + 1).map(boundary => <button key={`resize-row-${boundary}`}
        className="canvas-text-resize is-row" role="separator" aria-orientation="horizontal"
        aria-label={`调整第 ${boundary} 行高度`} title={`调整第 ${boundary} 行高度`} style={{ top: `${boundaryFraction(rowWeights, boundary) * 100}%` }}
        onPointerDown={event => beginGridResize(event, "row", boundary)}
        onPointerMove={moveGridResize} onPointerUp={event => endGridResize(event)} onPointerCancel={event => endGridResize(event, true)}
        onLostPointerCapture={event => endGridResize(event, true)}
        onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); cancelGridResize(); } }} />)}
      {!bubble && (["row", "column"] as const).flatMap(axis => {
        const count = axis === "row" ? rows : columns;
        const weights = axis === "row" ? rowWeights : columnWeights;
        return Array.from({ length: count + 1 }, (_, index) => <button key={`${axis}-${index}`}
          className={`canvas-text-insert is-${axis}`} aria-label={`在第 ${index + 1} ${axis === "row" ? "行" : "列"}位置插入`}
          title={`插入${axis === "row" ? "行" : "列"}`} style={axis === "row" ? { top: `${boundaryFraction(weights, index) * 100}%` } : { left: `${boundaryFraction(weights, index) * 100}%` }}
          onPointerDown={event => { event.stopPropagation(); event.preventDefault(); }}
          onClick={() => insert(axis, index)}><Plus size={14} /></button>);
      })}
      {!bubble && (["row", "column"] as const).flatMap(axis => {
        const count = axis === "row" ? rows : columns;
        const weights = axis === "row" ? rowWeights : columnWeights;
        if (count <= 1) return [];
        return Array.from({ length: count }, (_, index) => <button key={`remove-${axis}-${index}`}
          className={`canvas-text-remove is-${axis}`} aria-label={`删除第 ${index + 1} ${axis === "row" ? "行" : "列"}`}
          title={`删除第 ${index + 1} ${axis === "row" ? "行" : "列"}`}
          style={axis === "row"
            ? { top: `${(boundaryFraction(weights, index) + boundaryFraction(weights, index + 1)) / 2 * 100}%` }
            : { left: `${(boundaryFraction(weights, index) + boundaryFraction(weights, index + 1)) / 2 * 100}%` }}
          onPointerEnter={() => setRemoving({ axis, index })} onPointerLeave={() => setRemoving(null)}
          onFocus={() => setRemoving({ axis, index })} onBlur={() => setRemoving(null)}
          onPointerDown={event => { event.stopPropagation(); event.preventDefault(); }}
          onClick={() => remove(axis, index)}><Minus size={14} /></button>);
      })}
    </div>
    {bubble && <CanvasBubbleTail value={value.bubble_tail ?? { side: "bottom", position: 25 }} width={width} height={height}
      onSelect={onSelect} onChange={tail => onChange({ ...value, bubble_tail: tail })} />}
    {selected && <CanvasResizeHandle label={bubble ? "调整文本卡片大小" : "调整内容卡片大小"} size={{ width, height }} zoom={zoom}
      minimum={canvasTextMinSize(value.cells, false, bubble)} onResize={onResize} />}
  </>;
}
