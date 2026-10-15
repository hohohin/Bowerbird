import type { WorkflowNode, WorkflowValue } from "./canvasWorkflow";

export interface AgentOutputTarget {
  id: string; writerId: string; type: "text" | "image";
  nodeId: string; cellId: string; append: boolean;
}

export function agentOutputWriters(agent: WorkflowNode, nodes: WorkflowNode[]) {
  return nodes.filter(writer => writer.textTarget && (["text", "image"] as const).some(type =>
    writer.inputs[type]?.some(input => input.nodeId === agent.id && input.portId === type)));
}

/** Resolve only explicitly mentioned, still-connected destinations; never positional row IDs. */
export function agentOutputTargets(agent: WorkflowNode, nodes: WorkflowNode[]): AgentOutputTarget[] {
  const writers = agentOutputWriters(agent, nodes), targets: AgentOutputTarget[] = [];
  for (const match of agent.prompt.matchAll(/@\[([^\]]+)\]/g)) {
    const ref = agent.promptReferences?.find(ref => ref.id === match[1]);
    if (ref?.direction !== "output") continue;
    if (agent.agentTransport === "cloud") throw new Error("输出位置引用目前支持本机 DSH 和 Codex CLI，请切换 Agent 引擎");
    const writer = writers.find(writer => writer.id === ref.input.nodeId);
    if (!writer || !!writer.textTarget!.image !== (ref.type === "image")) throw new Error(`输出位置「${ref.label}」已断开或改接，请重新按 @ 选择`);
    if (targets.some(target => target.writerId === writer.id)) continue;
    const target = writer.textTarget!;
    targets.push({ id: `output${targets.length + 1}`, writerId: writer.id, type: ref.type,
      nodeId: target.nodeId, cellId: target.cellId, append: !!target.append });
  }
  if (targets.length > 32) throw new Error("Agent 每次最多指定 32 个输出位置");
  return targets;
}

/** Validate the complete assignment before any content writer runs. Image numbers refer
 * to the actual attachment order, not filenames, paths or model-invented asset IDs. */
export function routeAgentOutputs(outputs: Record<string, WorkflowValue>, targets: AgentOutputTarget[], inputImages: string[]): Record<string, WorkflowValue> {
  if (!targets.length) return outputs;
  let parsed;
  try { parsed = JSON.parse((outputs.text?.text ?? "").trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")); }
  catch { throw new Error("Agent 未按指定输出位置返回结果，请检查原任务；未写入内容卡"); }
  const invalid = () => new Error("Agent 输出分配无效：位置须完整且不重复，图片编号须来自本次输入或生成结果；未写入内容卡");
  if (!parsed || parsed.format !== "bowerbird-deliveries" || Object.keys(parsed).some(key => !["format", "deliveries"].includes(key))
    || !Array.isArray(parsed.deliveries) || parsed.deliveries.length !== targets.length) throw invalid();
  const deliveries: NonNullable<WorkflowValue["deliveries"]> = {};
  const allImages: string[] = [], summary: string[] = [];
  const selectImages = (indices: unknown, available: string[]) => {
    if (indices === undefined) return [];
    if (!Array.isArray(indices) || indices.length > 1000 || indices.some(i => !Number.isSafeInteger(i) || i < 1 || i > available.length)) throw invalid();
    return indices.map(i => available[i - 1]);
  };
  for (const item of parsed.deliveries) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some(key => !["target", "text", "inputImages", "generatedImages"].includes(key))) throw invalid();
    const target = targets.find(target => target.id === item.target);
    if (!target || deliveries[target.writerId] || item.text !== undefined && (typeof item.text !== "string" || item.text.length > 16000)) throw invalid();
    const assetIds = [...new Set([...selectImages(item.inputImages, inputImages), ...selectImages(item.generatedImages, outputs.image?.assetIds ?? [])])];
    if (target.type === "image" && item.text) throw invalid();
    if (item.text === undefined && item.inputImages === undefined && item.generatedImages === undefined) throw invalid();
    const imageRefs = assetIds.map((asset_id, i) => ({ asset_id, token: `@图片${i + 1}` }));
    const value: WorkflowValue = target.type === "image" ? { type: "image", assetIds }
      : { type: "text", text: [item.text ?? "", imageRefs.map(ref => ref.token).join(" ")].filter(Boolean).join("\n"), assetIds, imageRefs };
    deliveries[target.writerId] = { nodeId: target.nodeId, cellId: target.cellId, append: target.append, value };
    allImages.push(...assetIds);
    summary.push(`输出位置 ${target.id.slice(6)}：${target.type === "image" ? `${assetIds.length} 张图片` : value.text || "（空）"}`);
  }
  return { ...outputs, text: { type: "text", text: summary.join("\n"), deliveries }, image: { type: "image", assetIds: [...new Set(allImages)], ...(outputs.image?.nodeIds?.length ? { nodeIds: outputs.image.nodeIds } : {}) } };
}

/** undefined = ordinary broadcast, null = directed run that did not select this writer. */
export function agentWriterValue(writer: WorkflowNode, nodes: WorkflowNode[]): WorkflowValue | null | undefined {
  if (!writer.textTarget) return undefined;
  const input = Object.values(writer.inputs).flat()[0];
  const source = nodes.find(node => node.id === input?.nodeId && node.kind === "agent");
  const deliveries = source?.outputs.text?.deliveries;
  if (!deliveries) return undefined;
  const delivery = deliveries[writer.id];
  if (!delivery) return null;
  const target = writer.textTarget;
  if (delivery.nodeId !== target.nodeId || delivery.append !== !!target.append || !target.append && delivery.cellId !== target.cellId
    || delivery.value.type !== (target.image ? "image" : "text")) throw new Error("Agent 输出位置已改变，请重新运行 Agent");
  return delivery.value;
}
