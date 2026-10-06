export class WorkflowNodeError extends Error {
  node: WorkflowNode;
  constructor(message: string, node: WorkflowNode) { super(message); this.node = node; }
}
export class WorkflowInputError extends WorkflowNodeError {
  source: WorkflowInput;
  referenceLabel?: string;
  constructor(message: string, node: WorkflowNode, source: WorkflowInput, referenceLabel?: string) {
    super(message, node); this.source = source; this.referenceLabel = referenceLabel;
  }
}

/** Editable workflow wiring is independent from immutable generation history edges. */
export type WorkflowKind = "instruction" | "generation" | "skill" | "agent" | "visual-profile" | "text" | "trigger" | "planner" | "loop";
export const WORKFLOW_CARD_DRAG_TYPE = "application/x-bowerbird-workflow-card";
export type WorkflowAction = "describe" | "reuse" | "layers";
export type WorkflowPortType = "text" | "image" | "visual-profile" | "session" | "signal";
export interface WorkflowValue { type: WorkflowPortType; text?: string; table?: import("./workflowAgentResult").AgentTable; assetIds?: string[]; imageRefs?: { asset_id: string; token: string }[]; profileId?: string; version?: number; summary?: string; nodeIds?: string[] }
export interface WorkflowPort { id: string; label: string; type: WorkflowPortType }
export interface WorkflowInput { slot?: number; nodeId?: string; portId?: string; assetId?: string; assetNodeId?: string; groupId?: string; assetIds?: string[]; canvasNodeId?: string; cellId?: string }
export interface WorkflowPromptReference { slot?: number; id: string; type: "text" | "image"; input: WorkflowInput; assetId?: string; label: string }
export interface WorkflowNode {
  id: string; kind: WorkflowKind; x: number; y: number;
  action: WorkflowAction; skill: string; prompt: string; ratio: string | null; provider: string;
  promptReferences?: WorkflowPromptReference[];
  overwriteDescribe?: boolean;
  describeCache?: { instruction: string; results: { assetId: string; sections: { title: string; body: string }[] }[] };
  agentTransport?: "local-ds" | "cloud";
  loopMode?: "images" | "rows";
  planning?: import("./workflowPlanner").WorkflowPlanningState;
  templateInstance?: import("./workflowTemplates").TemplateInstance;
  inputs: Record<string, WorkflowInput[]>;
  outputs: Record<string, WorkflowValue>;
  outputPorts: WorkflowPort[];
  trigger: boolean;
  sessionNodeIds?: string[];
  activeSessionNodeId?: string | null;
  resultNodeIds?: string[];
  resultGroupId?: string;
  textTarget?: { nodeId: string; cellId: string; cellIds?: string[]; tableCellIds?: string[][]; append?: boolean; image?: boolean };
  textSource?: string;
  profileId?: string;
  profileName?: string;
  profileCache?: { inputKey: string; profileId: string };
}
export interface WorkflowStep {
  contentTarget?: WorkflowNode["textTarget"];
  retrySafe?: boolean;
  localDsRequestId?: string;
  localDsImageProvider?: string;
  localDsGenerations?: Record<string, { request: WorkflowAgentGenerationRequest; jobId: string; turnKey: string; response?: WorkflowAgentGenerationResponse }>;
  diagnostic?: import("./workflowDiagnostics").WorkflowDiagnostic;
  describeJobIds?: string[];
  turnKey?: string;
  detail?: string;
  status: "pending" | "running" | "waiting" | "done" | "failed";
  error?: string; jobId?: string; agentRunId?: string; assetId?: string; profileId?: string; layerRequestKey?: string;
}
export interface WorkflowAgentGenerationRequest { id: string; prompt: string; images: string[]; ratio: string | null }
export interface WorkflowAgentGenerationResponse { images?: string[]; error?: string }
export interface WorkflowRun {
  id: string; startId: string; threadId: string; order: string[];
  accountId?: string | null;
  status: "running" | "waiting" | "done" | "failed" | "stopped";
  steps: Record<string, WorkflowStep>;
  lockedNodeIds?: string[];
  writeNodeIds?: string[];
  cellTexts?: Record<string, string>;
  cellValues?: Record<string, WorkflowValue>;
  loop?: WorkflowLoop;
}
export interface WorkflowLoopItem { text: string; assetIds: string[] }
export interface WorkflowLoop {
  nodeId: string; bodyIds: string[]; index: number;
  items?: WorkflowLoopItem[];
  completed: { outputs: Record<string, Record<string, WorkflowValue>>; steps: Record<string, WorkflowStep> }[];
}
export interface CanvasWorkflow { cardNames?: Record<string, string>; schema_version: 1; nodes: WorkflowNode[]; run: WorkflowRun | null; runs?: WorkflowRun[] }
export interface WorkflowSnapshot { revision: number; document: CanvasWorkflow }
export const emptyWorkflow = (): CanvasWorkflow => ({ schema_version: 1, nodes: [], run: null });

