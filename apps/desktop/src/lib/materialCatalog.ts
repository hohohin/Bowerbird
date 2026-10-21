import { invoke } from "@tauri-apps/api/core";
import type { Asset, Folder } from "./types";
export type CatalogKind = "tags" | "collections";
export interface CatalogTag { id: string; name: string; description: string; count: number; projectCount: number }
export interface MaterialCatalog { tags: CatalogTag[]; collections: Folder[]; prompts: string[]; tag_asset_ids: Record<string, string[]> }
export const materialCatalog = {
  read: (projectId: string | null) => invoke<MaterialCatalog>("material_catalog", { projectId }),
  assets: (kind: CatalogKind, id: string | null, projectId: string | null = null) => invoke<Asset[]>("material_catalog_assets", { kind, id, projectId }),
  saveCollection: (id: string | null, name: string, parentId: string | null) => invoke<string>("save_collection_node", { id, name, parentId }),
  deleteCollection: (id: string) => invoke<void>("delete_collection_node", { id }),
  members: (id: string, assetIds: string[], added = true) => invoke<void>("set_collection_members", { id, assetIds, added }),
};
