import { useEffect, useRef, useState } from "react";
import { exceedsCanvasDragThreshold } from "../lib/canvasLogic";
import type { Asset } from "../lib/types";
import { workflowAssetMedia } from "../lib/workflowCanvasCapabilities";
import { CanvasImage } from "./CanvasImage";
import { VideoPoster } from "./VideoPoster";

export function WorkflowMediaThumbnail({ asset, draggable }: { asset: Asset; draggable?: boolean }) {
  const media = workflowAssetMedia(asset);
  if (media === "audio" || !media) return <span>{asset.name}</span>;
  if (media === "video") return <VideoPoster path={asset.store_path} poster={asset.thumb_path} title={asset.name} alt={asset.name} draggable={draggable} />;
  return <CanvasImage title={asset.name} alt={asset.name} path={asset.store_path} thumbPath={asset.thumb_path}
    sourceWidth={asset.width} sourceHeight={asset.height} draggable={draggable} />;
}

export function WorkflowGenerationReferences({ assets, disabled, onMove }: {
  assets: Asset[]; disabled: boolean; onMove: (fromId: string, toId: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const press = useRef<{ pointerId: number; from: string; x: number; y: number }>();
  const cursor = useRef<{ x: number; y: number }>();
  const scrollFrame = useRef<number>();
  const [drag, setDrag] = useState<{ from: string; to?: string }>();
  const movable = !disabled && assets.length > 1;

  function targetAt(x: number, y: number) {
    const hit = document.elementFromPoint(x, y);
    const item = hit?.closest<HTMLButtonElement>("[data-workflow-reference-asset]");
    if (item && item.parentElement === strip.current) return item.dataset.workflowReferenceAsset;
    const row = strip.current;
    if (!row || hit !== row) return;
    // The narrow gap between thumbnails is also a valid drop target.
    let nearest: HTMLButtonElement | undefined, minDistance = Infinity;
    for (const button of row.querySelectorAll<HTMLButtonElement>("[data-workflow-reference-asset]")) {
      const bounds = button.getBoundingClientRect();
      const distance = Math.abs((bounds.left + bounds.right) / 2 - x);
      if (distance < minDistance) { nearest = button; minDistance = distance; }
    }
    return nearest?.dataset.workflowReferenceAsset;
  }
  function clearPress() {
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = undefined; press.current = undefined; cursor.current = undefined;
  }
  function cancel() { clearPress(); setDrag(undefined); }
  useEffect(() => {
    if (!movable) cancel();
    return clearPress;
  }, [movable]);
  function trackTarget() {
    scrollFrame.current = undefined;
    const row = strip.current, point = cursor.current, start = press.current;
    if (!row || !point || !start) return;
    const bounds = row.getBoundingClientRect();
    if (point.y >= bounds.top && point.y <= bounds.bottom && point.x >= bounds.left && point.x <= bounds.right) {
      const before = row.scrollLeft;
      if (point.x > bounds.right - 18) row.scrollLeft += 8;
      else if (point.x < bounds.left + 18) row.scrollLeft -= 8;
      if (row.scrollLeft !== before) scrollFrame.current = requestAnimationFrame(trackTarget);
    }
    const to = targetAt(point.x, point.y);
    setDrag(previous => previous?.from === start.from && previous.to === to ? previous : { from: start.from, to });
  }
  const fromIndex = drag ? assets.findIndex(asset => asset.id === drag.from) : -1;
  return <div ref={strip} className="workflow-preview workflow-generation-references" role="group" aria-label="参考素材">
    {assets.map((asset, index) => {
      const media = workflowAssetMedia(asset);
      const name = media === "audio" ? "参考音频" : media === "video" ? "参考视频" : media === "image" ? "参考图" : "参考素材";
      const selected = drag?.from === asset.id;
      const target = drag?.to === asset.id && !selected;
      return <button key={asset.id} type="button" disabled={!movable} data-workflow-reference-asset={asset.id}
        className={selected ? "is-dragging" : target ? (index < fromIndex ? "is-drop-before" : "is-drop-after") : undefined}
        aria-label={`${name} ${index + 1}，${asset.name}`} aria-keyshortcuts={movable ? "ArrowLeft ArrowRight" : undefined}
        title={movable ? `${asset.name} · 拖动或按左右方向键调整顺序` : asset.name}
        onPointerDown={event => {
          if (!movable || event.button !== 0 || !event.isPrimary) return;
          event.stopPropagation();
          press.current = { pointerId: event.pointerId, from: asset.id, x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const start = press.current;
          if (!movable || start?.pointerId !== event.pointerId) return;
          if (!drag && !exceedsCanvasDragThreshold(start, { x: event.clientX, y: event.clientY })) return;
          cursor.current = { x: event.clientX, y: event.clientY };
          if (scrollFrame.current === undefined) trackTarget();
        }}
        onPointerUp={event => {
          const start = press.current;
          if (start?.pointerId !== event.pointerId) return;
          const to = targetAt(event.clientX, event.clientY);
          cancel();
          if (movable && to && to !== start.from && exceedsCanvasDragThreshold(start, { x: event.clientX, y: event.clientY })) onMove(start.from, to);
        }}
        onKeyDown={event => {
          if (event.key === "Escape" && press.current) { event.stopPropagation(); cancel(); return; }
          if (!movable || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault(); event.stopPropagation();
          const neighbor = assets[index + (event.key === "ArrowLeft" ? -1 : 1)];
          if (neighbor) {
            onMove(asset.id, neighbor.id);
            const button = event.currentTarget;
            requestAnimationFrame(() => {
              const row = strip.current;
              if (!row || !row.contains(button)) return;
              button.focus({ preventScroll: true });
              if (button.offsetLeft < row.scrollLeft) row.scrollLeft = button.offsetLeft;
              else if (button.offsetLeft + button.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = button.offsetLeft + button.offsetWidth - row.clientWidth;
            });
          }
        }}
        onLostPointerCapture={cancel} onPointerCancel={cancel}>
        <WorkflowMediaThumbnail asset={asset} draggable={false} />
      </button>;
    })}
  </div>;
}