// These are methods of the existing unified Agent, never separate Agent runners.
export const WORKFLOW_SKILLS = [
  { id: "image-edit", label: "图片创作", instruction: "请读取并使用 bowerbird-controlled-image-edit 技能完成以下任务，交付图片。", image: true },
  { id: "html-layout", label: "HTML 图文排版", instruction: "请读取并使用 bowerbird-html-layout-render 技能完成以下任务，交付排版截图。", image: true },
] as const;

export function workflowInputs(node: WorkflowNode): WorkflowPort[] {
  if (node.kind === "trigger" || node.textSource) return [];
  if (node.kind === "loop") return node.loopMode === "rows" ? [{ id: "text", label: "内容行", type: "text" }] : [{ id: "image", label: "图片列表", type: "image" }];
  if (node.kind === "instruction") return [{ id: "image", label: "图片", type: "image" }];
  const ports: WorkflowPort[] = [{ id: "text", label: "文本", type: "text" }, { id: "image", label: "图片", type: "image" }];
  if (node.kind === "generation" || node.kind === "skill") ports.push({ id: "visual-profile", label: "视觉规范", type: "visual-profile" });
  return ports;
}
export function workflowOutputs(node: WorkflowNode): WorkflowPort[] {
  if (node.kind === "planner") return [];
  if (node.kind === "loop") return node.loopMode === "rows"
    ? [{ id: "text", label: "当前行文字", type: "text" }, { id: "image", label: "当前行图片", type: "image" }]
    : [{ id: "image", label: "当前图片", type: "image" }];
  if (node.kind === "agent") return [{ id: "text", label: "返回文字", type: "text" },
    ...(usesConnectedAgentInputs(node) ? [{ id: "image", label: "返回图片", type: "image" as const }] : [])];
  if (node.kind === "trigger") return [{ id: "signal", label: "触发", type: "signal" }];
  if (node.kind === "text") return node.textTarget?.image ? [{ id: "image", label: "图片", type: "image" }] : [{ id: "text", label: "文本", type: "text" }];
  if (node.kind === "generation") return [{ id: "image", label: "图片", type: "image" }];
  if (node.kind === "visual-profile") return [{ id: "visual-profile", label: "视觉规范", type: "visual-profile" }];
  if (node.kind !== "instruction") return [{ id: "image", label: node.kind === "skill" && node.skill === "html-layout" ? "排版截图" : "图片", type: "image" }];
  if (node.action === "reuse") return [{ id: "text", label: "生成提示词", type: "text" }, { id: "image", label: "参考图片", type: "image" }];
  if (node.action === "describe") return [{ id: "text", label: "提示词", type: "text" }];
  return [{ id: "image", label: "产物", type: "image" }];
}
export function workflowTitle(node: WorkflowNode): string {
  if (node.templateInstance) return `子流程 · ${node.templateInstance.template.name}`;
  if (node.kind === "planner") return "工作流助手";
  if (node.kind === "loop") return "循环卡片";
  if (node.kind === "agent") return "Agent 卡片";
  if (node.textSource) return "文本卡片";
  if (node.kind === "text") return "写入文本单元格";
  if (node.kind === "trigger") return "触发器卡片";
  return node.kind === "visual-profile" ? "视觉规范卡片" : node.kind === "generation" ? "生成卡片" : node.kind === "skill" ? "技能卡片" : "指令卡片";
}
export function newWorkflowNode(kind: WorkflowKind, x: number, y: number, provider: string): WorkflowNode {
  return { id: crypto.randomUUID(), kind, x, y, action: "describe", skill: "image-edit", prompt: "", ratio: null,
    provider, inputs: {}, outputs: {}, outputPorts: [], trigger: false };
}

