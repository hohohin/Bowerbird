import { useCallback, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { catalogCache, type CatalogPreviewChange, type ConnectionProgress } from "./catalogCache";

const subscribers = new Set<() => void>();
const previewSubscribers = new Set<(change: CatalogPreviewChange) => void>();
const progressSubscribers = new Set<(progress: ConnectionProgress) => void>();
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
function subscribe(notify: () => void) {
  subscribers.add(notify);
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
      if (!event.payload?.rootId) return;
      catalogCache.updateConnectionProgress(event.payload);
      for (const notify of progressSubscribers) notify(event.payload);
    }),
  ]).catch(error => {
    listening = undefined;
    console.warn("catalog change listener", error);
  });
  return () => { subscribers.delete(notify); };
}
export function useCatalogRevision(colorFiltered = false) {
  const snapshot = useCallback(() => catalogCache.revision(colorFiltered), [colorFiltered]);
  return useSyncExternalStore(subscribe, snapshot);
}
