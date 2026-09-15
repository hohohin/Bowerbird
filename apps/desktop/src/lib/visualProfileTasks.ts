import { create } from "zustand";
import { useStore } from "../store";
import { api } from "./api";
import { summarizeBrandImages } from "./brandVisual";
import { describeBrandImage } from "./describeBrandImage";
import { notifyError, notifySuccess } from "./notify";
import { reminderStorageKey } from "./taskReminders";
import type { VisualProfileDetail, VisualProfileScopePreview } from "./types";

export interface VisualProfileTask {
  id: string;
  scopeKey: string;
  folderId: string;
  folderName: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  progress: string;
  canStop: boolean;
  result?: VisualProfileDetail;
  error?: string;
}

export const useVisualProfileTasks = create<{ tasks: VisualProfileTask[] }>(() => ({ tasks: [] }));
const controllers = new Map<string, AbortController>();
export function visualProfileTaskScope() {
  const state = useStore.getState();
  return reminderStorageKey(state.settings?.library_root, state.cloudAuth?.user_id);
}
function update(id: string, patch: Partial<VisualProfileTask>) {
  useVisualProfileTasks.setState((state) => ({ tasks: state.tasks.map((task) => task.id === id ? { ...task, ...patch } : task) }));
}
export function stopVisualProfileTask(id: string) {
  const task = useVisualProfileTasks.getState().tasks.find((item) => item.id === id);
  if (task?.status === "running" && task.canStop) controllers.get(id)?.abort();
}

/** 只接管原提炼流程的生命周期；不创建第二条分析队列或重发已提交的提炼。 */
export function startVisualProfileTask(folder: { id: string; name: string }, scope: VisualProfileScopePreview): string {
  const scopeKey = visualProfileTaskScope();
  const existing = useVisualProfileTasks.getState().tasks.find((task) => task.scopeKey === scopeKey && task.folderId === folder.id && task.status === "running");
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  const controller = new AbortController();
  controllers.set(id, controller);
  useVisualProfileTasks.setState((state) => ({ tasks: [{ id, scopeKey, folderId: folder.id, folderName: folder.name,
    status: "running", progress: "正在准备品牌图片…", canStop: true }, ...state.tasks] }));
  const checkScope = () => {
    if (!useStore.getState().cloudAuth?.logged_in || visualProfileTaskScope() !== scopeKey) {
      throw new Error("登录账号或素材库已变化，请重新开始总结");
    }
  };
  void (async () => {
    try {
      const result = await summarizeBrandImages({ scope, signal: controller.signal,
        preview: () => { checkScope(); return api.visualProfilePreview(folder.id); },
        describe: (assetId, signal) => { checkScope(); return describeBrandImage(assetId, signal); },
        extract: (assetIds) => {
          checkScope();
          update(id, { canStop: false });
          return api.visualProfileCloudExtract(folder.id, assetIds);
        },
        onProgress: (progress) => update(id, { progress }),
      });
      update(id, { status: "succeeded", result, canStop: false, progress: "提炼完成，待确认规范" });
      if (visualProfileTaskScope() === scopeKey) notifySuccess(`「${folder.name}」视觉规范提炼完成`);
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      const message = error instanceof Error ? error.message : typeof error === "string" ? error : "提炼失败，请重试";
      update(id, { status: cancelled ? "cancelled" : "failed", error: cancelled ? undefined : message,
        canStop: false, progress: cancelled ? "已停止提炼。正在分析的图片会完成，下次可接着继续。" : "提炼失败" });
      if (!cancelled && visualProfileTaskScope() === scopeKey) notifyError(null, `「${folder.name}」提炼失败：${message}`);
    } finally {
      controllers.delete(id);
    }
  })();
  return id;
}
