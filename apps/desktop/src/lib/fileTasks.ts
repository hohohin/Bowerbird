import { invoke } from "@tauri-apps/api/core";
import type { AssetOriginal } from "./assetOriginals";

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
  failures: { id: string; label: string; message: string; retryable: boolean }[];
  retryId: string | null;
  omissions?: FileTaskOmission[];
}
export interface FileTaskOmission { label: string; message: string }

export const FILE_TASKS_UPDATED = "file-tasks://changed";
const pending = new Map<string, string>();
const omissionsByTask = new Map<string, FileTaskOmission[]>();
const omissionKey = (id: string) => `bowerbird.fileTaskOmissions.${id}`;
export async function listFileTasks() {
  const tasks = await invoke<FileTaskStatus[]>("list_file_tasks");
  return tasks.map(task => {
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
  if (omissions?.length) {
    omissionsByTask.set(id, omissions);
    try { sessionStorage.setItem(omissionKey(id), JSON.stringify(omissions)); } catch { /* Keep the in-memory result. */ }
  }
  try {
    await invoke("start_file_task", { id, request, title });
  } catch (error) {
    const known = await listFileTasks().catch(() => []);
    if (!known.some(task => task.id === id)) throw error;
  }
  pending.delete(signature);
  window.dispatchEvent(new Event(FILE_TASKS_UPDATED));
}

export async function changeFileTask(action: "cancel" | "dismiss" | "retry", id: string) {
  if (action === "retry") {
    // One child per attempt; repeated clicks or lost acknowledgements rejoin it.
    await invoke("retry_file_task", { id, newId: crypto.randomUUID() });
  } else {
    await invoke(action === "cancel" ? "cancel_file_task" : "dismiss_file_task", { id });
    if (action === "dismiss") {
      omissionsByTask.delete(id);
      try { sessionStorage.removeItem(omissionKey(id)); } catch { /* Storage is optional. */ }
    }
  }
  window.dispatchEvent(new Event(FILE_TASKS_UPDATED));
}
