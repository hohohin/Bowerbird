import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { LocalFileEntry } from "./externalFiles";

export interface FileWorkspaceConfig { root: string | null; places: string[]; projects: Record<string, string> }
export interface FileMoveStatus { id: string; state: "pending" | "copying" | "completed" | "failed" | "cancelled"; source: string; target: string; error: string | null; history?: unknown }
export interface FileMovePreview { source: string; target: string; files: number; bytes: number; projects: number; token: string; create_only?: boolean }
export interface HistoryMovePreview extends FileMovePreview { global: number; shared: number; folders: { id: string; name: string; path: string; files: number }[] }
export interface FileWorkspaceStatus { config: FileWorkspaceConfig; proposed_root: string; migration?: FileMoveStatus | null }
export interface RestoreItem { record_path: string; file: string; asset_id: string | null; action: "import" | "relink" | "existing" | "blocked"; message: string }
export interface RestorePreview { token: string; items: RestoreItem[] }
export const fileWorkspace = {
  status: () => invoke<FileWorkspaceStatus>("file_workspace_status"),
  movePreview: (parent: string) => invoke<FileMovePreview>("file_workspace_move_preview", { parent }),
  moveSchedule: (parent: string, token: string) => invoke<void>("file_workspace_move_schedule", { parent, token }),
  moveCancel: () => invoke<void>("file_workspace_move_cancel"),
  historyPreview: () => invoke<HistoryMovePreview>("file_workspace_history_preview"),
  historySchedule: (token: string) => invoke<void>("file_workspace_history_schedule", { token }),
  place: (path: string, added: boolean) => invoke<FileWorkspaceConfig>("file_workspace_place", { path, added }),
  all: () => invoke<{ entries: LocalFileEntry[]; unavailable: string[] }>("file_workspace_all"),
  previewRestore: (root: string, recursive: boolean) => invoke<RestorePreview>("file_workspace_restore_preview", { root, recursive }),
  restore: (root: string, recursive: boolean, token: string) => invoke<{ imported: number; relinked: number }>("file_workspace_restore", { root, recursive, token }),
  saveRecords: (root: string) => invoke<{ total: number; pending: number; local: number }>("file_workspace_save_records", { root }),
};

/** Do not create a project in a different location without the user's selection. */
export async function prepareFileWorkspace(projectId?: string, name?: string): Promise<string> {
  const args = { root: null as string | null, projectId: projectId ?? null, name: name ?? null };
  try { return await invoke<string>("file_workspace_prepare", args); }
  catch (error) {
    if (!String(error).includes("FILE_ROOT_REQUIRED:")) throw error;
    const root = await open({ directory: true, multiple: false, title: "资料目录无法写入，请选择 BowerbirdLibrary 的保存位置" });
    if (!root || Array.isArray(root)) throw new Error("未选择可写的资料目录，已取消创建");
    return invoke<string>("file_workspace_prepare", { ...args, root });
  }
}
