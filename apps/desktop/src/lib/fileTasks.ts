import { invoke } from "@tauri-apps/api/core";
import type { AssetOriginal } from "./assetOriginals";
import { acceptOriginalDeletion, beginOriginalDeletion, reconcileOriginalDeletions, rejectOriginalDeletion, subscribeOriginalDeletionCommits, type DeleteOriginal } from "./pendingOriginalDeletion";
import { invalidateCatalog } from "./useCatalogRevision";

subscribeOriginalDeletionCommits(invalidateCatalog);

type FileRequest =
  | { kind: "delete"; originals: AssetOriginal[] }
  | { kind: "moveoriginals"; originals: AssetOriginal[]; folderId: string }
  | { kind: "add"; ids: string[]; folderId: string }
  | { kind: "move"; ids: string[]; folderId: string; versions?: Record<string, string> };

export interface FileTaskStatus {
  id: string;
  title: string;
  phase: "running" | "stopping" | "finished" | "cancelled";
  total: number;
  completed: number;
  succeeded: number;
  skipped: number;
  recycled: number;
  cleaned: number;
  failures: { id: string; label: string; message: string; retryable: boolean; originalRemoved?: boolean }[];
  retryId: string | null;
  deleteOriginals?: DeleteOriginal[];
  omissions?: FileTaskOmission[];
}
export interface FileTaskOmission { label: string; message: string }

export const FILE_TASKS_UPDATED = "file-tasks://changed";
const pending = new Map<string, string>();
const omissionsByTask = new Map<string, FileTaskOmission[]>();
const omissionKey = (id: string) => `bowerbird.fileTaskOmissions.${id}`;
let issuedRead = 0, reconciledRead = 0;
let lastReceipts: FileTaskStatus[] = [];
export async function listFileTasks() {
  const sequence = ++issuedRead;
  const tasks = await invoke<FileTaskStatus[]>("list_file_tasks");
  if (sequence > reconciledRead) {
    reconciledRead = sequence;
    lastReceipts = tasks;
    reconcileOriginalDeletions(tasks, sequence);
  }
  return lastReceipts.map(task => {
    let omissions = omissionsByTask.get(task.id);
    if (!omissions) {
      try { omissions = JSON.parse(sessionStorage.getItem(omissionKey(task.id)) ?? "null") ?? undefined; }
      catch { /* The window may have session storage disabled. */ }
    }
    return omissions ? { ...task, omissions } : task;
  });
}

/** Keep the same request identity if IPC loses an acknowledgement. */
export async function startFileTask(request: FileRequest, title: string, omissions?: FileTaskOmission[]): Promise<void> {
  const signature = JSON.stringify(request);
  const id = pending.get(signature) ?? crypto.randomUUID();
  pending.set(signature, id);
  if (request.kind === "delete") {
    beginOriginalDeletion(id, request.originals.map(item => ({assetId:item.asset_id, path:item.path, missing:item.missing})));
  }
  if (omissions?.length) {
    omissionsByTask.set(id, omissions);
    try { sessionStorage.setItem(omissionKey(id), JSON.stringify(omissions)); } catch { /* Keep the in-memory result. */ }
  }
  try {
    await invoke("start_file_task", { id, request, title });
  } catch (error) {
    const known = await listFileTasks().catch(() => []);
    if (!known.some(task => task.id === id)) { rejectOriginalDeletion(id); throw error; }
  }
  if (request.kind === "delete") acceptOriginalDeletion(id, issuedRead + 1);
  pending.delete(signature);
  window.dispatchEvent(new Event(FILE_TASKS_UPDATED));
}

export async function changeFileTask(action: "cancel" | "dismiss" | "retry", id: string) {
  if (action === "retry") {
    // One child per attempt; repeated clicks or lost acknowledgements rejoin it.
    const key = `retry:${id}`;
    const newId = pending.get(key) ?? crypto.randomUUID();
    pending.set(key, newId);
    const parent = lastReceipts.find(task => task.id === id);
    const failed = new Set(parent?.failures.filter(item => item.retryable).map(item => item.id));
    const originals = parent?.deleteOriginals?.filter(item => failed.has(item.assetId));
    if (!parent?.retryId && originals?.length) beginOriginalDeletion(newId, originals);
    try {
      await invoke("retry_file_task", { id, newId });
      acceptOriginalDeletion(newId, issuedRead + 1);
      const status = await listFileTasks();
      if (status.find(task => task.id === id)?.retryId !== newId) rejectOriginalDeletion(newId);
      pending.delete(key);
    } catch (error) {
      const status = await listFileTasks().catch(() => []);
      if (!status.some(task => task.id === newId)) { rejectOriginalDeletion(newId); throw error; }
      pending.delete(key);
    }
  } else {
    await invoke(action === "cancel" ? "cancel_file_task" : "dismiss_file_task", { id });
    if (action === "dismiss") {
      omissionsByTask.delete(id);
      try { sessionStorage.removeItem(omissionKey(id)); } catch { /* Storage is optional. */ }
    }
  }
  window.dispatchEvent(new Event(FILE_TASKS_UPDATED));
}
