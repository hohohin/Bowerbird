import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  Analysis,
  Asset,
  AssetTag,
  ColorBucket,
  CodexHealth,
  CreationPack,
  Folder,
  GenerationHistory,
  Preset,
  PromptedAsset,
  TagCount,
} from "./types";

const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif"];

export const api = {
  // 健康检查
  ping: (name: string) => invoke<string>("ping", { name }),
  dbHealth: () => invoke<string>("db_health"),

  // 导入
  importFiles: (sources: string[]) => invoke<Asset[]>("import_files", { sources }),
  importFolder: (path: string) => invoke<number>("import_folder", { path }),

  // 浏览
  listAssets: (folderId?: string, limit = 500, offset = 0) =>
    invoke<Asset[]>("list_assets", { folderId, limit, offset }),
  searchAssets: (query: string, limit = 500) =>
    invoke<Asset[]>("search_assets", { query, limit }),
  listAssetsSmart: (query: string) =>
    invoke<Asset[]>("list_assets_smart", { query }),
  countAssets: () => invoke<number>("count_assets"),
  deleteAsset: (id: string) => invoke<void>("delete_asset", { id }),
  moveAssetsToFolder: (assetIds: string[], folderId: string) =>
    invoke<void>("move_assets_to_folder", { assetIds, folderId }),
  // 右键菜单：在资源管理器中定位 / 用默认程序打开（store_path 由前端传，后端直接 spawn，不经 shell scope）。
  revealInFolder: (path: string) => invoke<void>("reveal_path_in_explorer", { path }),
  openWithSystem: (path: string) => invoke<void>("open_path_with_system", { path }),

  // 整理
  listFolders: () => invoke<Folder[]>("list_folders"),
  createFolder: (name: string, parentId?: string) =>
    invoke<string>("create_folder", { name, parentId }),
  createSmartFolder: (name: string, smartQuery: string) =>
    invoke<string>("create_smart_folder", { name, smartQuery }),
  createCollection: (name: string) =>
    invoke<string>("create_collection", { name }),
  listCollections: () => invoke<Folder[]>("list_collections"),
  listAssetCollections: (assetId: string) =>
    invoke<Folder[]>("list_asset_collections", { assetId }),
  addAssetToCollection: (assetId: string, collectionId: string) =>
    invoke<void>("add_asset_to_collection", { assetId, collectionId }),
  removeAssetFromCollection: (assetId: string, collectionId: string) =>
    invoke<void>("remove_asset_from_collection", { assetId, collectionId }),
  listAssetsByCollection: (collectionId: string, limit = 500, offset = 0) =>
    invoke<Asset[]>("list_assets_by_collection", { collectionId, limit, offset }),
  renameFolder: (id: string, name: string) =>
    invoke<void>("rename_folder", { id, name }),
  deleteFolder: (id: string) => invoke<void>("delete_folder", { id }),

  // 创作板「用途」（preset）：命名 prompt 片段，发送时作为基底注入（类 CLAUDE.md 上下文）。
  createPreset: (name: string, body: string) =>
    invoke<string>("create_preset", { name, body }),
  listPresets: () => invoke<Preset[]>("list_presets"),
  updatePreset: (id: string, name: string, body: string) =>
    invoke<void>("update_preset", { id, name, body }),
  deletePreset: (id: string) => invoke<void>("delete_preset", { id }),

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

  // 创作板（统一走 codex CLI）
  listPromptedAssets: () => invoke<PromptedAsset[]>("list_prompted_assets"),
  // 生成图同流程合并：取某资产的整组过程图（详情轮播 / 批量取可见组）
  listGenerationGroup: (assetId: string) =>
    invoke<Asset[]>("list_generation_group", { assetId }),
  listGenerationGroups: (assetIds: string[]) =>
    invoke<Record<string, Asset[]>>("list_generation_groups", { assetIds }),
  // 「回看生成对话」：取某生成图所在会话的完整生成时间线（各轮 prompt + 产出图 store_path）。
  generationHistory: (assetId: string) =>
    invoke<GenerationHistory>("generation_history", { assetId }),

  // 标签 / 自动归类（P2）
  listTags: (source?: string) =>
    invoke<TagCount[]>("list_tags", { source: source ?? null }),
  listAssetTags: (assetId: string) =>
    invoke<AssetTag[]>("list_asset_tags", { assetId }),
  setAssetTags: (assetId: string, names: string[], source: string) =>
    invoke<void>("set_asset_tags", { assetId, names, source }),
  reclassifyAll: () => invoke<void>("reclassify_all"),

  // 颜色量化（P3）
  paletteOverview: () => invoke<ColorBucket[]>("palette_overview"),
  listAssetsByColor: (bucket: string, folderId?: string) =>
    invoke<Asset[]>("list_assets_by_color", { bucket, folderId: folderId ?? null }),
  recomputeColors: () => invoke<void>("recompute_colors"),
  assemblePack: (assetIds: string[]) =>
    invoke<CreationPack>("assemble_pack", { assetIds }),
  codexGeneratePromptForAsset: (assetId: string, role: string) =>
    invoke<string>("codex_generate_prompt_for_asset", { assetId, role }),
  // Phase 5：反推（codex CLI 描述图片）+ 分析结果
  describeAsset: (assetId: string, instruction?: string) =>
    invoke<string>("codex_describe_asset", { assetId, instruction }),
  listAnalysesByAsset: (assetId: string) =>
    invoke<Analysis[]>("list_analyses_by_asset", { assetId }),
  openCodexSession: (sessionId: string) =>
    invoke<void>("open_codex_session", { sessionId }),
  deleteAnalysis: (id: string) => invoke<void>("delete_analysis", { id }),
  cancelCodexDescribe: () => invoke<void>("cancel_codex_describe"),
  codexHealth: () => invoke<CodexHealth>("codex_health"),
  // 创作板「生成」：把最终 prompt + 参考图发 codex（codex exec --image，同反推机制）出图。
  // 流式文本经 codex://chunk（Delta）回；生成图 copy 进 library/generations 后随 Done.images 回。
  // sessionId 非空 → codex exec resume 续接同一会话（多轮迭代修改，codex 记得上一张图）。
  codexCreateImage: (req: {
    prompt: string;
    referenceImages: string[];
    sessionId?: string | null;
    ratio?: string | null;
  }) =>
    invoke<void>("codex_create_image", {
      prompt: req.prompt,
      referenceImages: req.referenceImages,
      sessionId: req.sessionId ?? null,
      ratio: req.ratio ?? null,
    }),
  cancelCodexCreate: () => invoke<void>("cancel_codex_create"),
};
