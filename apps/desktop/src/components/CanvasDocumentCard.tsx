import { lazy, Suspense } from "react";
import { FileText, Maximize2 } from "lucide-react";
import type { CanvasNotePayload } from "../lib/canvasNotes";
import { CanvasResizeHandle } from "./CanvasResizeHandle";
import { OverlayScrollArea } from "./CollectionScrollArea";
import "./CanvasDocumentCard.css";

const Body = lazy(() => import("./CanvasDocumentBody"));
export function CanvasDocumentCard({ value, selected, width, height, zoom, getZoom, onEdit, onConnect, onResize }: {
  value: CanvasNotePayload; selected: boolean; width: number; height: number; zoom: number; getZoom: () => number;
  onEdit: () => void;
  onConnect: (port: string, x: number, y: number) => void;
  onResize: (size: { width: number; height: number }, finished: boolean, cancelled?: boolean) => void;
}) {
  return <>
    <div className="canvas-tactical-card-shell" aria-hidden="true"/>
    <div className="canvas-document-heading"><FileText size={16}/><span>{value.title || "文本"}</span><button type="button" aria-label="编辑文本卡片" title="放大编辑" onPointerDown={event => event.stopPropagation()} onClick={onEdit}><Maximize2 size={15}/></button></div>
    <OverlayScrollArea className="canvas-document-scroll" label="文本卡片滚动条"><div className="canvas-document-body" onPointerDown={event => event.stopPropagation()} onDoubleClick={onEdit}>
      <Suspense fallback={<p>{value.title || "文本"}</p>}><Body markdown={value.text}/></Suspense>
    </div></OverlayScrollArea>
    {([["*", "图片", "workflow-image-output"], ["*text", "文本", "workflow-content-text-output"]] as const).map(([port, label, className]) => <button key={port} type="button" className={`workflow-cell-port ${className}`} data-workflow-cell={port} aria-label={`输出文档${label}`} title={`输出文档${label}`}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); onConnect(port, event.clientX, event.clientY); }} onClick={event => { if (event.detail === 0) onConnect(port, event.clientX, event.clientY); }}><span>{label}</span></button>)}
    {selected && <CanvasResizeHandle label="调整文本卡片大小" size={{ width, height }} zoom={zoom} getZoom={getZoom} minimum={{ width: 280, height: 200 }} onResize={onResize}/>}
  </>;
}