export function workflowConnectionError(nodes: WorkflowNode[], fromId: string, portId: string, toId: string, inputId: string): string | null {
  const from = nodes.find(node => node.id === fromId), to = nodes.find(node => node.id === toId);
  if (!from || !to) return "连接的卡片已不存在";
  if (fromId === toId) return "不能连接卡片自身";
  const output = workflowOutputs(from).find(port => port.id === portId);
  const input = inputId === "signal" && to.kind !== "trigger" && to.kind !== "planner" ? { type: "signal" } : workflowInputs(to).find(port => port.id === inputId);
  if (!output || !input || input.type !== output.type) return "只能连接相同类型的端口";
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === fromId) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return nodes.some(node => Object.values(node.inputs).flat().some(binding => workflowInputProducers(nodes, binding).includes(id)) && visit(node.id));
  };
  return visit(toId) ? "这条连接会形成循环" : null;
}

/** Invalidate descendants when a definition changes; stale values never cross a wire. */
export function workflowInputProducer(nodes: WorkflowNode[], input: WorkflowInput): string | undefined {
  return input.nodeId ?? (input.canvasNodeId ? (nodes.find(node => node.textTarget?.nodeId === input.canvasNodeId && (node.textTarget?.cellId === input.cellId || node.textTarget?.cellIds?.includes(input.cellId ?? "")))
    ?? nodes.find(node => node.resultNodeIds?.includes(input.canvasNodeId!)))?.id : undefined);
}

export function workflowInputProducers(nodes: WorkflowNode[], input: WorkflowInput): string[] {
  if (input.canvasNodeId && (input.cellId === "*" || input.cellId === "*text")) return nodes.filter(node => node.textTarget?.nodeId === input.canvasNodeId || node.resultNodeIds?.includes(input.canvasNodeId!)).map(node => node.id);
  const id = workflowInputProducer(nodes, input);
  return id ? [id] : [];
}

/** Wiring checks graph structure, independently of prompt validity or cached outputs. */
export function assertWorkflowAcyclic(nodes: WorkflowNode[], startId: string): void {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("这条连接会形成循环");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const input of Object.values(byId.get(id)?.inputs ?? {}).flat()) {
      for (const producer of workflowInputProducers(nodes, input)) visit(producer);
    }
    visiting.delete(id);
    visited.add(id);
  };
  visit(startId);
}

export function invalidateWorkflow(nodes: WorkflowNode[], changedId: string): WorkflowNode[] {
  const ids = new Set([changedId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) if (!ids.has(node.id) && Object.values(node.inputs).flat().some(input => workflowInputProducers(nodes, input).some(id => ids.has(id)))) {
      ids.add(node.id); changed = true;
    }
  }
  return nodes.map(node => ids.has(node.id) ? { ...node, outputs: {} } : node);
}

/** Run downstream of the key plus missing prerequisites, without starting their unrelated branches. */
export function workflowOrder(nodes: WorkflowNode[], startId: string, single = false): string[] {
  nodes = workflowExecutionNodes(nodes, startId);
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (!byId.has(startId)) throw new Error("起点卡片不存在");
  const reachable = new Set([startId]);
  for (const id of reachable) for (const node of nodes) {
    // Receiving content is part of delivering this card's output, even for a single-card run.
    if (single && !node.textTarget) continue;
    if (Object.values(node.inputs).flat().some(input => workflowInputProducers(nodes, input).includes(id))) reachable.add(node.id);
  }
  for (const id of reachable) {
    // Missing prerequisites added below also deliver to their receivers, without running other branches.
    for (const node of nodes) if (node.textTarget && Object.values(node.inputs).flat().some(input => workflowInputProducers(nodes, input).includes(id))) reachable.add(node.id);
    if (single) continue;
    for (const input of Object.values(byId.get(id)!.inputs).flat()) {
      // A signal wire starts flows from the switch; it never pulls that trigger into another flow's execution.
      if (input.portId === "signal") continue;
      for (const producer of workflowInputProducers(nodes, input)) {
        if (!input.nodeId && !nodes.some(node => node.id === producer && node.kind === "text")) continue;
        const source = byId.get(producer);
        if (!source) throw new Error("连接的上游卡片已删除，请重新连接");
        // Image cells store their own value. Reading one does not replay an idle
        // input writer; writers reached by this run still execute before consumers.
        if (input.canvasNodeId && source.textTarget?.image && !reachable.has(producer)) continue;
        if (source.kind === "text" || !source.outputs[input.portId ?? "text"]) reachable.add(source.id);
      }
    }
  }
  const order: string[] = [], pending = new Set(reachable);
  while (pending.size) {
    const ready = [...pending].filter(id => Object.values(byId.get(id)!.inputs).flat().every(input => workflowInputProducers(nodes, input).every(id => !pending.has(id))));
    if (!ready.length) throw new Error("工作流包含循环，请先断开循环连接");
    for (const id of ready) { pending.delete(id); order.push(id); }
  }
  return order;
}

