/** Editable workflow wiring is independent from immutable generation history edges. */
export type WorkflowKind = "instruction" | "generation" | "skill" | "visual-profile";
export type WorkflowAction = "describe" | "reuse" | "layers";
export type WorkflowPortType = "text" | "image" | "visual-profile" | "session";
export interface WorkflowValue { type: WorkflowPortType; text?: string; assetIds?: string[]; profileId?: string; version?: number; summary?: string; nodeIds?: string[] }
export interface WorkflowPort { id: string; label: string; type: WorkflowPortType }
export interface WorkflowInput { nodeId?: string; portId?: string; assetId?: string; groupId?: string; assetIds?: string[]; canvasNodeId?: string; cellId?: string }
export interface WorkflowNode {
  id: string; kind: WorkflowKind; x: number; y: number;
  action: WorkflowAction; skill: string; prompt: string; ratio: string | null; provider: string;
  inputs: Record<string, WorkflowInput[]>;
  outputs: Record<string, WorkflowValue>;
  outputPorts: WorkflowPort[];
  trigger: boolean;
  sessionNodeIds?: string[];
  resultNodeIds?: string[];
  resultGroupId?: string;
  profileId?: string;
  profileName?: string;
  profileCache?: { inputKey: string; profileId: string };
}
export interface WorkflowStep {
  describeJobIds?: string[];
  detail?: string;
  status: "pending" | "running" | "waiting" | "done" | "failed";
  error?: string; jobId?: string; agentRunId?: string; assetId?: string; profileId?: string; layerRequestKey?: string;
}
export interface WorkflowRun {
  id: string; startId: string; threadId: string; order: string[];
  accountId?: string | null;
  status: "running" | "waiting" | "done" | "failed" | "stopped";
  steps: Record<string, WorkflowStep>;
  lockedNodeIds?: string[];
  cellTexts?: Record<string, string>;
}
export interface CanvasWorkflow { schema_version: 1; nodes: WorkflowNode[]; run: WorkflowRun | null; runs?: WorkflowRun[] }
export interface WorkflowSnapshot { revision: number; document: CanvasWorkflow }
export const emptyWorkflow = (): CanvasWorkflow => ({ schema_version: 1, nodes: [], run: null });

// These are methods of the existing unified Agent, never separate Agent runners.
export const WORKFLOW_SKILLS = [
  { id: "image-edit", label: "图片创作", instruction: "请读取并使用 bowerbird-controlled-image-edit 技能完成以下任务，交付图片。", image: true },
  { id: "html-layout", label: "HTML 图文排版", instruction: "请读取并使用 bowerbird-html-layout-render 技能完成以下任务，交付排版截图。", image: true },
] as const;

export function workflowInputs(node: WorkflowNode): WorkflowPort[] {
  if (node.kind === "instruction") return [{ id: "image", label: "图片", type: "image" }];
  const ports: WorkflowPort[] = [{ id: "text", label: "文本", type: "text" }, { id: "image", label: "图片", type: "image" }];
  if (node.kind === "generation" || node.kind === "skill") ports.push({ id: "visual-profile", label: "视觉规范", type: "visual-profile" });
  return ports;
}
export function workflowOutputs(node: WorkflowNode): WorkflowPort[] {
  if (node.kind === "generation") return [{ id: "session", label: "会话", type: "session" }];
  if (node.kind === "visual-profile") return [{ id: "visual-profile", label: "视觉规范", type: "visual-profile" }];
  if (node.kind !== "instruction") return [{ id: "image", label: node.kind === "skill" && node.skill === "html-layout" ? "排版截图" : "图片", type: "image" }];
  if (node.action === "reuse") return [{ id: "text", label: "生成提示词", type: "text" }, { id: "image", label: "参考图片", type: "image" }];
  const aggregate: WorkflowPort = node.action === "describe" ? { id: "text", label: "提示词", type: "text" }
    : { id: "image", label: "产物", type: "image" };
  return [aggregate, ...node.outputPorts.filter(port => port.id !== aggregate.id)];
}
export function workflowTitle(node: WorkflowNode): string {
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
  const input = workflowInputs(to).find(port => port.id === inputId);
  if (!output || !input || input.type !== output.type) return "只能连接相同类型的端口";
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === fromId) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return nodes.some(node => Object.values(node.inputs).flat().some(binding => workflowInputProducer(nodes, binding) === id) && visit(node.id));
  };
  return visit(toId) ? "这条连接会形成循环" : null;
}

