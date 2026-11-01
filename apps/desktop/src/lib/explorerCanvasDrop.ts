import type { Asset } from "./types";
import { isAudioAsset } from "./audioMedia";

export const EXPLORER_CANVAS_DROP_EVENT = "bowerbird:prepare-explorer-canvas-drop";
export interface ExplorerCanvasDropDetail {
  projectId: string;
  clientX: number;
  clientY: number;
  place: ((asset: Asset) => Promise<string | void>) | null;
}

// The enclosing collector owns ingestion; the actual canvas under the drop
// freezes its coordinates synchronously, before downloading the image.
export function prepareExplorerCanvasDrop(target: EventTarget | null, projectId: string | null, clientX: number, clientY: number) {
  if (!projectId || !(target instanceof Element)) return null;
  const detail: ExplorerCanvasDropDetail = { projectId, clientX, clientY, place: null };
  target.dispatchEvent(new CustomEvent(EXPLORER_CANVAS_DROP_EVENT, { bubbles: true, detail }));
  const place = detail.place;
  return place ? async (asset: Asset) => {
    if (isAudioAsset(asset)) throw new Error("音频暂不支持添加到画板，请在素材库中播放");
    return place(asset);
  } : null;
}
