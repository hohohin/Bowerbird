import { useEffect, useRef, useState } from "react";
import { Music2 } from "lucide-react";
import { AudioWaveform } from "./AudioWaveform";
import type { FileMediaCardProps } from "./FileMediaCard";
import { LibrarySelectionMark } from "./LibrarySelectionMark";
import { videoDurationLabel } from "./VideoHoverPreview";
import "./AudioFileMediaCard.css";

export function AudioFileMediaCard({ entry, assetId, expectedVersion, selected, revision, onActivate, onSelect, onOpen, onContextMenu, onPointerDown, onDragStart, onDragEnd, style, duration }: FileMediaCardProps) {
  const [seconds, setSeconds] = useState(duration);
  const clickTimer = useRef<number>();
  const cancelClick = () => window.clearTimeout(clickTimer.current);
  useEffect(() => setSeconds(duration), [duration, entry.path, entry.version]);
  useEffect(() => cancelClick, [entry.path, onActivate === undefined]);
  return <div role="group" tabIndex={0} className={`folder-media-card audio-file-card${selected ? " is-selected" : ""}`}
    onPointerDown={onPointerDown}
    style={style} data-positioned={style ? "true" : undefined} data-asset-id={assetId} data-file-path={entry.path} aria-label={entry.name}
    draggable={!!onDragStart} onDragStart={onDragStart} onDragEnd={onDragEnd}
    onClick={event => {
      cancelClick();
      if (event.defaultPrevented) return;
      if (!onActivate || event.ctrlKey || event.metaKey || event.shiftKey) {
        onSelect(event.ctrlKey || event.metaKey, event.shiftKey);
      } else if (event.detail < 2) {
        clickTimer.current = window.setTimeout(onActivate, 300);
      }
    }}
    onDoubleClick={event => { cancelClick(); if ((onActivate || !assetId) && !event.ctrlKey && !event.metaKey && !event.shiftKey) onOpen(); }}
    onContextMenu={event => { cancelClick(); event.preventDefault(); event.stopPropagation(); onContextMenu(event.clientX, event.clientY); }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" && (onActivate || !assetId)) { cancelClick(); event.preventDefault(); onOpen(); }
      if (event.key === " ") { event.preventDefault(); onSelect(event.ctrlKey || event.metaKey, event.shiftKey); }
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault(); event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect(); onContextMenu(rect.left + rect.width / 2, rect.top + 24);
      }
    }}>
    {assetId ? <AudioWaveform className="folder-media-preview" assetId={assetId} path={entry.path} name={entry.name} version={entry.version ?? String(revision)} expectedVersion={expectedVersion}
      duration={seconds} onDuration={setSeconds} interactive={!!onActivate && !selected}/> : <div className="folder-media-preview audio-file-placeholder"><Music2 size={28}/></div>}
    <div className="audio-file-meta"><span title={entry.name}>{entry.name}</span><time>{videoDurationLabel(seconds)}</time></div>
    <LibrarySelectionMark selected={selected} previewKey={`${entry.path}:${entry.version ?? revision}`}/>
  </div>;
}
