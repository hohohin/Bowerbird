import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import type { Asset } from "./types";
import { isVideoPath } from "./videoGeneration";
import { useStore } from "../store";
import { useLocalFileMode } from "./localFileMode";

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("无法读取文件，请重新导入"));
    reader.readAsDataURL(blob);
  });
}

/** Existing files need their original path; only bitmap-only paste creates an original. */
export async function importDroppedMedia(file: File, projectId: string | null, source = "imported"): Promise<Asset> {
  let path = (file as File & { path?: string }).path;
  if (!path && source === "clipboard") {
    const paths = await invoke<string[]>("clipboard_file_paths");
    if (paths.length) {
      path = paths.find(value => value.split(/[\\/]/).pop() === file.name);
      if (!path && paths.length === 1) path = paths[0];
      if (!path) throw new Error("无法确定原文件位置，请使用「建立连接」选择素材文件夹");
    }
  }
  if (path) {
    const [asset] = await api.importFiles([path], projectId);
    if (!asset) throw new Error("未能连接原文件，请检查文件是否可访问");
    return asset;
  }
  if (source !== "clipboard") throw new Error("无法取得原文件位置，请使用「建立连接」选择素材文件夹");
  if (!file.type.startsWith("image/")) throw new Error("请选择素材文件夹建立连接");
  if (file.size > 50 * 1024 * 1024) throw new Error("图片不能超过 50 MB");
  return api.importImageBytes({ dataUrl: await readDataUrl(file), fileName: file.name || "clipboard.png", projectId, source: "clipboard" });
}

export async function prepareMediaImport(projectId: string | null, revision: number) {
  const state = useStore.getState();
  if (state.projectRoutePending || state.projectRouteRevision !== revision) throw new Error("项目已切换，请重新导入素材");
  if (!projectId) return;
  if (projectId === state.activeProjectId) await state.projectCanvasFlush?.();
  const current = useStore.getState();
  const project = current.projects.find(item => item.id === projectId);
  if (!project || project.archived_at) throw new Error("目标项目已不可用");
  if (project.provisional) {
    if (current.projectRoutePending || current.projectRouteRevision !== revision) throw new Error("项目已切换，请重新导入素材");
    await api.projectCanvasMaterialize({ projectId, name: project.name,
      workspacePath: project.workspace_path || `blank:${projectId}`, workspaceKey: `blank:${projectId}`,
      kind: project.kind || "blank", titleSource: project.title_source || "default", draftJson: '{"schema_version":1}' });
    useStore.setState(s => ({ projects: s.projects.map(p => p.id === projectId ? { ...p, provisional: false } : p) }));
    const route = useStore.getState();
    if (!route.projectRoutePending && route.projectRouteRevision === revision && route.activeProjectId === projectId) await api.setActiveProject(projectId);
  }
}

export function showImportedMedia(assets: Asset[], mode = useLocalFileMode) {
  if (!assets.length) return;
  const library = mode.getState();
  if (!library.open) return;
  const videos = assets.every(asset => isVideoPath(asset.store_path));
  library.setMedia(videos ? "videos" : "images");
  library.setCatalogView(videos ? "tags" : "all");
  library.setQuery("");
  library.setGeneratedFilter(null);
}
