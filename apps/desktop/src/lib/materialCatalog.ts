import { invoke } from "@tauri-apps/api/core";
import type { Asset, Folder } from "./types";
export type CatalogKind = "all" | "tags" | "collections";
export interface CatalogTag { id: string; name: string; description: string; count: number; projectCount: number }
export interface MaterialCatalog { tags: CatalogTag[]; collections: Folder[]; prompts: string[]; tag_asset_ids: Record<string, string[]> }
export interface CatalogFilter { kind: CatalogKind; id: string | null; projectId: string | null; media: "images" | "videos"; query: string; generated: boolean | null; color: string | null }
export interface CatalogOverview { catalog: MaterialCatalog; total: number; untagged: number }
export const materialCatalog = {
  overview: (filter: CatalogFilter, contextProject: string | null) => invoke<CatalogOverview>("catalog_overview", { filter, contextProject }),
  page: (filter: CatalogFilter, offset: number, limit: number) => invoke<Asset[]>("catalog_page", { filter, offset, limit }),
  ids: (filter: CatalogFilter, offset: number, limit: number) => invoke<string[]>("catalog_ids", { filter, offset, limit }),
  prepareColors: (filter: CatalogFilter, after: string | null) => invoke<{ after: string | null; more: boolean; failed: number; updated: number }>("catalog_prepare_colors", { filter, after }),
  saveCollection: (id: string | null, name: string, parentId: string | null) => invoke<string>("save_collection_node", { id, name, parentId }),
  deleteCollection: (id: string) => invoke<void>("delete_collection_node", { id }),
  members: (id: string, assetIds: string[], added = true) => invoke<void>("set_collection_members", { id, assetIds, added }),
};