/** A text-card start reads current cells without rerunning their producers. */
export function workflowExecutionNodes(nodes: WorkflowNode[], startId: string): WorkflowNode[] {
  nodes = nodes.filter(node => node.kind !== "planner");
  nodes = nodes.map(generationInputNode);
  const start = nodes.find(node => node.id === startId);
  const sources = nodes.filter(node => node.textSource && (node.id === startId || (start?.kind === "trigger" && node.inputs.signal?.some(input => input.nodeId === startId))));
  if (!sources.length) return nodes;
  return nodes.map(node => ({ ...node, inputs: Object.fromEntries(Object.entries(node.inputs).map(([port, inputs]) =>
    [port, inputs.map(input => { const source = sources.find(source => source.textSource === input.canvasNodeId); return source ? { ...input, canvasNodeId: undefined, cellId: undefined, nodeId: source.id, portId: input.cellId } : input; })])) }));
}

export const workflowReferenceToken = (id: string) => `@[${id}]`;
export const workflowBindingKey = (input: WorkflowInput) => JSON.stringify([input.nodeId, input.portId, input.assetId, input.groupId, input.canvasNodeId, input.cellId, input.assetNodeId]);
/** An upstream card, folder or native cell owns the reference; its current images may change. */
export const workflowImageContainer = (input: WorkflowInput) => !!(input.nodeId || input.groupId || input.canvasNodeId);
export function activePromptReferences(node: WorkflowNode) {
  return (node.promptReferences ?? []).filter(ref => node.prompt.includes(workflowReferenceToken(ref.id)));
}
/** Input slots belong to the receiving card, independently of their current sources. */
export function normalizeWorkflowInputSlots(node: WorkflowNode, previous?: WorkflowNode): WorkflowNode {
  if (node.kind !== "generation" && node.kind !== "agent") return node;
  const inputs = { ...node.inputs };
  for (const type of ["text", "image"] as const) {
    if (!inputs[type]) continue;
    const used = new Set<number>();
    const numbered = inputs[type].map(input => {
      const slot = input.slot ?? previous?.inputs[type]?.find(old => workflowBindingKey(old) === workflowBindingKey(input))?.slot;
      if (!slot || used.has(slot)) return input.slot === undefined ? input : { ...input, slot: undefined };
      used.add(slot); return input.slot === slot ? input : { ...input, slot };
    });
    inputs[type] = numbered.map(input => {
      if (input.slot) return input;
      let slot = 1; while (used.has(slot)) slot++;
      used.add(slot); return { ...input, slot };
    });
  }
  const promptReferences = node.promptReferences?.map(ref => {
    // Old saves have source snapshots and numbered labels. Migrate the number,
    // never require the old cell/card to match the current end of that pipe.
    const labelSlot = /^(?:文本|图片来源|生成结果|图片)\s*(\d+)(?:\.\d+)?$/.exec(ref.label)?.[1];
    const bindings = inputs[ref.type] ?? [];
    const slot = ref.slot ?? (labelSlot ? Number(labelSlot) : undefined)
      ?? bindings.find(input => workflowReferenceMatchesInput(ref, input))?.slot
      ?? (bindings.length === 1 ? bindings[0].slot : undefined);
    const input = bindings.find(input => input.slot === slot);
    return { ...ref, slot, input: input ?? ref.input, assetId: undefined,
      label: slot ? `${ref.type === "text" ? "文本" : "图片来源"} ${slot}` : ref.label };
  });
  return { ...node, inputs, ...(promptReferences ? { promptReferences } : {}) };
}
export function rebindGenerationReferences(node: WorkflowNode): WorkflowNode {
  return normalizeWorkflowInputSlots(node);
}
export const workflowReferenceMatchesInput = (ref: WorkflowPromptReference, input: WorkflowInput) =>
  ref.slot !== undefined ? ref.slot === input.slot : workflowBindingKey(ref.input) === workflowBindingKey(input);
