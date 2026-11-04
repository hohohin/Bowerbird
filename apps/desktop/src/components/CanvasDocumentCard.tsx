import { FileText, Maximize2 } from "lucide-react";
import type { CanvasNotePayload } from "../lib/canvasNotes";
import { CanvasConnectionHandle } from "./CanvasConnectionHandle";
import "./CanvasDocumentCard.css";

export function CanvasDocumentCard({ value, onEdit, onConnect }: {
  value: CanvasNotePayload;
  onEdit: () => void;
  onConnect: (port: string, x: number, y: number, keyboard?: boolean) => void;
}) {
  return <>
    <div className="canvas-tactical-card-shell" aria-hidden="true"/>
    <div className="canvas-document-heading" onDoubleClick={onEdit}><FileText size={16}/><span>{value.text.trim() ? value.title || "未命名文档" : "空白文档"}</span><button type="button" aria-label="编辑文本卡片" title="放大编辑" onPointerDown={event => event.stopPropagation()} onClick={onEdit}><Maximize2 size={15}/></button></div>
    <CanvasConnectionHandle side="output" data-workflow-cell="*auto"
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); onConnect("*auto", event.clientX, event.clientY); }}
      onClick={event => { if (event.detail === 0) { const rect = event.currentTarget.getBoundingClientRect(); onConnect("*auto", rect.left + rect.width / 2, rect.top + rect.height / 2, true); } }}/>

  </>;
}
