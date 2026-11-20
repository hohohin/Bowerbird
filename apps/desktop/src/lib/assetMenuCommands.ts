import { useStore } from "../store";
import { api } from "./api";
import type { AssetDescribeEngine } from "./assetContextMenu";
import { loadDescribePrompt } from "./describePrompt";
import { externalFiles } from "./externalFiles";
import { notifyError, notifySuccess } from "./notify";
import { isWorkspaceOperationCurrent } from "./workspaceRoute";

type MenuFeedback = { setBusy: (busy: boolean) => void; onClose: () => void };
type MenuMutation = MenuFeedback & { isCurrent: () => boolean; onComplete?: () => void };

async function runFileCommand(feedback: MenuFeedback, command: () => Promise<void>, success: string, failure: string) {
  feedback.setBusy(true);
  try {
    await command();
    notifySuccess(success);
    feedback.onClose();
  } catch (error) {
    notifyError(error, failure);
    feedback.setBusy(false);
  }
}

export function revealAssetFolder(assetId: string, feedback: MenuFeedback) {
  return runFileCommand(feedback, () => api.revealAssetFolder(assetId), "已打开素材所在文件夹", "无法打开所在文件夹");
}

export function openAssetWithSystem(path: string, feedback: MenuFeedback) {
  return runFileCommand(feedback, () => api.openWithSystem(path), "已用系统程序打开素材", "无法用系统程序打开素材");
}

export function copyAssetFilePath(path: string, feedback: MenuFeedback) {
  return runFileCommand(feedback, () => navigator.clipboard.writeText(path), "文件路径已复制", "复制文件路径失败");
}

export function copyImageToClipboard(path: string, feedback: MenuFeedback) {
  return runFileCommand(feedback, async () => {
    const url = await api.readImageDataUrl(path);
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("图片解码失败"));
      element.src = url;
    });
    // ClipboardItem uses PNG across platforms. Drawing a GIF captures one frame.
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("图片转换 PNG 失败");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }, "图片已复制到剪贴板", "复制图片失败");
}

export async function reuseGenerationPrompt(assetId: string, feedback: MenuFeedback & {
  isCurrent: () => boolean;
  isLatest: () => boolean;
  navigate: () => void;
  reuseEmbeddedPrompt?: (prompt: string) => void;
}) {
  const route = useStore.getState();
  const expectedProjectId = route.activeProjectId;
  const expectedRouteRevision = route.projectRouteRevision;
  const isCurrentIntent = () => {
    const current = useStore.getState();
    return feedback.isLatest() && feedback.isCurrent() && isWorkspaceOperationCurrent(
      expectedProjectId, current.activeProjectId, current.projectRoutePending,
      expectedRouteRevision, current.projectRouteRevision,
    );
  };
  if (!isCurrentIntent()) return;
  feedback.setBusy(true);
  try {
    // 生成来源归中心素材。按当前项目过滤会漏掉迁移或恢复的素材。
    const history = await api.generationHistory(assetId, null);
    if (!isCurrentIntent()) {
      feedback.setBusy(false);
      return;
    }
    const first = history.turns[0];
    const prompt = first?.prompt_raw ?? first?.prompt ?? "";
    if (!prompt) {
      notifyError(null, "该生成图没有可复用的提示词记录");
      feedback.setBusy(false);
      return;
    }
    if (feedback.reuseEmbeddedPrompt) {
      feedback.reuseEmbeddedPrompt(prompt);
      feedback.onClose();
      return;
    }
    feedback.navigate();
    useStore.getState().reusePromptToBoard(prompt, history.references, history.dimension_assets, undefined, {
      media: history.media, videoOptions: history.video_options, ratio: history.ratio,
      videoChannel: history.provider?.startsWith("bowerbird-cloud") ? "cloud" : "jimeng",
    }, expectedProjectId && first?.project_id === expectedProjectId ? history.references.map(asset =>
      first?.reference_node_ids?.[first?.references?.indexOf(asset.store_path ?? "") ?? -1] ?? null) : undefined);
    notifySuccess("生成提示词已载入创作板");
    feedback.onClose();
  } catch (error) {
    if (isCurrentIntent()) notifyError(error, "读取生成提示词失败");
    feedback.setBusy(false);
  }
}

export async function setAssetLibraryVisibility(projectId: string | null | undefined, assetId: string, visible: boolean,
  external: boolean, feedback: MenuMutation) {
  if (!projectId) return;
  feedback.setBusy(true);
  try {
    if (visible && external) await externalFiles.copy(assetId);
    else await api.setCanvasAssetLibraryVisibility(projectId, assetId, visible);
    if (feedback.isCurrent()) feedback.onComplete?.();
    notifySuccess(visible ? "已加入素材库" : "已从素材库移除，画布图片已保留");
    feedback.onClose();
    void useStore.getState().reloadProjects();
  } catch (error) {
    notifyError(error, "调整素材库归属失败");
    feedback.setBusy(false);
  }
}

export async function removeAssetsFromProject(projectId: string | null, ids: string[], feedback: MenuMutation, canvas?: {
  projectId: string;
  nodeIds: readonly string[];
  prepareProjectRemoval?: (ids: string[]) => Promise<void>;
  removeCellImages?: () => void;
}) {
  if (!projectId) return;
  feedback.setBusy(true);
  try {
    await canvas?.prepareProjectRemoval?.(ids);
    await api.removeAssetsFromProject(projectId, ids, !!canvas);
    if (canvas && !canvas.nodeIds.length && useStore.getState().activeProjectId === canvas.projectId) canvas.removeCellImages?.();
    await useStore.getState().reloadProjects();
    notifySuccess("素材已移出当前项目");
    if (feedback.isCurrent()) feedback.onComplete?.();
    feedback.onClose();
  } catch (error) {
    notifyError(error, "移出项目失败");
    feedback.setBusy(false);
  }
}

export function enqueueDescribeWithEngine(ids: readonly string[], engine: AssetDescribeEngine, onComplete?: () => void) {
  const instruction = loadDescribePrompt();
  const store = useStore.getState();
  for (const id of ids) store.runDescribe(id, instruction, engine);
  onComplete?.();
}
