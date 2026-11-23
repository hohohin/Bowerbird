import { useEffect, useRef, useState, type DragEventHandler, type PointerEventHandler, type CSSProperties } from "react";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { Folder, Image, Play, Sparkles } from "lucide-react";
import { externalFiles, type LocalFileEntry } from "../lib/externalFiles";
import { createFilePreviewQueue } from "../lib/filePreviewQueue";
import { isVideoPath } from "../lib/videoGeneration";
import { LibrarySelectionMark } from "./LibrarySelectionMark";
import { MediaHoverMark } from "./MediaHoverMark";
import { VideoHoverPreview, videoDurationLabel } from "./VideoHoverPreview";
import { isAudioPath } from "../lib/audioMedia";
import { AudioFileMediaCard } from "./AudioFileMediaCard";
import { isTextPath } from "../lib/textMedia";
import { TextFileMediaCard } from "./TextFileMediaCard";
import { getDragAssets, isNativeAssetDrag, setDragAssets } from "../lib/dragPayload";
import { startExternalDrag } from "../lib/externalDrag";
import { useLibraryDragHold } from "../lib/useLibraryDragHold";
const previews = createFilePreviewQueue(externalFiles.preview);
type PreviewTarget = { visible: (inside: boolean) => void; nearby: (inside: boolean) => void };
const previewObservers = new WeakMap<Element | Document, {
  visible: IntersectionObserver; nearby: IntersectionObserver; targets: Map<Element, PreviewTarget>;
}>();
function observePreview(element: Element, target: PreviewTarget) {
  const root = element.closest(".library-scroller, .canvas-frequent-scroll");
  const list = root ?? element.ownerDocument;
  let shared = previewObservers.get(list);
  if (!shared) {
    const targets = new Map<Element, PreviewTarget>();
    const observer = (range: keyof PreviewTarget, rootMargin: string) => new IntersectionObserver(entries => {
      for (const entry of entries) targets.get(entry.target)?.[range](entry.isIntersecting);
    }, { root, rootMargin });
    shared = { visible: observer("visible", "0px"), nearby: observer("nearby", "400px"), targets };
    previewObservers.set(list, shared);
  }
  const { visible, nearby, targets } = shared;
  targets.set(element, target);
  visible.observe(element);
  nearby.observe(element);
  return () => { targets.delete(element); visible.unobserve(element); nearby.unobserve(element); };
}
export type FileMediaCardProps = {
  entry: LocalFileEntry; selected: boolean; revision: number; labels: string[];
  onSelect: (additive: boolean, range: boolean) => void; onOpen: () => void;
  onActivate?: () => void;
  onContextMenu: (x: number, y: number) => void;
  aspectRatio?: number;
  style?: CSSProperties;
  generated?: boolean;
  duration?: number | null;
  expectedVersion?: string;
  dragAssetIds?: () => string[];
  onPointerDown?: PointerEventHandler<HTMLElement>;
  assetId?: string; onDragStart?: DragEventHandler<HTMLElement>; onDragEnd?: DragEventHandler<HTMLElement>;
};
export function FileMediaCard(props: FileMediaCardProps) {
  function prepareDrag(element: HTMLElement) {
    if (isNativeAssetDrag()) return null;
    const ids = props.dragAssetIds?.();
    if (!ids?.length) return null;
    setDragAssets(ids, props.entry.name, element.querySelector("img")?.src);
    return ids;
  }
  const hold = useLibraryDragHold(`${props.assetId}:${props.entry.path}`, isTauri() && !props.entry.directory && !isTextPath(props.entry.path) && props.assetId && props.dragAssetIds ? prepareDrag : undefined);
  const onDragStart: DragEventHandler<HTMLElement> | undefined = (props.dragAssetIds || props.onDragStart) && (event => {
    if (hold.deferDragStart(event)) return;
    if (isNativeAssetDrag()) { event.preventDefault(); return; }
    if (props.dragAssetIds) {
      const ids = prepareDrag(event.currentTarget);
      if (!ids) { event.preventDefault(); return; }
      event.dataTransfer.effectAllowed = "copyLink";
      event.dataTransfer.setData("text/plain", ids.join(","));
    } else props.onDragStart?.(event);
    const ids = getDragAssets();
    if (event.defaultPrevented || !isTauri() || props.entry.directory || !props.assetId || !ids?.length) return;
    event.preventDefault();
    void startExternalDrag(ids, "hold", {
      sourceRect: (event.currentTarget.querySelector("img, video") ?? event.currentTarget).getBoundingClientRect(),
    });
  });
  return !props.entry.directory && isTextPath(props.entry.path)
    ? <TextFileMediaCard {...props} onDragStart={onDragStart}/>
    : !props.entry.directory && isAudioPath(props.entry.path)
    ? <AudioFileMediaCard {...props} onPointerDown={hold.onPointerDown} onDragStart={onDragStart}/>
    : <VisualFileMediaCard {...props} onPointerDown={hold.onPointerDown} onDragStart={onDragStart}/>;
}
function VisualFileMediaCard({ entry, selected, revision, labels, onSelect, onActivate, onOpen, onContextMenu, aspectRatio, assetId, generated = false, onPointerDown, onDragStart, onDragEnd, style, duration }: FileMediaCardProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const clickTimer = useRef<number>();
  function cancelClick() { window.clearTimeout(clickTimer.current); clickTimer.current = undefined; }
  useEffect(() => cancelClick, [entry.path, onActivate === undefined]);
  const previewKey = `${entry.path}:${entry.version ?? revision}`;
  const video = !entry.directory && isVideoPath(entry.path);
  const durationLabel = video ? videoDurationLabel(duration) : null;
  const [preview, setPreview] = useState<string | null>(() => entry.preview ?? previews.peek(previewKey) ?? null);
  const [failedPreview, setFailedPreview] = useState<string | null>(null);
  // SVG and other directly displayed originals keep their path after an edit.
  const source = preview ? convertFileSrc(preview) + (preview === entry.path && !preview.startsWith("data:") ? `?preview=${encodeURIComponent(entry.version ?? revision)}` : "") : "";
  useEffect(() => {
    if (entry.directory) return;
    const cached = (`${previewKey}:${entry.preview}` !== failedPreview ? entry.preview : null) ?? previews.peek(previewKey);
    if (cached) {
      previews.remember(previewKey, cached); setPreview(cached);
      // A rendered thumbnail may precede its persisted metadata. A warm request
      // lets the native queue resume that work after a prior failure/restart.
      if (!entry.preview) {
        const request = previews.request(previewKey, entry.path, 1, () => {});
        return () => request.cancel();
      }
      return;
    }
    let alive = true;
    let priority: 0 | 1 | undefined;
    let nearby = false;
    let request: ReturnType<typeof previews.request> | undefined;
    setPreview(null);
    if (!ref.current) return;
    const requestPreview = () => {
      // Wait for both initial observations so nearby cards never fill the queue ahead of visible cards.
      if (!nearby || priority === undefined || request) return;
      const ready = previews.peek(previewKey);
      if (ready) { setPreview(ready); return; }
      request = previews.request(previewKey, entry.path, priority, path => { if (alive) setPreview(path); });
    };
    const unobserve = observePreview(ref.current, {
      visible(inside) {
        priority = inside ? 0 : 1;
        request?.priority(priority);
        requestPreview();
      },
      nearby(inside) {
        nearby = inside;
        if (inside) requestPreview();
        else { request?.cancel(); request = undefined; }
      },
    });
    return () => { alive = false; request?.cancel(); unobserve(); };
  }, [entry.path, entry.directory, entry.preview, previewKey, failedPreview]);
  return <button ref={ref} type="button" style={style} data-positioned={style ? "true" : undefined} className={`folder-media-card${selected ? " is-selected" : ""}`} aria-pressed={selected}
    onPointerDown={onPointerDown}
    onPointerEnter={event => { if (event.pointerType !== "touch") setHovered(true); }} onPointerLeave={() => setHovered(false)}
    data-asset-id={assetId} data-file-path={!entry.directory ? entry.path : undefined} draggable={!!onDragStart} onDragStart={event => { cancelClick(); onDragStart?.(event); }} onDragEnd={onDragEnd}
    aria-label={entry.directory ? `文件夹 ${entry.name}` : entry.name} title={[entry.path, labels.map(name => `#${name}`).join(" · ")].filter(Boolean).join("\n")}
    onClick={e => {
      cancelClick();
      if (!onActivate || e.ctrlKey || e.metaKey || e.shiftKey) { onSelect(e.ctrlKey || e.metaKey, e.shiftKey); return; }
      // Let the host handle a double click without also running the single-click action.
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
      {entry.directory ? <Folder size={52} strokeWidth={1.3} /> : preview ? <img src={source} style={aspectRatio ? { position: "absolute", inset: 0, height: "100%", objectFit: "contain" } : undefined} alt="" draggable={false} loading="lazy" decoding="async" onError={() => { previews.forget(previewKey); setFailedPreview(`${previewKey}:${preview}`); setPreview(null); }} /> : isVideoPath(entry.path) ? <Play size={32} /> : <Image size={32} />}
      {video && <VideoHoverPreview path={entry.path} version={entry.version ?? revision} enabled={!!onActivate && !selected}/>}
      {durationLabel && <span className="folder-media-duration">{durationLabel}</span>}
      {video && <span className="folder-media-kind"><Play size={11} />视频</span>}
      {!entry.directory && generated && <span className="folder-media-generated" title="生成图" aria-label="生成图"><Sparkles size={12} aria-hidden="true"/></span>}
    </span>
    <LibrarySelectionMark selected={selected && !entry.directory} previewKey={preview ?? previewKey}/>
    {hovered && !selected && !entry.directory && <MediaHoverMark previewKey={preview ?? previewKey}/>}
    {entry.directory && <span className="folder-media-name">{entry.name}</span>}
  </button>;
}
