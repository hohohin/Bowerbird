import type { AdaptiveAction } from "./adaptive-tool-gateway.ts";
import type { RunContextResource } from "./run-context-tools.ts";
import type { TaskAuthorization } from "../contracts/task-authorization.ts";

export function executionProgress(authorization: TaskAuthorization, actions: readonly AdaptiveAction[], candidateIds: readonly string[]) {
  const candidates = [...new Set(candidateIds)];
  const finalized = actions.find(action => action.toolName === "finalize_output" && action.status === "completed");
  return {
    requiredOutputCount: authorization.outputCount,
    availableCandidateCount: candidates.length,
    candidateArtifactIds: candidates,
    minimumAdditionalOutputs: Math.max(0, authorization.outputCount - candidates.length),
    finalizedOutputCount: finalized ? authorization.outputCount : 0,
    pendingActionIds: actions.filter(action => action.status === "pending").map(action => action.actionId),
    capabilities: authorization.capabilities.map(({ tool, maxCalls }) => {
      const used = actions.filter(action => action.toolName === tool).length;
      return { tool, used, remaining: Math.max(0, maxCalls - used) };
    }),
    instruction: "Candidates include intermediate outputs, not accepted deliveries. Select suitable outputs with finalize_output. Do not regenerate completed actions; pending actions recover with the same actionId.",
  };
}

export function actionContextPages(actions: readonly AdaptiveAction[]): RunContextResource[] {
  return actions.flatMap((action) => {
    // Put the outcome before potentially large HTML arguments so page zero is actionable.
    const { actionId, toolName, status, result, ...rest } = action;
    const text = JSON.stringify({ actionId, toolName, status, result, ...rest });
    const count = Math.ceil(text.length / 2000);
    return Array.from({ length: count }, (_, page) => ({
      id: `action:${action.actionId}:${page}`, description: `${action.toolName} ${action.actionId} page ${page + 1}/${count}`,
      read: () => ({ format: "json-text-page", text: text.slice(page * 2000, (page + 1) * 2000),
        nextId: page + 1 < count ? `action:${action.actionId}:${page + 1}` : null }),
    }));
  });
}

export function actionOutputIds(action: AdaptiveAction): string[] {
  if (action.status !== "completed" || !action.result || typeof action.result !== "object") return [];
  const result = action.result as { artifactId?: unknown; outputs?: Array<{ artifactId?: unknown }>; visibleArtifactIds?: unknown[] };
  return [...new Set([result.artifactId, ...(result.outputs ?? []).map(output => output.artifactId),
    ...(result.visibleArtifactIds ?? [])].filter((id): id is string => typeof id === "string"))];
}
