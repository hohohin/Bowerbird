import { invoke, isTauri } from "@tauri-apps/api/core";
import { getDragAssetName, getDragAssetPreview, holdNativeDragAssets } from "./dragPayload";
import { notifyError } from "./notify";
import { mountExternalDragHud } from "./externalDragHud";
import "./externalDrag.css";

export const EXTERNAL_DRAG_ENDED = "bowerbird:external-drag-ended";

/** The backend resolves registered IDs to originals; no temporary copies or renderer paths. */
export async function startExternalDrag(assetIds: string[], mode: "hold" | "pickup",
  { source = "library", signal, sourceRect }: { source?: "library" | "canvas"; signal?: AbortSignal; sourceRect?: DOMRect } = {}): Promise<void> {
  if (!isTauri() || signal?.aborted) return;
  const ids = [...new Set(assetIds.filter(Boolean))];
  const release = holdNativeDragAssets(ids, getDragAssetName() ?? undefined, getDragAssetPreview());
  if (!release) return;
  const sessionId = crypto.randomUUID();
  let cancelled = false;
  let preparationCancelled = false;
  let invoked = false;
  let backdrop: HTMLDivElement | null = null;
  let unmountHud: (() => void) | undefined;
  let cancelPaint: (() => void) | undefined;
  const blockInternalDrop = (event: DragEvent) => {
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  // Keep library-to-canvas/collection targets readable while preserving native ownership.
  const showInternalTargets = () => { if (backdrop) backdrop.style.visibility = "hidden"; };
  const leaveInternalTargets = (event: DragEvent) => {
    if (!event.relatedTarget && backdrop) backdrop.style.visibility = "";
  };
  const clearAppearance = () => {
    unmountHud?.(); unmountHud = undefined;
    backdrop?.remove(); backdrop = null;
    window.removeEventListener("dragenter", showInternalTargets, true);
    window.removeEventListener("dragover", showInternalTargets, true);
    window.removeEventListener("dragleave", leaveInternalTargets, true);
    window.removeEventListener("dragover", blockInternalDrop, true);
    window.removeEventListener("drop", blockInternalDrop, true);
  };
  const cancelPending = () => {
    if (cancelled) return;
    cancelled = true;
    cancelPaint?.();
    if (!invoked) { clearAppearance(); return; }
    void invoke<boolean>("cancel_pending_external_drag", { sessionId }).then(accepted => {
      // Only the native preparation acknowledgement may end this appearance
      // early. Activation of an external target also blurs the source window.
      if (accepted) { preparationCancelled = true; clearAppearance(); }
    }).catch(error => console.error("cancel pending external drag", error));
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (backdrop) { event.preventDefault(); event.stopImmediatePropagation(); }
    cancelPending();
  };
  window.addEventListener("keydown", escape, true);
  signal?.addEventListener("abort", cancelPending, { once: true });
  if (mode === "hold") {
    window.addEventListener("pointerdown", cancelPending, true);
    window.addEventListener("mousedown", cancelPending, true);
    window.addEventListener("pointerup", cancelPending, true);
    window.addEventListener("mouseup", cancelPending, true);
    window.addEventListener("blur", cancelPending);
  }
  try {
    if (source === "canvas") {
      window.addEventListener("dragover", blockInternalDrop, true);
      window.addEventListener("drop", blockInternalDrop, true);
    }
    backdrop = document.createElement("div");
    backdrop.className = "external-drag-backdrop";

    document.body.append(backdrop);
    unmountHud = mountExternalDragHud(backdrop, sourceRect);
    if (source === "library") {
      window.addEventListener("dragenter", showInternalTargets, true);
      window.addEventListener("dragover", showInternalTargets, true);
      window.addEventListener("dragleave", leaveInternalTargets, true);
    }
    await new Promise<void>(resolve => {
      let first = 0, second = 0;
      const done = () => {
        cancelAnimationFrame(first); cancelAnimationFrame(second);
        clearTimeout(timeout); cancelPaint = undefined; resolve();
      };
      // A hidden WebView may suspend rAF. Cancel rather than enter native drag
      // before the promised appearance has had a chance to paint.
      const timeout = window.setTimeout(cancelPending, 150);
      cancelPaint = done;
      first = requestAnimationFrame(() => { second = requestAnimationFrame(done); });
    });
    if (cancelled || signal?.aborted) return;
    invoked = true;
    await invoke<{ dropped: boolean }>("start_external_drag", { assetIds: ids, mode, sessionId, lightTheme: document.documentElement.dataset.theme === "light" });
  } catch (error) {
    if (!preparationCancelled) notifyError(error, "无法拖出素材，请重试");
  } finally {
    cancelPaint?.();
    clearAppearance();
    signal?.removeEventListener("abort", cancelPending);
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
