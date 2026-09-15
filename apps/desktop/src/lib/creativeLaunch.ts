import type { PromptedAsset } from "./types";

export interface CreativePromptLoad {
  referenceNodeIds?: Array<string | null>;
  generation?: import("./videoGeneration").GenerationSettings;
  prompt: string;
  refs: PromptedAsset[];
  dimRefs: PromptedAsset[];
}

export interface CreativePromptLoadRequest extends CreativePromptLoad {
  id: string;
}

export interface CreativeLaunchRequest {
  id: string;
  projectId: string;
  assetIds: string[];
  promptLoad?: CreativePromptLoad;
}

export interface PendingCreativeReuseRequest {
  id: string;
  targetProjectId: string | null;
  promptLoad: CreativePromptLoad;
}

/** “新建创作”只带明确选择；“新建空白画板”始终忽略当前选择。 */
export function creativeLaunchAssetIds(blank: boolean, selectedIds: Iterable<string>) {
  if (blank) return [];
  return Array.from(new Set(selectedIds));
}

export function creativeLaunchTargetsProject(
  request: { projectId: string } | null,
  projectId: string | null,
) {
  return request != null && projectId != null && request.projectId === projectId;
}

/** Prompt 只可由目标项目内的创作器确认消费，不能被旧项目或编辑坞抢走。 */
export function creativePromptLoadForProject(
  request: CreativeLaunchRequest | null,
  projectId: string | null,
): CreativePromptLoadRequest | null {
  if (!request?.promptLoad || !creativeLaunchTargetsProject(request, projectId)) return null;
  return { id: request.id, ...request.promptLoad };
}

/** 异步路由只确认自己发起的请求，避免旧请求清掉更新的复用意图。 */
export function acknowledgeCreativeReuseRequest(
  request: PendingCreativeReuseRequest | null,
  requestId: string,
) {
  return request?.id === requestId ? null : request;
}
