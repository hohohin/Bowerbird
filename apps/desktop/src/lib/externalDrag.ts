import { invoke, isTauri } from "@tauri-apps/api/core";
import { getDragAssetName, getDragAssetPreview, holdNativeDragAssets } from "./dragPayload";
import { notifyError } from "./notify";

export const EXTERNAL_DRAG_ENDED = "bowerbird:external-drag-ended";

/** The backend resolves registered IDs to originals; no temporary copies or renderer paths. */
export async function startExternalDrag(assetIds: string[], mode: "hold" | "pickup"): Promise<void> {
  if (!isTauri()) return;
  const ids = [...new Set(assetIds.filter(Boolean))];
  const release = holdNativeDragAssets(ids, getDragAssetName() ?? undefined, getDragAssetPreview());
  if (!release) return;
  const sessionId = crypto.randomUUID();
  let cancelled = false;
  const cancelPending = () => {
    if (cancelled) return;
    cancelled = true;
    void invoke("cancel_pending_external_drag", { sessionId }).catch(error => console.error("cancel pending external drag", error));
  };
  const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancelPending(); };
  window.addEventListener("keydown", escape, true);
  if (mode === "hold") {
    window.addEventListener("pointerdown", cancelPending, true);
    window.addEventListener("mousedown", cancelPending, true);
    window.addEventListener("pointerup", cancelPending, true);
    window.addEventListener("mouseup", cancelPending, true);
    window.addEventListener("blur", cancelPending);
  }
  try {
    await invoke<{ dropped: boolean }>("start_external_drag", { assetIds: ids, mode, sessionId });
  } catch (error) {
    notifyError(error, "无法拖出素材，请重试");
  } finally {
    window.removeEventListener("keydown", escape, true);
    window.removeEventListener("pointerdown", cancelPending, true);
    window.removeEventListener("mousedown", cancelPending, true);
    window.removeEventListener("pointerup", cancelPending, true);
    window.removeEventListener("mouseup", cancelPending, true);
    window.removeEventListener("blur", cancelPending);
    release();
    window.dispatchEvent(new Event(EXTERNAL_DRAG_ENDED));
  }
}
