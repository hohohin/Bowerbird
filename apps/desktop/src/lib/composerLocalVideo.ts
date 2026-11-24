import { useStore } from "../store";
import { H3_R2V_INPUT_PORTS, H3_VIDEO_AUDIO_PORT, newWorkflowNode, type WorkflowNode } from "./canvasWorkflow";
import type { CanvasWorkflowController } from "./canvasWorkflowRuntime";
import { canUseComfyVideo, comfyVideoMode, type ComposerLocalVideoRequest } from "./comfyVideo";
import { cleanH3OptimizedPrompt, h3OptimizationInstruction, h3R2VPromptReferences } from "./h3PromptOptimization";
import { startCloudTextRewrite } from "./textAgent";

/** Both composers persist the same H3 card before starting its existing runtime. */
async function createComposerLocalVideo(
  controller: CanvasWorkflowController,
  request: ComposerLocalVideoRequest,
  point: { x: number; y: number },
  edit: (nodes: WorkflowNode[]) => Promise<void> = nodes => controller.edit(nodes),
): Promise<WorkflowNode> {
  if (!controller.ready) throw new Error("工作流正在载入，请稍后重试");
  const account = useStore.getState();
  if (!canUseComfyVideo(account.cloudAuth, account.cloudEntitlement)) throw new Error("本地 H3 需要有效的 Pro／Studio 权益或测试账号资格");
  const mode = comfyVideoMode(request.options);
  const bind = (ids: string[] = []) => ids.map(assetId => ({ assetId }));
  const node: WorkflowNode = { ...newWorkflowNode("comfy-video", point.x, point.y, "comfy-video"),
    prompt: request.prompt, comfyVideo: { ...request.options },
    inputs: mode === "r2v" ? { [H3_R2V_INPUT_PORTS.image]: bind(request.referenceImages),
      [H3_R2V_INPUT_PORTS.video]: bind(request.referenceVideos), [H3_R2V_INPUT_PORTS.audio]: bind(request.referenceAudios) }
      : { ...(mode !== "text" && request.firstFrame ? { "first-frame": [{ assetId: request.firstFrame }] } : {}),
      ...(mode === "frames" && request.lastFrame ? { "last-frame": [{ assetId: request.lastFrame }] } : {}),
      ...(request.audioAssetId ? { [H3_VIDEO_AUDIO_PORT]: [{ assetId: request.audioAssetId }] } : {}) } };
  await edit([...controller.document.nodes, node]);
  return node;
}

export async function startComposerLocalVideo(...args: Parameters<typeof createComposerLocalVideo>) {
  const node = await createComposerLocalVideo(...args);
  await args[0].start(node.id, true, true);
  return node;
}

/** Draft optimization creates no canvas nodes; native Agent history retains the original run. */
export async function optimizeComposerLocalVideo(request: ComposerLocalVideoRequest, projectId?: string): Promise<string> {
  const mode = comfyVideoMode(request.options);
  const instruction = h3OptimizationInstruction({ prompt: request.prompt, mode, seconds: request.options.seconds, ratio: request.options.ratio,
    firstFrameCount: (mode === "frames" || mode === "reference") && request.firstFrame ? 1 : 0, lastFrameCount: mode === "frames" && request.lastFrame ? 1 : 0,
    ...(mode === "r2v" ? h3R2VPromptReferences(request) : { audioReference: request.audioAssetId ? true : undefined }) });
  const job = await startCloudTextRewrite({ instruction, source: request.prompt, projectId });
  for (;;) {
    const result = await job.read();
    if (result !== null) {
      const prompt = cleanH3OptimizedPrompt(result);
      if (!prompt) throw new Error("Cloud DSH 未返回有效的优化提示词，请检查任务结果");
      return prompt;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
