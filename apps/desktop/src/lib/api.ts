import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  Analysis,
  Asset,
  AssetPrompt,
  CodexRequest,
  CodexResult,
  CreationPack,
  Folder,
} from "./types";

const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif"];

export const api = {
  // 健康检查
  ping: (name: string) => invoke<string>("ping", { name }),
  dbHealth: () => invoke<string>("db_health"),
  codexHealth: () => invoke<string>("codex_health"),

  // 导入
  importFiles: (sources: string[]) => invoke<Asset[]>("import_files", { sources }),
  importFolder: (path: string) => invoke<number>("import_folder", { path }),

  // 浏览
  listAssets: (folderId?: string, limit = 500, offset = 0) =>
    invoke<Asset[]>("list_assets", { folderId, limit, offset }),
  searchAssets: (query: string, limit = 500) =>
    invoke<Asset[]>("search_assets", { query, limit }),
  countAssets: () => invoke<number>("count_assets"),
  deleteAsset: (id: string) => invoke<void>("delete_asset", { id }),
  moveAssetsToFolder: (assetIds: string[], folderId: string) =>
    invoke<void>("move_assets_to_folder", { assetIds, folderId }),

  // 整理
  listFolders: () => invoke<Folder[]>("list_folders"),
  createFolder: (name: string, parentId?: string) =>
    invoke<string>("create_folder", { name, parentId }),
  createSmartFolder: (name: string, smartQuery: string) =>
    invoke<string>("create_smart_folder", { name, smartQuery }),

  // 文件选择对话框
  pickImageFiles: async (): Promise<string[]> => {
    const r = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: IMAGE_EXT }],
    });
    if (!r) return [];
    return Array.isArray(r) ? r : [r];
  },
  pickFolder: async (): Promise<string | null> => {
    const r = await open({ directory: true });
    return (r as string | null) ?? null;
  },

  // 提示词 / 创作包 / codex
  createPrompt: (body: string, title?: string, kind?: string) =>
    invoke<string>("create_prompt", { body, title, kind }),
  updatePrompt: (id: string, body: string, title?: string) =>
    invoke<void>("update_prompt", { id, body, title }),
  deletePrompt: (id: string) => invoke<void>("delete_prompt", { id }),
  linkPrompt: (assetId: string, promptId: string, role: string) =>
    invoke<void>("link_prompt", { assetId, promptId, role }),
  unlinkPrompt: (assetId: string, promptId: string) =>
    invoke<void>("unlink_prompt", { assetId, promptId }),
  listPromptsByAsset: (assetId: string) =>
    invoke<AssetPrompt[]>("list_prompts_by_asset", { assetId }),
  assemblePack: (assetIds: string[]) =>
    invoke<CreationPack>("assemble_pack", { assetIds }),
  codexRun: (req: CodexRequest, useReal?: boolean) =>
    invoke<CodexResult>("codex_run", { req, useReal }),
  codexRunStream: (req: CodexRequest, useReal?: boolean) =>
    invoke<void>("codex_run_stream", { req, useReal }),
  codexGeneratePromptForAsset: (assetId: string, role: string, useReal = false) =>
    invoke<string>("codex_generate_prompt_for_asset", { assetId, role, useReal }),
  // Phase 5：反推（描述图片）+ 分析结果
  describeAsset: (assetId: string, useReal = false) =>
    invoke<string>("codex_describe_asset", { assetId, useReal }),
  listAnalysesByAsset: (assetId: string) =>
    invoke<Analysis[]>("list_analyses_by_asset", { assetId }),
};
