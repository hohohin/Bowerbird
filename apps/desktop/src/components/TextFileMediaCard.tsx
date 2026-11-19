import { useEffect, useRef, useState } from "react";
import { createFilePreviewQueue } from "../lib/filePreviewQueue";
import { textDocuments } from "../lib/textDocuments";
import type { FileMediaCardProps } from "./FileMediaCard";
import { LibrarySelectionMark } from "./LibrarySelectionMark";
import { DocumentCardPreview } from "./DocumentCardPreview";
import { textFileFormat } from "../lib/textMedia";
import { requestDocumentReading } from "../lib/documentReadingQueue";

const previews = createFilePreviewQueue(async assetId => {
  const document = await textDocuments.preview(assetId);
  if (document.format === "text") return document.text.trim().slice(0, 1200);
  return requestDocumentReading(document.text, "excerpt");
});

/** Only visible/nearby cards read originals; cache excerpts, never mount the editor. */
export function TextFileMediaCard({ entry, assetId, selected, revision, onActivate, onSelect, onOpen, onContextMenu, onDragStart, onDragEnd, style, aspectRatio }: FileMediaCardProps) {
  const root = useRef<HTMLButtonElement>(null);
  const previewKey = `${assetId}:${entry.path}:${entry.version ?? ""}:${revision}`;
  const [preview, setPreview] = useState<{ key: string; text: string }>();
  const excerpt = preview?.key === previewKey ? preview.text : previews.peek(previewKey) ?? "";
  useEffect(() => {
    if (!assetId || previews.peek(previewKey) !== undefined) return;
    let request: ReturnType<typeof previews.request> | undefined;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) { request?.cancel(); request = undefined; return; }
      request ??= previews.request(previewKey, assetId, 0, text => setPreview({ key: previewKey, text }));
    }, { rootMargin: "200px" });
    if (root.current) observer.observe(root.current);
    return () => { request?.cancel(); observer.disconnect(); };
  }, [assetId, previewKey]);
  const timer = useRef<number>();
  const cancelClick = () => { window.clearTimeout(timer.current); timer.current = undefined; };
  useEffect(() => cancelClick, [entry.path, onActivate === undefined]);
  return <button ref={root} type="button" className={`folder-media-card text-file-card${selected ? " is-selected" : ""}`}
    style={style} data-positioned={style ? "true" : undefined} data-asset-id={assetId} data-file-path={entry.path}
    aria-label={entry.name} aria-pressed={selected} title={entry.path}
    draggable={!!onDragStart} onDragStart={event => { cancelClick(); onDragStart?.(event); }} onDragEnd={onDragEnd}
    onClick={event => {
      cancelClick();
      if (!onActivate || event.ctrlKey || event.metaKey || event.shiftKey) { onSelect(event.ctrlKey || event.metaKey, event.shiftKey); return; }
      if (event.detail < 2) timer.current = window.setTimeout(onActivate, 300);
    }}
    onDoubleClick={event => { cancelClick(); if (!event.ctrlKey && !event.metaKey && !event.shiftKey) onOpen(); }}
    onContextMenu={event => { cancelClick(); event.preventDefault(); event.stopPropagation(); onContextMenu(event.clientX, event.clientY); }}
    onKeyDown={event => {
      if (event.key === "Enter") { cancelClick(); event.preventDefault(); onOpen(); }
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault(); event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect(); onContextMenu(rect.left + rect.width / 2, rect.top + 24);
      }
    }}>
    <DocumentCardPreview title={entry.name} excerpt={excerpt} aspectRatio={aspectRatio} format={textFileFormat(entry.path)}/>
    <LibrarySelectionMark selected={selected} previewKey={`${entry.path}:${entry.version ?? revision}`}/>
  </button>;
}
