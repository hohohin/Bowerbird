import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { Asset } from "./types";

export interface FolderConnection {
  id: string; parent_id: string | null; root_id: string; name: string; path: string;
  available: boolean; count: number; scanning: boolean; error: string | null;
}
export interface ConnectionEntry {
  id: string; folder_id: string; asset_id: string; name: string; path: string;
  is_reference: boolean; available: boolean; asset: Asset;
}
export type ConnectionMedia = "images" | "videos" | null;
async function entryBatches(command: string, ids: string[], key: string, args: Record<string, unknown> = {}) {
  for (let offset = 0; offset < ids.length; offset += 2000) await invoke<void>(command, { ...args, [key]: ids.slice(offset, offset + 2000) });
}
export const folderConnections = {
  list: (projectId: string | null = null, media: ConnectionMedia = null) => invoke<FolderConnection[]>("folder_connections", { projectId, media }),
  connect: (path: string, projectId: string | null = null) => invoke<string>("connect_folder", { path, projectId }),
  refresh: () => invoke<void>("refresh_folder_connections"),
  page: (folderId: string, offset: number, limit: number, media: ConnectionMedia = null, projectId: string | null = null) => invoke<ConnectionEntry[]>("connection_entries", { folderId, offset, limit, media, projectId }),
  ids: async (folderId: string | null = null, media: ConnectionMedia = null, projectId: string | null = null, start = 0, count = Infinity) => {
    const result: string[] = [];
    for (let offset = start; offset < start + count; offset += 2000) {
      const limit = Math.min(2000, start + count - offset);
      const page = await invoke<string[]>("connection_entry_ids", { folderId, media, projectId, offset, limit });
      result.push(...page); if (page.length < limit) break;
    }
    return result;
  },
  resolve: async (ids: string[]) => {
    const result: ConnectionEntry[] = [];
    for (let offset = 0; offset < ids.length; offset += 2000) result.push(...await invoke<ConnectionEntry[]>("resolve_connection_entries", { ids: ids.slice(offset, offset + 2000) }));
    return result;
  },
  references: (assetIds: string[], folderId: string) => entryBatches("create_material_references", assetIds, "assetIds", { folderId }),
  create: (parentId: string | null, name: string, path: string | null = null, projectId: string | null = null) => invoke<string>("create_connected_collection", { parentId, name, path, projectId }),
  renameFolder: (id: string, name: string) => invoke<void>("rename_connected_collection", { id, name }),
  moveFolder: (id: string, targetId: string) => invoke<void>("move_connected_collection", { id, targetId }),
  disconnect: (id: string) => invoke<void>("disconnect_folder", { id }),
  relocate: (id: string, path: string) => invoke<void>("relocate_folder", { id, path }),
  trashFolder: (id: string) => invoke<void>("trash_connected_collection", { id }),
  renameEntry: (id: string, name: string) => invoke<void>("rename_connection_entry", { id, name }),
  moveEntries: (ids: string[], folderId: string) => entryBatches("move_connection_entries", ids, "ids", { folderId }),
  trashEntries: (ids: string[]) => entryBatches("trash_connection_entries", ids, "ids"),
};

// Retain a connect request while the destination view is still mounting.
export const useConnectedNavigation = create<{ id: string | null; paneId: string | null; sequence: number }>(() => ({ id: null, paneId: null, sequence: 0 }));
export function navigateConnectedFolder(id: string, paneId: string | null = null) {
  useConnectedNavigation.setState(state => ({ id, paneId, sequence: state.sequence + 1 }));
}

export function connectedRows(folders: FolderConnection[]) {
  const result: { item: FolderConnection; depth: number }[] = [], seen = new Set<string>();
  const children = new Map<string | null, FolderConnection[]>();
  for (const item of folders) { const siblings = children.get(item.parent_id); if (siblings) siblings.push(item); else children.set(item.parent_id, [item]); }
  function visit(parent: string | null, depth: number) {
    for (const item of children.get(parent) ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id); result.push({ item, depth }); visit(item.id, depth + 1);
    }
  }
  visit(null, 0);
  return result;
}
