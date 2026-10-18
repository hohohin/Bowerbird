import type { MouseEvent, PointerEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { canvasAssetMediaPath, type CanvasAssetSnapshot } from "../lib/creativeCanvas";
import { isVideoPath } from "../lib/videoGeneration";
import { VideoPoster } from "./VideoPoster";
import "./CanvasConversationImages.css";

export function CanvasConversationImages({ images, imageOnly, selectedId, onSelect, onPointerDown, onClick, onDoubleClick, onContextMenu }: {
  images: CanvasAssetSnapshot[];
  imageOnly: boolean;
  selectedId?: string;
  onSelect: (id: string) => void;
  onDoubleClick: (event: MouseEvent<HTMLElement>, asset: CanvasAssetSnapshot) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onClick: (event: MouseEvent<HTMLElement>, asset: CanvasAssetSnapshot) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, asset: CanvasAssetSnapshot) => void;
}) {
  const newest = images[images.length - 1]?.id;
  if (!images.length) return null;
  const index = Math.max(0, images.findIndex(image => image.id === (selectedId ?? newest)));
  const shown = images[index];
  const path = canvasAssetMediaPath(shown);
  return <section className={`canvas-conversation-images${isVideoPath(shown.storePath) ? " is-video" : ""}`} data-conversation-image={shown.assetId}
    role="button" tabIndex={0} aria-label={shown.name}
    onPointerDown={onPointerDown}
    onClick={event => { event.stopPropagation(); onClick(event, shown); }}
    onDoubleClick={event => { event.stopPropagation(); onDoubleClick(event, shown); }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.click();
    }}
    onContextMenu={event => onContextMenu(event, shown)}>
    {isVideoPath(shown.storePath) ? <VideoPoster path={shown.storePath} poster={shown.thumbPath} alt={shown.name} draggable={false} />
      : path ? <img src={convertFileSrc(path)} alt={shown.name} draggable={false} />
      : <div className="canvas-node-placeholder">{isVideoPath(shown.storePath) ? "视频 · 暂无封面" : shown.name}</div>}
    {isVideoPath(shown.storePath) && <span className="canvas-video-film" role="img" aria-label="视频" />}
    {(!imageOnly || images.length > 1) && <span className="canvas-conversation-count">{!imageOnly && "✨ "}{index + 1}/{images.length}</span>}
    {images.length > 1 && <>
      <button type="button" className="previous" aria-label="上一张生成图片" disabled={index === 0}
        onDoubleClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onSelect(images[index - 1].id); }}>‹</button>
      <button type="button" className="next" aria-label="下一张生成图片" disabled={index === images.length - 1}
        onDoubleClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onSelect(images[index + 1].id); }}>›</button>
    </>}
  </section>;
}
