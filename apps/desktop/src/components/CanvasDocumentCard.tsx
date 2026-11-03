import { FileText, Maximize2 } from "lucide-react";
import type { CanvasNotePayload } from "../lib/canvasNotes";
import "./CanvasDocumentCard.css";

export function CanvasDocumentCard({ value, onEdit, onConnect }: {
  value: CanvasNotePayload;
  onEdit: () => void;
  onConnect: (port: string, x: number, y: number) => void;
}) {
  return <>
    <div className="canvas-tactical-card-shell" aria-hidden="true"/>
    <div className="canvas-document-heading" onDoubleClick={onEdit}><FileText size={16}/><span>{value.text.trim() ? value.title || "未命名文档" : "空白文档"}</span><button type="button" aria-label="编辑文本卡片" title="放大编辑" onPointerDown={event => event.stopPropagation()} onClick={onEdit}><Maximize2 size={15}/></button></div>
    {([["*", "图片", "workflow-image-output"], ["*text", "文本", "workflow-content-text-output"]] as const).map(([port, label, className]) => <button key={port} type="button" className={`workflow-cell-port ${className}`} data-workflow-cell={port} aria-label={`输出文档${label}`} title={`输出文档${label}`}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); onConnect(port, event.clientX, event.clientY); }} onClick={event => { if (event.detail === 0) onConnect(port, event.clientX, event.clientY); }}><span>{label}</span></button>)}

  </>;
}
