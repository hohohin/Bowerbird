import { assertWorkflowAcyclic, workflowBindingKey, workflowConnectionError, workflowInputs, workflowOutputs,
  type WorkflowInput, type WorkflowNode, type WorkflowPortType } from "./canvasWorkflow.ts";

export type AutomaticMedia = "image" | "video" | "audio";
export interface AutomaticOutput {
  binding: WorkflowInput;
  type: WorkflowPortType;
  /** Absent for containers whose content will be resolved at execution time. */
  media?: AutomaticMedia | AutomaticMedia[];
}
export interface AutomaticConnectionPlan {
  bindings: { inputId: string; binding: WorkflowInput }[];
  error: string | null;
}

/** The legacy image pipe also transports video/audio; never use its name as MIME. */
export function automaticInputMedia(node: WorkflowNode): AutomaticMedia[] {
  if (node.kind === "agent" && node.skill === "hyperframes" && node.agentTransport === "codex-cli") return ["image", "video", "audio"];
  if (node.kind === "comfy-video" && node.comfyVideo?.mode === "text") return [];
  if (node.kind === "generation" && node.generation?.media === "video"
    && node.generation.videoOptions?.kind !== "frames2video"
    && (!node.generation.videoOptions?.model_version || node.generation.videoOptions.model_version.startsWith("seedance2"))) return ["image", "video", "audio"];
  if (node.kind === "text" && node.textTarget?.image) return ["image", "video"];
  return ["image"];
}

/** Pure, all-or-nothing plan. Callers assign one autoConnect id when committing. */
export function planAutomaticConnection(nodes: WorkflowNode[], outputs: AutomaticOutput[], targetId: string): AutomaticConnectionPlan {
  const fail = (error: string): AutomaticConnectionPlan => ({ bindings: [], error });
  const target = nodes.find(node => node.id === targetId);
  if (!target) return fail("接收卡片已不存在");
  if (target.kind === "visual-profile" && target.profileId) return fail("请先切换到从输入提炼");
  const acceptedMedia = automaticInputMedia(target);
  const inputs = Object.fromEntries(Object.entries(target.inputs).map(([id, bindings]) => [id, [...bindings]]));
  const bindings: AutomaticConnectionPlan["bindings"] = [];
  let compatible = false;
  for (const output of outputs) {
    const source = output.binding;
    if (source.nodeId === targetId || source.canvasNodeId && (source.canvasNodeId === target.textSource || source.canvasNodeId === target.textTarget?.nodeId))
      return fail("不能连接卡片自身");
    if (output.type === "session") continue;
    const producer = nodes.find(node => node.id === source.nodeId);
    if (source.nodeId && (!producer || !workflowOutputs(producer).some(port => port.id === source.portId && port.type === output.type)))
      return fail("来源卡片或输出已不存在");
    const knownMedia = output.media ? (Array.isArray(output.media) ? output.media : [output.media])
      : producer?.kind === "comfy-video" || producer?.kind === "generation" && producer.generation?.media === "video" ? ["video"] : undefined;
    if (target.kind !== "trigger" && output.type === "image" && knownMedia && !knownMedia.some(media => acceptedMedia.includes(media as AutomaticMedia))) continue;
    let candidates = workflowInputs(target).filter(port => port.type === output.type);
    if (target.kind === "trigger") {
      if (!producer || producer.kind === "trigger" || producer.textSource) continue;
      candidates = [{ id: "completion", label: "完成触发", type: "signal" }];
    } else if (output.type === "signal" && target.kind !== "planner") {
      candidates = [{ id: "signal", label: "触发", type: "signal" }];
    }
    if (!candidates.length) continue;
    // One image source fills one frame; reconnecting it never occupies the other.
    if (candidates.some(port => (inputs[port.id] ?? []).some(input => target.kind === "trigger" ? input.nodeId === source.nodeId : workflowBindingKey(input) === workflowBindingKey(source)))) {
      compatible = true;
      if (target.kind === "trigger") break;
      continue;
    }
    const single = (id: string) => id === "visual-profile" || target.kind === "comfy-video" && id !== "text"
      || target.kind === "instruction" && target.action !== "describe" || target.kind === "loop" && target.loopMode === "rows";
    const port = candidates.find(port => !single(port.id) || !inputs[port.id]?.length);
    if (!port) return fail(target.kind === "comfy-video" ? target.comfyVideo?.mode === "reference" ? "参考图已连接，请先移除要替换的来源" : "首尾帧已连接，请先移除要替换的来源" : "此输入已有来源，请先断开后再连接");
    if (target.kind === "generation" && target.generation?.videoOptions?.kind === "frames2video" && port.id === "image" && (inputs.image?.length ?? 0) >= 2)
      return fail("首尾帧已连接，请先移除要替换的来源");
    if (source.nodeId) {
      const error = workflowConnectionError(nodes, source.nodeId, source.portId!, targetId, port.id);
      if (error) return fail(error);
    }
    compatible = true;
    const { mediaFilter: _sourceMedia, ...identity } = source;
    const binding = { ...identity, ...(["text", "image"].includes(port.type) ? { mediaFilter: [...acceptedMedia] } : {}) };
    inputs[port.id] = [...(inputs[port.id] ?? []), binding];
    bindings.push({ inputId: port.id, binding });
    // Completion is one event per producer, regardless of its output count.
    if (target.kind === "trigger") break;
  }
  if (!compatible) return fail("这张卡片不能接收来源内容");
  try { assertWorkflowAcyclic(nodes.map(node => node.id === targetId ? { ...node, inputs } : node), targetId); }
  catch (error) { return fail(error instanceof Error ? error.message : "这条连接会形成循环"); }
  return { bindings, error: null };
}
