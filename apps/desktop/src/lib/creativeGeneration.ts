import { generationOutputNodeId } from "./projectNodeIds.ts";

export interface GenerationOutputTurn {
  id: number;
  images: string[];
  turnKey?: string | null;
}

export interface GenerationParentAssetInput {
  id: string;
  store_path?: string | null;
}

export interface GenerationParentLocator<T extends GenerationParentAssetInput> {
  asset: T | null;
  nodeId: string | null;
  storePath: string | null;
  turnKey: string | null;
}

export interface CreativeParentCandidate {
  assetId: string;
  nodeId: string;
  threadId: string;
}

export interface CreativeParentSelection<T extends { id: string }> {
  asset: T;
  nodeId: string | null;
  threadId: string;
}

export interface CreativeThreadResolution {
  threadId: string;
  parentNodeId: string | null;
  /** Exact sidecar request observed while resolving. It is acknowledged only
   * after the provider accepts the submission, so validation/network failures
   * cannot silently lose the requested parent. */
  continuationRequestId: string | null;
}

export interface CreativeContinuationIdentity {
  requestId: string;
  projectId: string;
}

export interface CreativeSubmissionClaim {
  isCurrent: () => boolean;
  release: () => void;
}

const creativeSubmissionClaims = new Map<string, symbol>();

/** A composer can unmount while its submission is awaiting prompt compilation,
 * canvas materialization, or provider startup. Keep the claim outside React so
 * a remounted composer in the same project cannot submit the same intent twice. */
export function acquireCreativeSubmission(
  projectId: string | null,
): CreativeSubmissionClaim | null {
  const scope = `project:${projectId ?? "__legacy_library__"}`;
  if (creativeSubmissionClaims.has(scope)) return null;
  const token = Symbol(scope);
  creativeSubmissionClaims.set(scope, token);
  return {
    isCurrent: () => creativeSubmissionClaims.get(scope) === token,
    release: () => {
      if (creativeSubmissionClaims.get(scope) === token) creativeSubmissionClaims.delete(scope);
    },
  };
}

/** Freeze-and-match barrier for an asynchronous composer send. A newer retry
 * must never be borrowed or acknowledged by an older send that was waiting on
 * draft flush, prompt compilation, or materialization. */
export function expectedCreativeContinuation<T extends CreativeContinuationIdentity>(
  current: T | null,
  expectedRequestId: string | null,
  projectId: string,
): T | null {
  if (!expectedRequestId) return null;
  if (current?.requestId !== expectedRequestId || current.projectId !== projectId) {
    throw new Error("续作请求已更新，本次发送已停止，请重新发送当前组稿");
  }
  return current;
}

/** Consume only the exact continuation that was submitted. A newer reuse
 * request may replace it while provider startup is in flight. */
export function acknowledgeCreativeContinuation<T extends { requestId: string }>(
  current: T | null,
  requestId: string,
): T | null {
  return current?.requestId === requestId ? null : current;
}

/**
 * 取一次继续/重试明确依赖的父结果。`beforeTurnId` 用于历史轮重放，避免错误地接到
 * 会话最新输出；未提供时取当前分支最后一个有图轮。
 */
export function latestGenerationOutput(
  turns: readonly GenerationOutputTurn[],
  beforeTurnId?: number,
): string | null {
  const end = beforeTurnId == null
    ? turns.length
    : Math.max(0, turns.findIndex((turn) => turn.id === beforeTurnId));
  for (let index = end - 1; index >= 0; index -= 1) {
    if (turns[index].images.length > 0) return turns[index].images[0];
  }
  return null;
}

function normalizedStorePath(path?: string | null): string | null {
  return path ? path.replace(/\\/g, "/").toLocaleLowerCase() : null;
}

/** Resolve the parent from the selected turn boundary, not by searching all
 * turns for a matching path. The same local asset/path can legitimately appear
 * in several rounds, while each round owns a different canvas output node. */
