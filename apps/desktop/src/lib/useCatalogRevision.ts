import { useCallback, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { catalogCache, type CatalogPreviewChange, type ConnectionProgress } from "./catalogCache";

const subscribers = new Set<() => void>();
const previewSubscribers = new Set<(change: CatalogPreviewChange) => void>();
const progressSubscribers = new Set<(progress: ConnectionProgress) => void>();
const reconnected = new Map<string, "waiting" | "scanning">();
export const waitingForConnectionScan = (rootId: string) => reconnected.has(rootId);
let listening: Promise<unknown> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
export function invalidateCatalog() {
  catalogCache.invalidate();
  notifyRevision();
}
function notifyRevision() {
  clearTimeout(timer);
  timer = setTimeout(() => { for (const notify of subscribers) notify(); }, 100);
}
export function subscribeCatalogPreviews(notify: (change: CatalogPreviewChange) => void) {
  previewSubscribers.add(notify);
  return () => { previewSubscribers.delete(notify); };
}
export function subscribeConnectionProgress(notify: (progress: ConnectionProgress) => void) {
  progressSubscribers.add(notify);
  return () => { progressSubscribers.delete(notify); };
}
function publishProgress(progress: ConnectionProgress) {
  catalogCache.updateConnectionProgress(progress);
  for (const notify of progressSubscribers) notify(progress);
}
export function observeCatalogChanges() {
  // Keep observing changes even when every library pane is closed.
  listening ??= Promise.all([
    listen("library://assets-changed", invalidateCatalog),
    listen<CatalogPreviewChange>("library://previews-changed", event => {
      if (!event.payload?.assets?.length) return;
      catalogCache.updatePreviews(event.payload);
      for (const notify of previewSubscribers) notify(event.payload);
      notifyRevision();
    }),
    listen<ConnectionProgress>("library://connection-progress", event => {
      const progress = event.payload;
      if (!progress?.rootId) return;
      const phase = reconnected.get(progress.rootId);
      // A previous scan may finish while the reconnect scan is still queued.
      if (phase === "waiting" && !progress.scanning) return;
      if (phase && progress.scanning) reconnected.set(progress.rootId, "scanning");
      if (phase === "scanning" && !progress.scanning) reconnected.delete(progress.rootId);
      publishProgress(progress);
      if (phase === "scanning" && !progress.scanning) invalidateCatalog();
    }),
    listen<{ rootId: string; available: boolean }>("library://connection-availability", event => {
      const change = event.payload;
      if (!change?.rootId || typeof change.available !== "boolean") return;
      if (change.available) reconnected.set(change.rootId, "waiting"); else reconnected.delete(change.rootId);
      publishProgress({ rootId: change.rootId, rootAvailable: change.available, scanning: change.available, error: null });
      invalidateCatalog();
    }),
  ]).catch(error => {
    listening = undefined;
    console.warn("catalog change listener", error);
  });
  return listening;
}
function subscribe(notify: () => void) {
  subscribers.add(notify);
  void observeCatalogChanges();
  return () => { subscribers.delete(notify); };
}
export function useCatalogRevision(colorFiltered = false) {
  const snapshot = useCallback(() => catalogCache.revision(colorFiltered), [colorFiltered]);
  return useSyncExternalStore(subscribe, snapshot);
}
