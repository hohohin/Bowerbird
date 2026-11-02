import { useStore } from "../store";
import { newWorkflowNode, type WorkflowNode } from "./canvasWorkflow";
import type { CanvasWorkflowController } from "./canvasWorkflowRuntime";
import { canUseComfyVideo, type ComposerLocalVideoRequest } from "./comfyVideo";

/** Both composers persist the same H3 card before starting its existing runtime. */
export async function startComposerLocalVideo(
  controller: CanvasWorkflowController,
  request: ComposerLocalVideoRequest,
  point: { x: number; y: number },
  edit: (nodes: WorkflowNode[]) => Promise<void> = nodes => controller.edit(nodes),
): Promise<WorkflowNode> {
  if (!controller.ready) throw new Error("工作流正在载入，请稍后重试");
  const account = useStore.getState();
  if (!canUseComfyVideo(account.cloudAuth, account.cloudEntitlement)) throw new Error("本地 H3 需要有效的 Pro／Studio 权益或测试账号资格");
  const node = { ...newWorkflowNode("comfy-video", point.x, point.y, "comfy-video"),
    prompt: request.prompt, comfyVideo: { ...request.options },
    inputs: { "first-frame": [{ assetId: request.firstFrame }],
      ...(request.lastFrame ? { "last-frame": [{ assetId: request.lastFrame }] } : {}) } };
  await edit([...controller.document.nodes, node]);
  await controller.start(node.id, true, true);
  return node;
}
