import { assertWorkflowAcyclic, H3_R2V_INPUT_LIMITS, H3_R2V_INPUT_PORTS, H3_VIDEO_AUDIO_PORT, workflowBindingKey, workflowConnectionCycleError, workflowConnectionError, workflowInputs, workflowOutputs, workflowProducesVideo,
  type WorkflowInput, type WorkflowNode, type WorkflowPortType } from "./canvasWorkflow.ts";

export type AutomaticMedia = "image" | "video" | "audio";
const r2vMedia = Object.keys(H3_R2V_INPUT_PORTS) as AutomaticMedia[];
export interface AutomaticOutput {
  binding: WorkflowInput;
  /** Independent wire for one member of a multi-selection drag. */
  selectionWireId?: string;
  type: WorkflowPortType;
  /** Absent for containers whose content will be resolved at execution time. */
  media?: AutomaticMedia | AutomaticMedia[];
}
export interface AutomaticConnectionPlan {
  bindings: { inputId: string; binding: WorkflowInput }[];
  error: string | null;
}

export function contentCardAcceptsMedia(output: AutomaticOutput): boolean {
  if (!output.media) return true;
  const media = Array.isArray(output.media) ? output.media : [output.media];
  return output.selectionWireId ? !media.includes("audio") : media.some(type => type !== "audio");
}

/** The legacy image pipe also transports video/audio; never use its name as MIME. */
export function automaticInputMedia(node: WorkflowNode, portId?: string): AutomaticMedia[] {
  if (node.kind === "voice") return node.voice?.id ? [] : ["audio"];
  if (node.kind === "agent" && node.skill === "hyperframes" && node.agentTransport === "codex-cli") return ["image", "video", "audio"];
  if (node.kind === "agent") return ["image", "video"];
  if (node.kind === "comfy-video") {
    if (node.comfyVideo?.mode === "r2v") return portId ? r2vMedia.filter(media => H3_R2V_INPUT_PORTS[media] === portId) : r2vMedia;
    if (portId === H3_VIDEO_AUDIO_PORT) return ["audio"];
    const images: AutomaticMedia[] = node.comfyVideo?.mode === "text" ? [] : ["image"];
    return portId ? images : [...images, "audio"];
  }
  if (node.kind === "generation" && node.generation?.media === "video"
    && node.generation.videoOptions?.kind !== "frames2video"
    && (!node.generation.videoOptions?.model_version || node.generation.videoOptions.model_version.startsWith("seedance2"))) return ["image", "video", "audio"];
  if (node.kind === "text" && node.textTarget?.image) return ["image", "video"];
  return ["image"];
}

