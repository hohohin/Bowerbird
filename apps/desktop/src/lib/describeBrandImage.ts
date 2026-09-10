import { useStore } from "../store";
import { BRAND_OBSERVATION_TASK } from "./brandVisual";

/** Wait on the existing serial analysis queue; never start a competing describe IPC lane. */
export function describeBrandImage(assetId: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = false;
    let settled = false;
    let unsubscribe = () => {};
    function finish(error?: unknown) {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    }
    // Stop waiting/launching new images. The current shared queue item is allowed to finish.
    const abort = () => finish(new DOMException("已停止总结", "AbortError"));
    function inspect() {
      const state = useStore.getState();
      const pending = state.describingId === assetId || state.describeQueue.some((item) => item.assetId === assetId);
      if (pending) { seen = true; return; }
      if (seen) {
        const failure = state.describeFailures.find((item) => item.assetId === assetId);
        finish(failure ? new Error(failure.reason) : undefined);
      }
    }
    if (signal.aborted) { abort(); return; }
    unsubscribe = useStore.subscribe(inspect);
    signal.addEventListener("abort", abort, { once: true });
    inspect();
    if (!seen) useStore.getState().runDescribe(assetId, BRAND_OBSERVATION_TASK, "bowerbird-cloud");
    inspect();
    if (!seen && !settled) finish(new Error(useStore.getState().cloudError || "暂时无法分析图片，请检查账号后重试"));
  });
}