export function generationInputNode(node: WorkflowNode): WorkflowNode {
  if (node.kind !== "generation" && node.kind !== "agent") return node;
  node = rebindGenerationReferences(node);
  if (usesConnectedAgentInputs(node)) return node;
  const refs = activePromptReferences(node);
  return { ...node, inputs: { ...node.inputs, ...Object.fromEntries((["text", "image"] as const).map(type =>
    [type, (node.inputs[type] ?? []).filter(input => refs.some(ref => ref.type === type && workflowReferenceMatchesInput(ref, input)))])) } };
}
function usesConnectedAgentInputs(node: WorkflowNode) {
  return node.kind === "agent" && import.meta.env?.DEV !== false && node.agentTransport !== "cloud";
}
export function compileGenerationPrompt(node: WorkflowNode, values: Record<string, WorkflowValue[]>) {
  node = rebindGenerationReferences(node);
  const refs = activePromptReferences(node), inputs = generationInputNode(node).inputs;
  const resolved = new Map<string, WorkflowValue>();
  for (const ref of refs) {
    const index = (inputs[ref.type] ?? []).findIndex(input => workflowReferenceMatchesInput(ref, input));
    const value = values[ref.type]?.[index];
    const dynamic = ref.type === "image" && (ref.slot !== undefined || workflowImageContainer(ref.input));
    if (!value || (ref.assetId && !dynamic && !value.assetIds?.includes(ref.assetId))) throw new WorkflowInputError(`输入管道「${ref.label}」已断开或没有可用输出，请检查当前上游连接`, node, ref.input, ref.label);
    if (ref.type === "text" && !value.text?.trim()) throw new WorkflowInputError(`上游处理结束后，引用「${ref.label}」仍没有可用文本，请检查来源输出`, node, ref.input, ref.label);
    if (dynamic && !value.assetIds?.length) throw new WorkflowInputError(`上游处理结束后，引用「${ref.label}」仍没有可用图片，请检查来源卡片的输出`, node, ref.input, ref.label);
    resolved.set(ref.id, ref.type === "image" && ref.assetId && !dynamic ? { ...value, assetIds: [ref.assetId] } : value);
  }
  const assetIds: string[] = [];
  for (const match of node.prompt.matchAll(/@\[([^\]]+)\]/g)) for (const id of resolved.get(match[1])?.assetIds ?? []) if (!assetIds.includes(id)) assetIds.push(id);
  const prompt = node.prompt.replace(/@\[([^\]]+)\]/g, (token, id: string) => {
    const value = resolved.get(id);
    if (!value) return token;
    if (value.type === "image") return (value.assetIds ?? []).map(id => `@图片${assetIds.indexOf(id) + 1}`).join(" ");
    return (value.text ?? "").replace(/@图片\d+/g, token => { const ref = value.imageRefs?.find(ref => ref.token === token); return ref ? `@图片${assetIds.indexOf(ref.asset_id) + 1}` : token; });
  });
  if (!prompt.trim()) throw new Error("请在生成卡片文本框中填写指令，或通过 @ 引入内容");
  return { prompt, assetIds };
}