/** Pure, all-or-nothing plan. Callers assign one autoConnect id when committing. */
export function planAutomaticConnection(nodes: WorkflowNode[], outputs: AutomaticOutput[], targetId: string,
  generationOrigins?: ReadonlyMap<string, Pick<WorkflowNode, "id">>): AutomaticConnectionPlan {
  const fail = (error: string): AutomaticConnectionPlan => ({ bindings: [], error });
  const target = nodes.find(node => node.id === targetId);
  if (!target) return fail("接收卡片已不存在");
  if (target.kind === "visual-profile" && target.profileId) return fail("请先切换到从输入提炼");
  const acceptedMedia = automaticInputMedia(target);
  const inputs = Object.fromEntries(Object.entries(target.inputs).map(([id, bindings]) => [id, [...bindings]]));
  const bindings: AutomaticConnectionPlan["bindings"] = [];
  const rejectedMedia = new Set<string>();
  let compatible = false;
  for (const output of outputs) {
    const source = output.binding;
    const r2v = target.kind === "comfy-video" && target.comfyVideo?.mode === "r2v" && output.type === "image";
    if (source.nodeId === targetId || source.canvasNodeId && (source.canvasNodeId === target.textSource || source.canvasNodeId === target.textTarget?.nodeId))
      return fail("不能连接卡片自身");
    if (output.selectionWireId && target.kind === "trigger") return fail("此卡片不能接收整组选中的素材");
    if (output.type === "session") continue;
    if (generationOrigins && output.type !== "signal") {
      const error = workflowConnectionCycleError(nodes, source, targetId, generationOrigins);
      if (error) return fail(error);
    }
    const producer = nodes.find(node => node.id === source.nodeId);
    if (source.nodeId && (!producer || !workflowOutputs(producer).some(port => port.id === source.portId && port.type === output.type)))
      return fail("来源卡片或输出已不存在");
    if ((source.videoFrame || source.videoAudio) && producer && !workflowProducesVideo(producer)) return fail("来源卡片已不再输出视频");
    if (source.videoAudio && target.kind === "trigger") return fail("此输入只接收完成信号");
    const knownMedia: AutomaticMedia[] | undefined = source.videoAudio ? ["audio"] : source.videoFrame ? ["image"] : output.media ? (Array.isArray(output.media) ? output.media : [output.media])
      : producer?.kind === "voice" ? ["audio"] : producer && output.type === "image" && workflowProducesVideo(producer) ? ["video"] : undefined;
    if (output.selectionWireId && knownMedia?.some(media => !acceptedMedia.includes(media))) return fail("此卡片无法接收全部选中的素材类型");
    if (target.kind !== "trigger" && output.type === "image" && knownMedia && !knownMedia.some(media => acceptedMedia.includes(media))) {
      for (const media of knownMedia) rejectedMedia.add(media);
      continue;
    }
    let candidates = workflowInputs(target).filter(port => port.type === output.type);
    if (target.kind === "trigger") {
      const session = source.canvasNodeId && source.cellId === "image" && output.type === "image";
      if (!session && (!producer || producer.kind === "trigger" || producer.textSource)) continue;
      candidates = [{ id: "completion", label: "完成触发", type: "signal" }];
    } else if (output.type === "signal" && target.kind !== "planner") {
      candidates = [{ id: "signal", label: "触发", type: "signal" }];
    } else if (target.kind === "comfy-video" && output.type === "image") {
      const media = knownMedia ?? (r2v && !source.groupId && !source.canvasNodeId ? ["image" as const] : undefined);
      candidates = candidates.filter(port => media
        ? media.some(kind => automaticInputMedia(target, port.id).includes(kind))
        : port.id !== H3_VIDEO_AUDIO_PORT);
    }
    if (!candidates.length && output.selectionWireId) return fail("此卡片无法接收全部选中的素材");
    if (!candidates.length) continue;
    const alreadyConnected = (portId: string) => (inputs[portId] ?? []).some(input => target.kind === "trigger"
      ? source.nodeId ? input.nodeId === source.nodeId : input.canvasNodeId === source.canvasNodeId
      : workflowBindingKey(input) === workflowBindingKey(source));
    // One image source fills one legacy frame. R2V distributes mixed sources into each media socket.
    if (r2v) candidates = candidates.filter(port => !alreadyConnected(port.id));
    if (candidates.length === 0 || !r2v && candidates.some(port => alreadyConnected(port.id))) {
      compatible = true;
      if (target.kind === "trigger") break;
      continue;
    }
    const single = (id: string) => id === "visual-profile" || target.kind === "voice" && id === "image" || target.kind === "comfy-video" && id !== "text"
      || target.kind === "instruction" && target.action !== "describe" || target.kind === "loop" && target.loopMode === "rows";
    const ports = r2v ? candidates : candidates.filter(port => !single(port.id) || !inputs[port.id]?.length).slice(0, 1);
    if (!ports.length) return fail(target.kind === "comfy-video"
      ? candidates.every(port => port.id === H3_VIDEO_AUDIO_PORT) ? "已连接一段录音，请先移除要替换的来源"
        : target.comfyVideo?.mode === "reference" ? "参考图已连接，请先移除要替换的来源" : "首尾帧已连接，请先移除要替换的来源"
      : "此输入已有来源，请先断开后再连接");
    for (const port of ports) {
      const limit = r2v ? H3_R2V_INPUT_LIMITS[port.id] : undefined;
      if (limit && (inputs[port.id]?.length ?? 0) >= limit) return fail(`${port.label}最多连接 ${limit} 个来源`);
      if (target.kind === "generation" && target.generation?.videoOptions?.kind === "frames2video" && port.id === "image" && (inputs.image?.length ?? 0) >= 2)
        return fail("首尾帧已连接，请先移除要替换的来源");
      if (source.nodeId) {
        const error = workflowConnectionError(nodes, source.nodeId, source.portId!, targetId, port.id);
        if (error) return fail(error);
      }
      const { mediaFilter: _sourceMedia, ...identity } = source;
      const binding = { ...identity, ...(output.selectionWireId && { autoConnect: output.selectionWireId }),
        ...(["text", "image"].includes(port.type) ? { mediaFilter: source.videoAudio ? ["audio" as const] : automaticInputMedia(target, port.id) } : {}) };
      inputs[port.id] = [...(inputs[port.id] ?? []), binding];
      bindings.push({ inputId: port.id, binding });
    }
    compatible = true;
    // Completion is one event per producer, regardless of its output count.
    if (target.kind === "trigger") break;
  }
  if (!compatible && target.kind === "comfy-video") {
    if (target.comfyVideo?.mode === "r2v") return fail("H3 的「多素材参考（R2V）」接收图片、视频、音频和文本，请检查来源。");
    if (target.comfyVideo?.mode === "text") {
      if (rejectedMedia.has("image")) return fail("H3 的「文生视频」接收文本和录音。要连接图片，请切换到「单图」或「首尾帧」。");
      return fail("H3 的「文生视频」接收文本和录音，请检查来源。");
    }
    const frame = target.comfyVideo?.mode === "reference" ? "参考图" : "首帧或尾帧";
    if (rejectedMedia.has("video")) return fail(`H3 的${frame}需要图片。请先从视频中截取所需画面，再连接截取的图片。`);
    return fail(`H3 接收图片作为${frame}，也可以连接录音或提示词。`);
  }
  if (!compatible) return fail("这张卡片不能接收来源内容");
  try { assertWorkflowAcyclic(nodes.map(node => node.id === targetId ? { ...node, inputs } : node), targetId); }
  catch (error) { return fail(error instanceof Error ? error.message : "这条连接会形成循环"); }
  return { bindings, error: null };
}
