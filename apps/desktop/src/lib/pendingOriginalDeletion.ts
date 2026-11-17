import { useSyncExternalStore } from "react";
import type { FileTaskStatus } from "./fileTasks";

export interface DeleteOriginal { assetId: string; path: string; missing?: boolean }
type Task = { originals: readonly DeleteOriginal[]; completed: number; outstanding: readonly DeleteOriginal[]; observed: boolean; expectedRead?: number };
const tasks = new Map<string, Task>();
const finished = new Set<string>();
const listeners = new Set<() => void>();
const commitListeners = new Set<(items: readonly DeleteOriginal[]) => void>();
let ids = new Map<string, DeleteOriginal>(), paths = new Map<string, DeleteOriginal>();
let snapshot: ReadonlySet<string> = new Set();
let epoch = 0;
let hasReadReceipts = false;
// A cached page may live across pane unmounts. A successful deletion excludes its old
// snapshots only. A new authoritative read can show a subsequently restored original.
const committedIds = new Map<string, { item: DeleteOriginal; epoch: number }>();
const committedPaths = new Map<string, { item: DeleteOriginal; epoch: number }>();
export const originalDeletionPathKey = (path: string) => /^(?:[a-z]:[\\/]|\\\\)/i.test(path)
  ? path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").replace(/\\/g, "/").toLowerCase() : path;
export const originalDeletionEpoch = () => epoch;
export function originalDeletionFor(id?: string | null, path?: string | null, readEpoch = Infinity) {
  const key = path && originalDeletionPathKey(path);
  const active = (id && ids.get(id)) || (key && paths.get(key));
  if (active) return active;
  if (readEpoch < epoch) {
    for (const match of [id && committedIds.get(id), key && committedPaths.get(key)]) {
      if (match && match.epoch > readEpoch) return match.item;
    }
  }
  return undefined;
}
export const isPendingOriginal = (id?: string | null, path?: string | null) => !!originalDeletionFor(id, path);
export const hasPendingOriginalDeletions = () => snapshot.size !== 0;
function publish() {
  ids = new Map(); paths = new Map();
  for (const task of tasks.values()) for (const item of task.outstanding) {
    ids.set(item.assetId, item); paths.set(originalDeletionPathKey(item.path), item);
  }
  snapshot = new Set(ids.keys());
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function usePendingOriginalDeletion() { return useSyncExternalStore(subscribe, () => snapshot); }
export function subscribeOriginalDeletionCommits(listener: (items: readonly DeleteOriginal[]) => void) {
  commitListeners.add(listener); return () => { commitListeners.delete(listener); };
}
export function beginOriginalDeletion(id: string, originals: readonly DeleteOriginal[]) {
  if (tasks.has(id) || finished.has(id)) return;
  tasks.set(id, { originals, outstanding: originals, completed: 0, observed: false });
  publish();
}
export function rejectOriginalDeletion(id: string) {
  if (tasks.delete(id)) publish();
}
export function acceptOriginalDeletion(id: string, expectedRead: number) {
  const task = tasks.get(id);
  if (task) task.expectedRead = expectedRead;
}
export function reconcileOriginalDeletions(receipts: FileTaskStatus[], sequence: number) {
  let changed = false;
  const committed: DeleteOriginal[] = [];
  const present = new Set(receipts.map(receipt => receipt.id));
  for (const [id, task] of tasks) {
    if ((task.observed || sequence >= (task.expectedRead ?? Infinity)) && !present.has(id)) {
      tasks.delete(id); finished.add(id); changed = true;
    }
  }
  for (const receipt of receipts) {
    if (finished.has(receipt.id)) continue;
    const active = receipt.phase === "running" || receipt.phase === "stopping";
    const before = tasks.get(receipt.id);
    const originals = receipt.deleteOriginals ?? before?.originals;
    if (!originals?.length) continue;
    if (before && (receipt.completed < before.completed || (before.observed && active && receipt.completed === before.completed))) continue;
    if (!active) finished.add(receipt.id);
    if (!active && !before && !hasReadReceipts) continue;
    const failures = new Set(receipt.failures.filter(item => !item.originalRemoved).map(item => item.id));
    for (const item of originals.slice(before?.completed ?? 0, receipt.completed)) {
      if (!failures.has(item.assetId)) committed.push(item);
    }
    if (active) tasks.set(receipt.id, { originals, completed: receipt.completed, outstanding: originals.slice(receipt.completed), observed: true });
    else tasks.delete(receipt.id);
    changed = true;
  }
  hasReadReceipts = true;
  if (committed.length) {
    epoch++;
    for (const item of committed) {
      const record = {item, epoch};
      committedIds.set(item.assetId, record); committedPaths.set(originalDeletionPathKey(item.path), record);
    }
    for (const listener of commitListeners) listener(committed);
  }
  if (changed) publish();
}
