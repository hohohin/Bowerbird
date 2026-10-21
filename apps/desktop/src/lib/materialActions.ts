import type { Asset } from "./types";
import { useStore } from "../store";
import { prepareExplorerCanvasDrop } from "./explorerCanvasDrop";

export async function addMaterialAssets(assets: Asset[], projectId: string | null, onClose: () => void, onCreateProject?: (ids?: string[]) => Promise<unknown>) {
  if (useStore.getState().activeProjectId !== projectId) throw new Error("项目已切换，请重新选择目标画板");
  if (!projectId) {
    if (!onCreateProject) throw new Error("当前无法创建项目，请返回主页重试");
    await onCreateProject(assets.map(asset => asset.id));
    onClose(); return;
  }
  onClose();
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const stage = document.querySelector<HTMLElement>(".canvas-stage:not(.is-view-hidden)");
  if (!stage) throw new Error("画板尚未就绪，请重试");
  const rect = stage.getBoundingClientRect();
  for (let i = 0; i < assets.length; i++) {
    const put = prepareExplorerCanvasDrop(stage, projectId, rect.left + rect.width / 2 + i * 24, rect.top + rect.height / 2 + i * 24);
    if (!put) throw new Error("画板已切换，请重试");
    await put(assets[i]);
  }
}