/** Invalidate descendants when a definition changes; stale values never cross a wire. */
export function workflowInputProducer(nodes: WorkflowNode[], input: WorkflowInput): string | undefined {
  return input.nodeId ?? (input.canvasNodeId ? nodes.find(node => node.resultNodeIds?.includes(input.canvasNodeId!))?.id : undefined);
}

export function invalidateWorkflow(nodes: WorkflowNode[], changedId: string): WorkflowNode[] {
  const ids = new Set([changedId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) if (!ids.has(node.id) && Object.values(node.inputs).flat().some(input => ids.has(workflowInputProducer(nodes, input) ?? ""))) {
      ids.add(node.id); changed = true;
    }
  }
  return nodes.map(node => ids.has(node.id) ? { ...node, outputs: {} } : node);
}

/** Run downstream of the key plus missing prerequisites, without starting their unrelated branches. */
export function workflowOrder(nodes: WorkflowNode[], startId: string): string[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (!byId.has(startId)) throw new Error("起点卡片不存在");
  const reachable = new Set([startId]);
  for (const id of reachable) for (const node of nodes) {
    if (Object.values(node.inputs).flat().some(input => workflowInputProducer(nodes, input) === id)) reachable.add(node.id);
  }
  for (const id of reachable) for (const input of Object.values(byId.get(id)!.inputs).flat()) {
    if (!input.nodeId) continue;
    const source = byId.get(input.nodeId);
    if (!source) throw new Error("连接的上游卡片已删除，请重新连接");
    if (!source.outputs[input.portId ?? ""]) reachable.add(source.id);
  }
  const order: string[] = [], pending = new Set(reachable);
  while (pending.size) {
    const ready = [...pending].filter(id => Object.values(byId.get(id)!.inputs).flat().every(input => !pending.has(workflowInputProducer(nodes, input) ?? "")));
    if (!ready.length) throw new Error("工作流包含循环，请先断开循环连接");
    for (const id of ready) { pending.delete(id); order.push(id); }
  }
  return order;
}

export function workflowInputValues(nodes: WorkflowNode[], node: WorkflowNode, cellText?: (nodeId: string, cellId: string) => string | undefined): Record<string, WorkflowValue[]> {
  const result: Record<string, WorkflowValue[]> = {};
  for (const port of workflowInputs(node)) {
    result[port.id] = (node.inputs[port.id] ?? []).map(input => {
      if (input.groupId && port.type === "image") {
        if (!input.assetIds?.length) throw new Error("文件夹中没有可用图片，请添加图片后重新运行");
        return { type: "image", assetIds: input.assetIds };
      }
      if (input.assetId && port.type === "image") return { type: "image", assetIds: [input.assetId] };
      if (input.canvasNodeId && port.type === "text") {
        const text = cellText?.(input.canvasNodeId, input.cellId ?? "");
        if (text === undefined) throw new Error("文本单元格已删除，请重新连接");
        return { type: "text", text };
      }
      const source = nodes.find(candidate => candidate.id === input.nodeId);
      if (source?.kind === "generation" && input.portId === "image") throw new Error("生成卡已改为会话输出，请从会话中的图片重新连接输入");
      const value = source?.outputs[input.portId ?? ""];
      if (!value || value.type !== port.type) throw new Error(`${port.label}输入尚无有效结果，请先运行上游`);
      return value;
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
    const producer = workflowInputProducer(nodes, input);
    if (producer) ids.add(producer);
  }
  return [...ids];
}
export function workflowLockedNodes(document: CanvasWorkflow): Set<string> {
  return new Set(workflowRuns(document).filter(workflowRunActive).flatMap(run => run.lockedNodeIds ?? workflowDependencies(document.nodes, run.order)));
}
export function workflowNodeRun(document: CanvasWorkflow, nodeId: string): WorkflowRun | undefined {
  const runs = workflowRuns(document).filter(run => run.order.includes(nodeId));
  return runs.find(workflowRunActive) ?? runs[runs.length - 1];
}
export const WORKFLOW_CARD_WIDTH = 320;
export function workflowPortY(node: WorkflowNode, side: "input" | "output", portId: string): number {
  const ports = side === "input" ? workflowInputs(node) : workflowOutputs(node);
  return node.y + 94 + Math.max(0, ports.findIndex(port => port.id === portId)) * 30;
}
