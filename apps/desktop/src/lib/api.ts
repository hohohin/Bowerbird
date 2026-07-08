import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  Analysis,
  Asset,
  AssetPrompt,
  CodexHealth,
  CreationPack,
  Folder,
  PromptedAsset,
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

  // 提示词 / 创作包 / codex（统一走 codex CLI）
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
  listPromptedAssets: () => invoke<PromptedAsset[]>("list_prompted_assets"),
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
  }) =>
    invoke<void>("codex_create_image", {
      prompt: req.prompt,
      referenceImages: req.referenceImages,
      sessionId: req.sessionId ?? null,
    }),
  cancelCodexCreate: () => invoke<void>("cancel_codex_create"),
};
