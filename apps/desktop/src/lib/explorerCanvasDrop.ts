import type { Asset } from "./types";

export const EXPLORER_CANVAS_DROP_EVENT = "bowerbird:prepare-explorer-canvas-drop";
export interface ExplorerCanvasDropDetail {
  projectId: string;
  clientX: number;
  clientY: number;
  place: ((asset: Asset) => Promise<void>) | null;
}

// The enclosing collector owns ingestion; the actual canvas under the drop
// freezes its coordinates synchronously, before downloading the image.
export function prepareExplorerCanvasDrop(target: EventTarget | null, projectId: string | null, clientX: number, clientY: number) {
  if (!projectId || !(target instanceof Element)) return null;
  const detail: ExplorerCanvasDropDetail = { projectId, clientX, clientY, place: null };
  target.dispatchEvent(new CustomEvent(EXPLORER_CANVAS_DROP_EVENT, { bubbles: true, detail }));
  return detail.place;
}
