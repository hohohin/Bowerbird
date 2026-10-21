import { useEffect, useRef, useState, type DragEventHandler } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Folder, Image, Play } from "lucide-react";
import { externalFiles, type LocalFileEntry } from "../lib/externalFiles";
import { createFilePreviewQueue } from "../lib/filePreviewQueue";
import { isVideoPath } from "../lib/videoGeneration";
const previews = createFilePreviewQueue(externalFiles.preview);
export function FileMediaCard({ entry, selected, revision, labels, onSelect, onActivate, onOpen, onContextMenu, aspectRatio, assetId, onDragStart, onDragEnd }: {
  entry: LocalFileEntry; selected: boolean; revision: number; labels: string[];
  onSelect: (additive: boolean, range: boolean) => void; onOpen: () => void;
  onActivate?: () => void;
  onContextMenu: (x: number, y: number) => void;
  aspectRatio?: number;
  assetId?: string; onDragStart?: DragEventHandler<HTMLButtonElement>; onDragEnd?: DragEventHandler<HTMLButtonElement>;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const clickTimer = useRef<number>();
  function cancelClick() { window.clearTimeout(clickTimer.current); clickTimer.current = undefined; }
  useEffect(() => cancelClick, [entry.path, onActivate === undefined]);
  const previewKey = `${entry.path}:${entry.version ?? revision}`;
  const [preview, setPreview] = useState<string | null>(() => entry.preview ?? previews.peek(previewKey) ?? null);
  const [failedPreview, setFailedPreview] = useState<string | null>(null);
  useEffect(() => {
    if (entry.directory) return;
    const cached = (entry.preview !== failedPreview ? entry.preview : null) ?? previews.peek(previewKey);
    if (cached) { previews.remember(previewKey, cached); setPreview(cached); return; }
    let alive = true; let priority = 1;
    let request: ReturnType<typeof previews.request> | undefined;
    setPreview(null);
    const visible = new IntersectionObserver(entries => {
      priority = entries.some(e => e.isIntersecting) ? 0 : 1;
      request?.priority(priority);
    });
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) { request?.cancel(); request = undefined; return; }
      if (request) return;
      const ready = previews.peek(previewKey);
      if (ready) { setPreview(ready); return; }
      request = previews.request(previewKey, entry.path, priority, path => { if (alive) setPreview(path); });
    }, { rootMargin: "400px" });
    if (ref.current) { visible.observe(ref.current); observer.observe(ref.current); }
    return () => { alive = false; request?.cancel(); visible.disconnect(); observer.disconnect(); };
  }, [entry.path, entry.directory, entry.preview, previewKey, failedPreview]);
  return <button ref={ref} type="button" className={`folder-media-card${selected ? " is-selected" : ""}`} aria-pressed={selected}
    data-asset-id={assetId} draggable={!!onDragStart} onDragStart={event => { cancelClick(); onDragStart?.(event); }} onDragEnd={onDragEnd}
    aria-label={entry.directory ? `文件夹 ${entry.name}` : entry.name} title={[entry.path, labels.map(name => `#${name}`).join(" · ")].filter(Boolean).join("\n")}
    onClick={e => {
      cancelClick();
      if (!onActivate || e.ctrlKey || e.metaKey || e.shiftKey) { onSelect(e.ctrlKey || e.metaKey, e.shiftKey); return; }
      // Let a double click open details without first opening a preview or inserting twice.
      if (e.detail < 2) clickTimer.current = window.setTimeout(onActivate, 300);
    }} onDoubleClick={e => { cancelClick(); if (!e.ctrlKey && !e.metaKey && !e.shiftKey) onOpen(); }}
    onContextMenu={e => { cancelClick(); e.preventDefault(); e.stopPropagation(); onContextMenu(e.clientX, e.clientY); }}
    onKeyDown={e => {
      if (e.key === "Enter") { cancelClick(); e.preventDefault(); onOpen(); }
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault(); e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect(); onContextMenu(rect.left + rect.width / 2, rect.top + 24);
      }
    }}>
    <span className={`folder-media-preview${entry.directory ? " is-folder" : ""}`} style={aspectRatio ? { aspectRatio, minHeight: 0 } : undefined}>
      {entry.directory ? <Folder size={52} strokeWidth={1.3} /> : preview ? <img src={convertFileSrc(preview)} style={aspectRatio ? { position: "absolute", inset: 0, height: "100%", objectFit: "contain" } : undefined} alt="" draggable={false} loading="lazy" decoding="async" onError={() => { previews.forget(previewKey); setFailedPreview(preview); setPreview(null); }} /> : isVideoPath(entry.path) ? <Play size={32} /> : <Image size={32} />}
      {!entry.directory && isVideoPath(entry.path) && <span className="folder-media-kind"><Play size={11} />视频</span>}
    </span>
    {entry.directory && <span className="folder-media-name">{entry.name}</span>}
  </button>;
}
