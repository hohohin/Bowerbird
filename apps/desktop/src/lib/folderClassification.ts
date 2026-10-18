import { invoke } from "@tauri-apps/api/core";
import { localClassification, type ClassificationLabel } from "./localClassification";
import type { LocalFileEntry } from "./externalFiles";

export interface FolderPicture { id: string; path: string; fingerprint: string; tags: [string,string][]; rejected: string[]; observation: [string,string,number] | null }
export interface FolderClassification { root: string; storage?: "folder" | "local"; record: { version: number; recursive: boolean; labels: ClassificationLabel[]; pictures: FolderPicture[] } }
export const folderClassification = {
  view: (path: string) => invoke<FolderClassification>("folder_classification_view", { path }),
  images: (path: string, tagId: string) => invoke<LocalFileEntry[]>("folder_classification_images", { path, tagId }),
  client: (root: string, recursive: boolean) => ({
    ...localClassification,
    labels: async () => (await folderClassification.view(root)).record.labels,
    start: (options: { install?: boolean; tagId?: string; pendingOnly?: boolean } = {}) => options.install ? localClassification.start(options)
      : invoke<void>("folder_classification_start", { root, recursive, pendingOnly: options.pendingOnly ?? true, tagId: options.tagId ?? null }),
    save: (id: string | null, name: string, description: string, enabled: boolean) => invoke<string>("folder_classification_edit", { root, action: "save", id, name, description, enabled }),
    deleteLabels: (ids: string[]) => invoke<void>("folder_classification_edit", { root, action: "delete", ids }),
    example: (id: string, ids: string[], positive: boolean) => invoke<void>("folder_classification_edit", { root, action: "example", id, ids, positive }),
  }),
};
