import { useEffect, useRef } from "react";
import { FileText } from "lucide-react";
import type { FileMediaCardProps } from "./FileMediaCard";
import { LibrarySelectionMark } from "./LibrarySelectionMark";
import "./TextFileMediaCard.css";

/** A library tile only uses indexed metadata; the editor loads on opening details. */
export function TextFileMediaCard({ entry, assetId, selected, revision, onActivate, onSelect, onOpen, onContextMenu, onDragStart, onDragEnd, style, aspectRatio }: FileMediaCardProps) {
  const timer = useRef<number>();
  const cancelClick = () => { window.clearTimeout(timer.current); timer.current = undefined; };
  useEffect(() => cancelClick, [entry.path, onActivate === undefined]);
  return <button type="button" className={`folder-media-card text-file-card${selected ? " is-selected" : ""}`}
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
    <span className="folder-media-preview text-file-preview" style={{ aspectRatio: aspectRatio ?? 1 }}>
      <FileText size={32} strokeWidth={1.25} aria-hidden="true"/>
      <span className="text-file-title">{entry.name}</span>
      <span className="text-file-format">{/\.txt(?:[?#].*)?$/i.test(entry.path) ? "TXT" : "Markdown"}</span>
    </span>
    <LibrarySelectionMark selected={selected} previewKey={`${entry.path}:${entry.version ?? revision}`}/>
  </button>;
}
