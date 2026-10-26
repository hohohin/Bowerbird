import { useEffect, useRef, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ExplorerImage } from "./explorer";
import "./explorerDragVisual.js";

interface DragVisualValue { id: string; imageUrl: string }
interface DragPreview {
  id: string;
  thumbnail?: string;
  labels?: { key: string; name: string; probability: number; selected: boolean }[];
}
interface DragVisual {
  pick(value: DragVisualValue, x?: number, y?: number): void;
  move(x: number, y: number): void;
  hide(): void;
  update(value: DragPreview): void;
  land(x: number, y: number): void;
  settle(element: HTMLElement | null): void;
  clear(): void;
}
declare global { interface Window { createBowerbirdDragVisual(parent: HTMLElement): DragVisual } }

export function useExplorerDragMotion(root: RefObject<HTMLDivElement>, open: boolean, projectId: string | null, onThumbnail?: (id: string, thumbnail: string) => void) {
  const visual = useRef<DragVisual>();
  const active = useRef<(DragVisualValue & { dropped?: boolean; preview?: DragPreview; thumbnail?: string; shown?: boolean }) | null>(null);
  const clear = () => { visual.current?.clear(); active.current = null; };
  useEffect(() => {
    const panel = root.current?.querySelector<HTMLElement>(".explore-main");
    if (!open || !panel) return;
    visual.current = window.createBowerbirdDragVisual(panel);
    let disposed = false;
    const subscriptions = [
      listen<DragVisualValue & { phase: "start" | "end" }>("source-browser://drag", ({ payload }) => {
        if (disposed) return;
        if (payload.phase === "start") { clear(); active.current = payload; }
        else if (active.current?.id === payload.id && !active.current.dropped) {
          // Native dragend can precede the main WebView's drop event.
          const id = payload.id;
          setTimeout(() => { if (!disposed && active.current?.id === id && !active.current.dropped) clear(); }, 100);
        }
      }),
      listen<DragPreview>("source-browser://drag-preview", ({ payload }) => {
        if (disposed) return;
        if (payload.thumbnail) onThumbnail?.(payload.id, payload.thumbnail);
        if (active.current?.id !== payload.id) return;
        if (payload.thumbnail) active.current.thumbnail = payload.thumbnail;
        if (active.current.dropped) return;
        if (active.current.shown) visual.current?.update(payload);
        else active.current.preview = { ...active.current.preview, ...payload };
      }),
    ];
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && active.current && !active.current.dropped) {
        event.preventDefault(); event.stopImmediatePropagation(); clear();
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => {
      disposed = true; clear(); window.removeEventListener("keydown", escape, true);
      for (const subscription of subscriptions) void subscription.then(unlisten => unlisten()).catch(() => {});
    };
  }, [open, projectId, root, onThumbnail]);
  return {
    over(x: number, y: number) {
      const value = active.current;
      if (!value || value.dropped) return;
      if (!value.shown) { visual.current?.pick({ ...value, imageUrl: value.preview?.thumbnail ?? value.imageUrl }, x, y); value.shown = true; }
      visual.current?.move(x, y);
      if (value.preview) { visual.current?.update(value.preview); value.preview = undefined; }
    },
    leave() { visual.current?.hide(); },
    drop(image: ExplorerImage, id: string, x: number, y: number) {
      const imageUrl = active.current?.id === id ? active.current.thumbnail ?? image.imageUrl : image.imageUrl;
      if (active.current?.id !== id || !active.current.shown) visual.current?.pick({ id, imageUrl: image.imageUrl }, x, y);
      active.current = { id, imageUrl: image.imageUrl, thumbnail: imageUrl, dropped: true, shown: true };
      visual.current?.land(x, y);
      return imageUrl;
    },
    park(id: string) {
      if (active.current?.id !== id) return;
      const thumbnail = active.current.thumbnail;
      clear();
      return thumbnail;
    },
    finish(id: string, assetId?: string, nodeId?: string) {
      // React may commit the new card on the next frame after the import returns.
      requestAnimationFrame(() => {
        if (active.current?.id !== id) return;
        const selector = nodeId ? `[data-canvas-node-id="${CSS.escape(nodeId)}"]` : assetId ? `[data-asset-id="${CSS.escape(assetId)}"]` : null;
        const element = selector ? root.current?.querySelector<HTMLElement>(selector) : null;
        visual.current?.settle(element ?? null); active.current = null;
      });
    },
  };
}
