import { useEffect, useState, type MouseEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { canvasAssetMediaPath, type CanvasAssetSnapshot } from "../lib/creativeCanvas";
import { isVideoPath } from "../lib/videoGeneration";
import { VideoPoster } from "./VideoPoster";
import "./CanvasConversationImages.css";

export function CanvasConversationImages({ images, onContextMenu }: {
  images: CanvasAssetSnapshot[];
  onContextMenu: (event: MouseEvent<HTMLElement>, asset: CanvasAssetSnapshot) => void;
}) {
  const [selected, setSelected] = useState<string>();
  const newest = images[images.length - 1]?.id;
  useEffect(() => { setSelected(newest); }, [newest]);
  if (!images.length) return null;
  const index = Math.max(0, images.findIndex(image => image.id === (selected ?? newest)));
  const shown = images[index];
  const path = canvasAssetMediaPath(shown);
  return <section className="canvas-conversation-images" data-conversation-image={shown.assetId}
    onContextMenu={event => onContextMenu(event, shown)}>
    {isVideoPath(shown.storePath) ? <VideoPoster path={shown.storePath} poster={shown.thumbPath} alt={shown.name} draggable={false} />
      : path ? <img src={convertFileSrc(path)} alt={shown.name} draggable={false} />
      : <div className="canvas-node-placeholder">{isVideoPath(shown.storePath) ? "视频 · 暂无封面" : shown.name}</div>}
    <span className="canvas-conversation-count">✨ {index + 1}/{images.length}</span>
    {images.length > 1 && <>
      <button type="button" className="previous" aria-label="上一张生成图片" disabled={index === 0}
        onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setSelected(images[index - 1].id); }}>‹</button>
      <button type="button" className="next" aria-label="下一张生成图片" disabled={index === images.length - 1}
        onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setSelected(images[index + 1].id); }}>›</button>
    </>}
  </section>;
}
