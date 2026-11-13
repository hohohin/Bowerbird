import { useEffect, useState } from "react";
import { Maximize2 } from "lucide-react";
import type { CanvasNotePayload } from "../lib/canvasNotes";
import { DocumentCardPreview } from "./DocumentCardPreview";
import { CanvasConnectionHandle } from "./CanvasConnectionHandle";
import { useMediaVisibility } from "../lib/useMediaVisibility";
import { requestDocumentReading } from "../lib/documentReadingQueue";
import "./CanvasDocumentCard.css";

export function CanvasDocumentCard({ value, editing, onEdit, onConnect }: {
  value: CanvasNotePayload;
  editing?: boolean;
  onEdit: () => void;
  onConnect: (port: string, x: number, y: number, keyboard?: boolean) => void;
}) {
  const [preview, setPreview] = useState({ source: "", text: "" });
  const { ref, visible } = useMediaVisibility<HTMLSpanElement>();
  useEffect(() => {
    if (!visible || editing || preview.source === value.text) return;
    const abort = new AbortController();
    void requestDocumentReading(value.text, "card", abort.signal).then(text => {
      if (!abort.signal.aborted) setPreview({ source: value.text, text });
    }).catch(() => { /* Keep the title and editing action available if preview loading fails. */ });
    return () => abort.abort();
  }, [visible, editing, value.text, preview.source]);
  return <>
    <DocumentCardPreview previewRef={ref} scrollable title={value.text.trim() ? value.title || "未命名文档" : "空白文档"} readingHtml={preview.text}
      action={<button type="button" className="canvas-document-edit" aria-label="编辑文本卡片" title="放大编辑" onPointerDown={event => event.stopPropagation()} onClick={onEdit}><Maximize2 size={15}/></button>}/>
    <CanvasConnectionHandle side="output" data-workflow-cell="*auto"
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); onConnect("*auto", event.clientX, event.clientY); }}
      onClick={event => { if (event.detail === 0) { const rect = event.currentTarget.getBoundingClientRect(); onConnect("*auto", rect.left + rect.width / 2, rect.top + rect.height / 2, true); } }}/>

  </>;
}
