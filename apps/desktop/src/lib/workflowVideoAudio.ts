import { api } from "./api";
import { WorkflowInputError, type WorkflowInput, type WorkflowNode, type WorkflowValue } from "./canvasWorkflow";
import { userErrorMessage } from "./userError";
import { workflowAssetMedia } from "./workflowCanvasCapabilities";
import type { AutomaticOutput } from "./workflowAutoConnect";

export function videoAudioOutputPreview(output: AutomaticOutput): AutomaticOutput {
  return { ...output, media: "audio", binding: { ...output.binding, videoFrame: undefined, videoAudio: {} } };
}

async function extractVideoAudio(projectId: string, videoId: string, isCurrent: () => boolean) {
  const ensureCurrent = () => {
    if (!isCurrent()) throw new DOMException("连接已取消", "AbortError");
  };
  ensureCurrent();
  const [video] = await api.getAssetsByIds([videoId]);
  ensureCurrent();
  if (!video?.store_path || workflowAssetMedia(video) !== "video") throw new Error("视频文件不可用，请检查来源卡片");
  const audio = await api.extractVideoAudio(video.store_path, crypto.randomUUID(), projectId);
  ensureCurrent();
  return audio.id;
}

export async function materializeVideoAudioOutput(
  projectId: string, output: AutomaticOutput, isCurrent: () => boolean,
): Promise<AutomaticOutput> {
  const videoId = output.binding.assetId;
  if (!videoId) throw new Error("视频来源尚无可用文件");
  const assetId = await extractVideoAudio(projectId, videoId, isCurrent);
  const preview = videoAudioOutputPreview(output);
  return { ...preview, binding: { ...preview.binding, videoFrame: undefined, videoAudio: { assetId } } };
}

export async function resolveDynamicVideoAudio(
  projectId: string, node: WorkflowNode, binding: WorkflowInput, value: WorkflowValue, halted: () => boolean,
): Promise<WorkflowValue> {
  const ids = value.assetIds ?? [];
  if (halted()) return value;
  if (ids.length !== 1) {
    throw new WorkflowInputError("视频音频引用需要上游输出一个视频，请检查上游生成结果", node, binding);
  }
  try {
    const assetId = await extractVideoAudio(projectId, ids[0], () => !halted());
    return { ...value, assetIds: [assetId], nodeIds: undefined };
  } catch (error) {
    if (halted()) return value;
    throw new WorkflowInputError(`无法提取上游视频的音频：${userErrorMessage(error, "请检查来源视频")}`, node, binding);
  }
}