export function generationParentLocator<T extends GenerationParentAssetInput>(
  jobId: string,
  turns: readonly GenerationOutputTurn[],
  assets: readonly T[],
  options: { beforeTurnId?: number; atTurnId?: number } = {},
): GenerationParentLocator<T> {
  let selected: GenerationOutputTurn | null = null;
  if (options.atTurnId != null) {
    selected = turns.find((turn) => turn.id === options.atTurnId && turn.images.length > 0) ?? null;
  } else {
    const end = options.beforeTurnId == null
      ? turns.length
      : Math.max(0, turns.findIndex((turn) => turn.id === options.beforeTurnId));
    for (let index = end - 1; index >= 0; index -= 1) {
      if (turns[index].images.length > 0) {
        selected = turns[index];
        break;
      }
    }
  }
  const storePath = selected?.images[0] ?? null;
  const normalized = normalizedStorePath(storePath);
  const asset = normalized
    ? assets.find((candidate) => normalizedStorePath(candidate.store_path) === normalized) ?? null
    : null;
  const turnKey = selected?.turnKey ?? null;
  return {
    asset,
    nodeId: asset && turnKey ? generationOutputNodeId(jobId, turnKey, asset.id) : null,
    storePath,
    turnKey,
  };
}

/** Select one causal parent without treating unrelated reference images as an
 * ordered fallback. Ambiguity is user-visible and fail-closed. */
export function resolveContinuationParent<T extends { id: string }>(
  references: readonly T[],
  candidates: readonly CreativeParentCandidate[],
  options: {
    sidecar?: {
      parentAssetId: string;
      parentNodeId?: string | null;
      threadId: string;
    } | null;
    focusedNodeId?: string | null;
    focusedThreadId?: string | null;
  } = {},
): CreativeParentSelection<T> | null {
  const referencesById = new Map(references.map((reference) => [reference.id, reference]));
  const eligible = candidates.filter((candidate) => referencesById.has(candidate.assetId));
  const sidecar = options.sidecar;
  if (sidecar) {
    const asset = referencesById.get(sidecar.parentAssetId);
    if (asset) {
      const matches = eligible.filter((candidate) => (
        candidate.assetId === sidecar.parentAssetId
        && candidate.threadId === sidecar.threadId
        && (!sidecar.parentNodeId || candidate.nodeId === sidecar.parentNodeId)
      ));
      if (!sidecar.parentNodeId && matches.length > 1) {
        throw new Error("同一素材在线程中出现多次，请先在画板上选择具体父结果");
      }
      return {
        asset,
        nodeId: sidecar.parentNodeId ?? matches[0]?.nodeId ?? null,
        threadId: sidecar.threadId,
      };
    }
  }
  const focused = options.focusedNodeId
    ? eligible.find((candidate) => candidate.nodeId === options.focusedNodeId)
    : null;
  if (focused) {
    return { asset: referencesById.get(focused.assetId)!, nodeId: focused.nodeId, threadId: focused.threadId };
  }
  const inFocusedThread = options.focusedThreadId
    ? eligible.filter((candidate) => candidate.threadId === options.focusedThreadId)
    : [];
  const pool = inFocusedThread.length > 0 ? inFocusedThread : eligible;
  if (pool.length > 1) {
    throw new Error("引用了多个画板结果，请先选择具体父结果后再发送");
  }
  const selected = pool[0];
  return selected
    ? { asset: referencesById.get(selected.assetId)!, nodeId: selected.nodeId, threadId: selected.threadId }
    : null;
}

/**
 * 只从当前 creative graph 已确认的输出节点中选择续作父结果。普通参考图即使来自生成
 * provider，也不能隐式变成分支父节点。
 */
export function continuationParentAsset<T extends { id: string }>(
  references: T[],
  continuationAssetIds: string[],
): T | null {
  const referencesById = new Map(references.map((reference) => [reference.id, reference]));
  for (const assetId of continuationAssetIds) {
    const reference = referencesById.get(assetId);
    if (reference) return reference;
  }
  return null;
}
