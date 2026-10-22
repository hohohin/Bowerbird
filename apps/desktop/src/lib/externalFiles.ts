import { invoke } from "@tauri-apps/api/core";
import type { Asset } from "./types";
export interface LocalFileEntry { path: string; name: string; directory: boolean; version?: string | null; preview?: string | null }
export interface LocalDirectory { path: string; parent: string | null; entries: LocalFileEntry[]; total: number }
export interface ExternalReference { asset: Asset; status: "available" | "missing" | "changed" }
export const OPEN_LOCAL_FILES = "bowerbird:open-local-files";
export const externalFiles = {
  browse: (path?: string, offset = 0) => invoke<LocalDirectory>("external_files_browse", { path: path || null, offset }),
  browseAll: (path?: string) => invoke<LocalDirectory>("external_files_browse", { path: path || null, offset: 0, all: true }),
  preview: (path: string) => invoke<string>("external_files_preview", { path }),
  media: (path: string) => invoke<string>("external_files_media", { path }),
  index: (path: string) => invoke<Asset>("external_files_index", { path }),
  rename: (assetId: string, path: string, name: string) => invoke<void>("local_file_rename", { assetId, path, name }),
  delete: (assetId: string, path: string) => invoke<void>("local_file_delete", { assetId, path }),
  references: (projectId: string) => invoke<ExternalReference[]>("external_files_references", { projectId }),
  update: (assetId: string, path: string, acceptChanges: boolean) => invoke<Asset>("external_files_update", { assetId, path, acceptChanges }),
  copy: (assetId: string) => invoke<Asset>("external_files_copy", { assetId }),
};
