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

/** HTML file drops have no trusted local path. Stream videos through bounded IPC chunks. */
export async function importDroppedMedia(file: File, projectId: string | null, source = "imported"): Promise<Asset> {
  if (!isVideoPath(file.name)) {
    if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name)) throw new Error("请选择图片或 MP4、MOV、WebM、MKV、AVI、M4V 视频");
    if (file.size > 50 * 1024 * 1024) throw new Error("图片不能超过 50 MB");
    return api.importImageBytes({ dataUrl: await readDataUrl(file), fileName: file.name || "clipboard.png", projectId, source });
  }
  const uploadId = await invoke<string>("video_import_begin", { fileName: file.name, size: file.size, projectId });
  try {
    const chunkSize = 1024 * 1024;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const data = await readDataUrl(file.slice(offset, offset + chunkSize));
      await invoke("video_import_append", { uploadId, offset, data: data.slice(data.indexOf(",") + 1) });
    }
    return await invoke<Asset>("video_import_finish", { uploadId });
  } finally {
    await invoke("video_import_cancel", { uploadId }).catch(() => {});
  }
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

export function showImportedMedia(assets: Asset[]) {
  if (!assets.length) return;
  const library = useLocalFileMode.getState();
  if (!library.open) return;
  const videos = assets.every(asset => isVideoPath(asset.store_path));
  library.setMedia(videos ? "videos" : "images");
  library.setCatalogView(videos ? "tags" : "all");
  library.setQuery("");
  library.setGeneratedFilter(null);
}
