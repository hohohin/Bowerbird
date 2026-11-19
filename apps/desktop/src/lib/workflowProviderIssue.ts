import type { WorkflowNode } from "./canvasWorkflow";
import { chatDshStatus, chatProviderAccessIssue, chatQuote } from "./chatCapabilities";
import { canUseComfyVideo } from "./comfyVideo";
import { canUseAgentRun, canUseByo, effectivePolicy } from "./entitlement";
import { cloudAccountIssue, generationProviderIssue, type GenerationAvailabilityState, type ProviderIssue } from "./generationAvailability";
import { DEFAULT_VIDEO_OPTIONS, videoProvider } from "./videoGeneration";
import { workflowAgentProvider } from "./workflowAgentChat";

export function workflowGenerationProvider(node: WorkflowNode) {
  return node.generation?.media === "video"
    ? videoProvider(node.generation.videoChannel, node.generation.videoOptions ?? DEFAULT_VIDEO_OPTIONS)
    : node.provider || "codex";
}

export function profileInputKey(assetIds: string[], prompt: string) {
  return JSON.stringify({ assets: [...new Set(assetIds)].sort(), prompt });
}

export function profileExtractionIssue(state: GenerationAvailabilityState): ProviderIssue | null {
  return cloudAccountIssue(state.cloudAuth) ?? (effectivePolicy(state.cloudEntitlement).can_use_visual_profiles
    ? null : { message: "当前账号暂未开放视觉规范提炼。", settings: "account" });
}

/** Only gate steps that require a new submission. Reading cached outputs has its own contract. */
export function workflowProviderIssue(node: WorkflowNode, state: GenerationAvailabilityState,
  chatProvider = workflowAgentProvider(node), quote = chatQuote.store.getState(), dsh = chatDshStatus.store.getState()): ProviderIssue | null {
  if (node.kind === "generation") return generationProviderIssue(workflowGenerationProvider(node), state);
  if (node.kind === "agent") return chatProviderAccessIssue(chatProvider, state, quote, dsh);
  if (node.kind === "visual-profile" && !node.profileId && !node.profileCache) return profileExtractionIssue(state);
  const { cloudAuth: auth, cloudEntitlement: entitlement } = state;
  if (node.kind === "comfy-video" && !canUseComfyVideo(auth, entitlement)) {
    return { message: "本地 H3 视频需要有效的 Pro／Studio 权益或测试账号资格。", settings: "account" };
  }
  if (node.kind === "voice" && !(auth?.logged_in && auth.user_id && auth.user_id === entitlement?.user_id
    && ["fresh", "grace"].includes(entitlement.offline_state ?? "") && (entitlement.is_test_account || canUseByo(entitlement)))) {
    return { message: "本机声音生成需要有效的 Pro／Studio 权益，请检查账号状态。", settings: "account" };
  }
  if (node.kind === "skill" && !(auth?.logged_in && auth.user_id && auth.user_id === entitlement?.user_id
    && entitlement.is_test_account && canUseAgentRun(entitlement, "bowerbird-unified-agent"))) {
    return { message: "当前账号尚未开放此技能，请使用已获授权的测试账号。", settings: "account" };
  }
  return null;
}
