import { api } from "../api";
import { isAudioPath } from "../audioMedia";
import { isVideoPath } from "../videoGeneration";
import { automaticInputMedia } from "../workflowAutoConnect";
import { generationInputNode, H3_VIDEO_AUDIO_PORT, H3_R2V_INPUT_PORTS, type WorkflowNode, type WorkflowValue } from "../canvasWorkflow";
import { WorkflowInputError, WorkflowNodeError } from "../workflowDiagnostics";

const r2vPorts = Object.values(H3_R2V_INPUT_PORTS);

/** Filter new automatic bindings using actual asset metadata, before legacy frame conversion. */
export async function filterAutomaticMediaValues(node: WorkflowNode, values: Record<string, WorkflowValue[]>, nodes: readonly WorkflowNode[] = []) {
  const inputs = generationInputNode(node, nodes).inputs;
  const isAudioPort = (port: string) => node.kind === "comfy-video" && port === H3_VIDEO_AUDIO_PORT;
  const isR2VPort = (port: string) => node.kind === "comfy-video" && r2vPorts.some(id => id === port);
  const ids = [...new Set(Object.entries(values).flatMap(([port, items]) => items.flatMap((value, index) =>
    isAudioPort(port) || isR2VPort(port) || inputs[port]?.[index]?.mediaFilter ? value.assetIds ?? [] : [])))];
  if (!ids.length) return;
  const assets = new Map((await api.getAssetsByIds(ids)).map(asset => [asset.id, asset]));
  for (const [port, items] of Object.entries(values)) for (const [index, source] of items.entries()) {
    const binding = inputs[port]?.[index];
    const filter = binding?.mediaFilter;
    const audioPort = isAudioPort(port);
    if (!binding || !filter && !audioPort && !isR2VPort(port)) continue;
    const value = items[index] = structuredClone(source);
    const supported = automaticInputMedia(node, port);
    const accepted = filter?.filter(media => supported.includes(media)) ?? supported;
    value.assetIds = value.assetIds?.filter(id => {
      const asset = assets.get(id);
      if (audioPort && !asset?.store_path) throw new WorkflowInputError("参考录音已缺失，请检查来源连接", node, binding);
      if (!asset?.store_path) throw new WorkflowNodeError("输入素材已丢失，请检查来源卡片", node);
      const media = isAudioPath(asset.store_path) ? "audio" : isVideoPath(asset.store_path) ? "video" : "image";
      return accepted.includes(media);
    });
    if (audioPort && !value.nodeIds?.length && value.assetIds?.length !== 1) {
      throw new WorkflowInputError("请连接一段可用的本地录音", node, binding);
    }
    // A rejected media type may occur before a ranked image in the same container.
    if (binding.referenceRanks && value.assetIds?.length !== source.assetIds?.length) {
      const kept = new Set(value.assetIds);
      value.referenceRanks = source.assetIds?.flatMap((id, i) => kept.has(id) ? [binding.referenceRanks![i] ?? -1] : []);
    }
    const excludedTokens = new Set(value.imageRefs?.filter(ref => !value.assetIds?.includes(ref.asset_id)).map(ref => ref.token));
    value.imageRefs = value.imageRefs?.filter(ref => value.assetIds?.includes(ref.asset_id));
    if (excludedTokens.size) {
      const removeExcluded = (text: string) => text.replace(/@图片\d+/g, token => excludedTokens.has(token) ? "" : token);
      if (value.text !== undefined) value.text = removeExcluded(value.text);
      if (value.table) value.table = { ...value.table, rows: value.table.rows.map(row => row.map(removeExcluded)), ...(value.table.columns ? { columns: value.table.columns.map(removeExcluded) } : {}) };
    }
    if (value.type === "image" && !value.assetIds?.length && !value.nodeIds?.length && !isR2VPort(port)) {
      throw new WorkflowNodeError("来源卡片没有当前任务可用的素材，请检查来源或任务模式", node);
    }
  }
}