/** Keep instructions separate from referenced material, including long reverse prompts. */
export function compileAgentPrompt(node: WorkflowNode, values: Record<string, WorkflowValue[]>) {
  node = rebindGenerationReferences(node);
  const inputs = generationInputNode(node).inputs;
  const assetIds: string[] = [];
  const sources: Record<string, string> = {};
  const labels = new Map<string, string>();
  for (const match of node.prompt.matchAll(/@\[([^\]]+)\]/g)) {
    const ref = activePromptReferences(node).find(ref => ref.id === match[1]);
    if (!ref) throw new WorkflowNodeError("Agent 卡片包含无效引用，请重新按 @ 选择文字或图片", node);
    if (labels.has(ref.id)) continue;
    const index = (inputs[ref.type] ?? []).findIndex(input => workflowReferenceMatchesInput(ref, input));
    if (index < 0) throw new WorkflowInputError(`输入管道「${ref.label}」已断开，请重新连接上游`, node, ref.input, ref.label);
    const value = values[ref.type]?.[index];
    if (ref.type === "image") {
      const dynamic = ref.slot !== undefined || workflowImageContainer(ref.input);
      const ids = [...new Set(ref.assetId && !dynamic ? [ref.assetId] : value?.assetIds ?? [])];
      if (!ids.length || ids.some(id => !value?.assetIds?.includes(id))) throw new WorkflowInputError(`引用「${ref.label}」没有可用图片，请检查来源输出`, node, ref.input, ref.label);
      for (const id of ids) if (!assetIds.includes(id)) assetIds.push(id);
      labels.set(ref.id, ids.map(id => `图片 ${assetIds.indexOf(id) + 1}`).join("、"));
      continue;
    }
    if (!value?.text?.trim()) throw new WorkflowInputError(`上游处理结束后，引用「${ref.label}」仍没有可用文本，请检查来源输出`, node, ref.input, ref.label);
    const label = `引用文本 ${Object.keys(sources).length + 1}`;
    labels.set(ref.id, label); sources[label] = value.text;
  }
  if (usesConnectedAgentInputs(node)) {
    for (const type of ["text", "image"] as const) for (const [index, input] of (inputs[type] ?? []).entries()) {
      const value = values[type]?.[index];
      const label = `${type === "text" ? "文字" : "图片"}输入 ${index + 1}`;
      if (type === "image") {
        if (!value?.assetIds?.length) throw new WorkflowInputError(`已连接的${label}没有可用图片，请检查来源输出`, node, input, label);
        for (const id of value.assetIds) if (!assetIds.includes(id)) assetIds.push(id);
      } else {
        if (!value?.text?.trim()) throw new WorkflowInputError(`已连接的${label}没有可用文字，请检查来源输出`, node, input, label);
        if (!activePromptReferences(node).some(ref => ref.type === type && workflowReferenceMatchesInput(ref, input))) sources[`引用文本 ${Object.keys(sources).length + 1}`] = value.text;
      }
    }
  }
  return {
    prompt: node.prompt.replace(/@\[([^\]]+)\]/g, (_, id: string) => `【${labels.get(id)}】`),
    source: JSON.stringify(sources),
    assetIds,
  };
}

export function workflowInputValues(nodes: WorkflowNode[], node: WorkflowNode, cellText?: (nodeId: string, cellId: string) => string | WorkflowValue | undefined): Record<string, WorkflowValue[]> {
  const result: Record<string, WorkflowValue[]> = {};
  for (const port of workflowInputs(node)) {
    result[port.id] = (node.inputs[port.id] ?? []).map(input => {
      try {
      if (input.groupId && port.type === "image") {
        if (!input.assetIds?.length) throw new Error("文件夹中没有可用图片，请添加图片后重新运行");
        return { type: "image", assetIds: input.assetIds };
      }
      if (input.assetId && port.type === "image") return { type: "image", assetIds: [input.assetId] };
        if (input.canvasNodeId && (port.type === "text" || port.type === "image")) {
        const text = cellText?.(input.canvasNodeId, input.cellId ?? "");
        if (text === undefined) throw new Error("来源卡片或单元格不存在，请检查来源连接");
          const value: WorkflowValue = typeof text === "string" ? { type: "text", text } : text;
          if (value.type !== port.type) throw new Error("连接的单元格类型不匹配，请重新连接");
          if (value.type === "text" && !value.text?.trim()) throw new Error("来源卡片或单元格中没有可用文本");
          if (value.type === "image" && !value.assetIds?.length) throw new Error("来源卡片或单元格中没有可用图片");
          return value;
      }
      const source = nodes.find(candidate => candidate.id === input.nodeId);
      const value = source?.outputs[input.portId ?? ""];
      if (!value || value.type !== port.type) throw new Error(`${port.label}输入尚无有效结果，请先运行上游`);
      return value;
      } catch (error) {
        const ref = activePromptReferences(node).find(ref => ref.type === port.type && workflowReferenceMatchesInput(ref, input));
        throw new WorkflowInputError(`${ref ? `@${ref.label}：` : `${port.label}输入：`}${error instanceof Error ? error.message : String(error)}`, node, input, ref?.label);
      }
    });
  }
  const images = result.image?.flatMap(value => value.assetIds ?? []) ?? [];
  if ((result["visual-profile"]?.length ?? 0) > 1) throw new Error("每张卡片只能使用一份视觉规范");
  if (node.kind === "instruction" && (node.action === "describe" ? images.length < 1 : images.length !== 1)) throw new Error(node.action === "describe" ? "反推需要至少一张输入图片" : "指令卡片需要恰好一张输入图片");
  return result;
}

export function workflowBusy(document: CanvasWorkflow): boolean {
  return workflowRuns(document).some(workflowRunActive);
}
export const workflowRunActive = (run: WorkflowRun) => run.status === "running" || run.status === "waiting";
export const workflowRuns = (document: CanvasWorkflow): WorkflowRun[] => document.runs ?? (document.run ? [document.run] : []);
export function workflowDependencies(nodes: WorkflowNode[], order: string[]): string[] {
  const ids = new Set(order);
  for (const id of ids) for (const input of Object.values(nodes.find(node => node.id === id)?.inputs ?? {}).flat()) {
    if (input.portId === "signal" && !order.includes(input.nodeId ?? "")) continue;
    for (const producer of workflowInputProducers(nodes, input)) ids.add(producer);
  }
  const tables = new Set(nodes.filter(node => ids.has(node.id) || (node.textTarget && Object.values(node.inputs).flat().some(input => order.includes(input.nodeId ?? "")))).flatMap(node => [...(node.resultNodeIds ?? []), ...(node.textTarget ? [node.textTarget.nodeId] : [])]));
  for (const node of nodes) if ((node.textTarget && tables.has(node.textTarget.nodeId)) || node.resultNodeIds?.some(id => tables.has(id))) ids.add(node.id);
  return [...ids];
}
export function workflowLockedNodes(document: CanvasWorkflow): Set<string> {
  return new Set(workflowRuns(document).filter(workflowRunActive).flatMap(run => run.lockedNodeIds ?? workflowDependencies(document.nodes, run.order)));
}
/** Execution can rewrite outputs and native result tables; cached dependencies are read-only. */
export function workflowWriteNodes(nodes: WorkflowNode[], order: string[]): string[] {
  const ids = new Set(order);
  const tables = new Set(nodes.filter(node => ids.has(node.id) || (node.textTarget && Object.values(node.inputs).flat().some(input => order.includes(input.nodeId ?? "")))).flatMap(node => [...(node.resultNodeIds ?? []), ...(node.textTarget ? [node.textTarget.nodeId] : [])]));
  for (const node of nodes) if ((node.textTarget && tables.has(node.textTarget.nodeId)) || node.resultNodeIds?.some(id => tables.has(id))) ids.add(node.id);
  return [...ids];
}
export function workflowAccessConflict(readsAndWrites: string[], writes: string[], otherAccess: string[], otherWrites: string[]): boolean {
  return writes.some(id => otherAccess.includes(id)) || otherWrites.some(id => readsAndWrites.includes(id));
}
export function workflowNodeRun(document: CanvasWorkflow, nodeId: string): WorkflowRun | undefined {
  const runs = workflowRuns(document).filter(run => run.order.includes(nodeId));
  return runs.find(workflowRunActive) ?? runs[runs.length - 1];
}
export function workflowActiveSession(node: WorkflowNode): string | null {
  return node.activeSessionNodeId !== undefined ? node.activeSessionNodeId : node.sessionNodeIds?.[node.sessionNodeIds.length - 1] ?? null;
}
export const WORKFLOW_CARD_WIDTH = 320;
export function workflowPortY(node: WorkflowNode, side: "input" | "output", portId: string): number {
  const ports = side === "input" ? workflowInputs(node) : workflowOutputs(node);
  return node.y + 94 + Math.max(0, ports.findIndex(port => port.id === portId)) * 30;
}
