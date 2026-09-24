import { activePromptReferences, assertWorkflowAcyclic, invalidateWorkflow, newWorkflowNode, workflowBindingKey, workflowOutputs, workflowTitle, type WorkflowInput, type WorkflowNode } from "./canvasWorkflow";
import { buildWorkflowPlan, planningSnapshotKey, type PlanningSource } from "./workflowPlanner";

type CardKind = "trigger" | "instruction" | "agent" | "generation" | "skill" | "visual-profile";
interface CardSpec { id: string; kind: CardKind; prompt?: string; action?: string; skill?: string; ratio?: string | null; overwriteDescribe?: boolean }
interface EdgeSpec { from: string; output: string; to: string; input: string }
export interface TemplateContent { text?: string; images?: { dataUrl: string; token?: string }[] }
export interface TemplateInput { id: string; label: string; type: "text" | "image"; content?: TemplateContent }
export interface TemplateParameter { id: string; label: string; node: string; field: "suffix" | "ratio"; defaultValue: string }
export interface TemplateOutput { id: string; label: string; node: string; port: string }
export interface WorkflowTemplate {
  format: "bowerbird-workflow-template"; schemaVersion: 1 | 2; id: string; revision: number;
  name: string; description: string;
  plan: { summary: string; nodes: CardSpec[]; edges: EdgeSpec[] };
  inputs: TemplateInput[]; parameters: TemplateParameter[]; outputs: TemplateOutput[];
}
export interface TemplateInstance {
  template: WorkflowTemplate; nodeIds: string[]; values: Record<string, string>; bindings: Record<string, WorkflowInput>;
  // The configuration editor must never overwrite subsequent manual card edits.
  definitions: string[];
}
const ratios = ["", "1:1", "3:4", "4:3", "2:3", "3:2", "16:9", "9:16"];
export const TEMPLATE_RATIOS = ratios;
export const TEMPLATE_MAX_BYTES = 32_000_000;
function fail(message: string): never { throw new Error(message); }
const keys = (value: unknown, allowed: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail("模板包含无效或不支持的字段");
};
const label = (value: unknown, max = 120) => typeof value === "string" && !!value.trim() && value.length <= max;
const alias = (value: unknown) => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(value);
function dummySources(template: WorkflowTemplate): PlanningSource[] {
  return template.inputs.map(input => ({ ...input, input: input.type === "image" ? { assetId: input.id } : { canvasNodeId: input.id, cellId: "text" } }));
}
const executablePlan = (plan: WorkflowTemplate["plan"]) => ({ ...plan, nodes: plan.nodes.map(({ overwriteDescribe: _, ...node }) => node) });

/** Whitelist-only portable definitions: never deserialize a canvas or provider execution record. */
export function parseWorkflowTemplate(raw: string): WorkflowTemplate {
  if (new TextEncoder().encode(raw).length > TEMPLATE_MAX_BYTES) fail("模板超过 32 MB，请减少携带的素材");
  const value = JSON.parse(raw) as WorkflowTemplate;
  keys(value, ["format", "schemaVersion", "id", "revision", "name", "description", "plan", "inputs", "parameters", "outputs"]);
  if (value.format !== "bowerbird-workflow-template" || ![1, 2].includes(value.schemaVersion) || !label(value.id, 80) || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !label(value.name) || typeof value.description !== "string" || value.description.length > 2000) fail("模板版本或基本信息无效");
  if (!Array.isArray(value.inputs) || value.inputs.length > 48 || !Array.isArray(value.parameters) || value.parameters.length > 48 || !Array.isArray(value.outputs) || !value.outputs.length || value.outputs.length > 48) fail("模板接口数量无效");
  keys(value.plan, ["summary", "nodes", "edges"]);
  const ids = new Set<string>();
  for (const input of value.inputs) {
    keys(input, ["id", "label", "type", ...(value.schemaVersion === 2 ? ["content"] : [])]);
    if (!alias(input.id) || ids.has(input.id) || !label(input.label) || !["text", "image"].includes(input.type)) fail("模板输入无效或重复");
    ids.add(input.id);
    if (input.content !== undefined) {
      keys(input.content, ["text", "images"]);
      if (input.type === "text" ? typeof input.content.text !== "string" || input.content.text.length > 32_000 : input.content.text !== undefined) fail("模板携带文本无效");
      const images = input.content.images;
      if (images !== undefined && (!Array.isArray(images) || images.length > 48)) fail("模板携带图片数量无效");
      if (input.type === "image" && !images?.length) fail("模板携带图片不能为空");
      const tokens = new Set<string>();
      for (const picture of images ?? []) {
        keys(picture, ["dataUrl", "token"]);
        if (typeof picture.dataUrl !== "string" || picture.dataUrl.length > 12_000_000 || !/^data:image\/(png|jpeg|webp|gif|bmp);base64,[A-Za-z0-9+/]+={0,2}$/.test(picture.dataUrl)) fail("模板图片格式无效或超过 9 MB");
        if (input.type === "text" && (typeof picture.token !== "string" || !/^@图片\d+$/.test(picture.token) || tokens.has(picture.token))) fail("模板文本图片引用无效");
        if (picture.token) tokens.add(picture.token);
      }
    }
  }
  if (!Array.isArray(value.plan.nodes)) fail("模板步骤无效");
  for (const node of value.plan.nodes) {
    if (node?.overwriteDescribe !== undefined && (typeof node.overwriteDescribe !== "boolean" || node.kind !== "instruction" || node.action !== "describe")) fail("仅反推步骤可以配置覆盖已有描述");
  }
  const built = buildWorkflowPlan(JSON.stringify(executablePlan(value.plan)), newWorkflowNode("planner", 0, 0, ""), dummySources(value), []);
  for (const node of value.plan.nodes) ids.add(node.id);
  if (value.plan.nodes[0].kind !== "trigger") fail("模板第一张卡片必须是触发器");
  for (const param of value.parameters) {
    keys(param, ["id", "label", "node", "field", "defaultValue"]);
    const node = value.plan.nodes.find(node => node.id === param.node);
    if (!alias(param.id) || ids.has(param.id) || !label(param.label) || !node || node.kind === "trigger" || !["suffix", "ratio"].includes(param.field)
      || typeof param.defaultValue !== "string" || param.defaultValue.length > 2000 || (param.field === "ratio" && (node.kind !== "generation" || !ratios.includes(param.defaultValue)))
      || (param.field === "suffix" && node.kind === "instruction" && node.action !== "describe")
      || value.parameters.some(other => other !== param && other.node === param.node && other.field === param.field)) fail("模板参数无效或重复");
    if (param.field === "suffix" && /@\[|\{\{|\}\}/.test(param.defaultValue)) fail("附加要求不能包含内部引用语法");
    ids.add(param.id);
  }
  for (const output of value.outputs) {
    keys(output, ["id", "label", "node", "port"]);
    const index = value.plan.nodes.findIndex(node => node.id === output.node);
    if (!alias(output.id) || ids.has(output.id) || !label(output.label) || index < 0 || !workflowOutputs(built.nodes[index]).some(port => port.id === output.port && port.type !== "signal")) fail("模板输出无效");
    ids.add(output.id);
  }
  for (const input of value.inputs) if (!value.plan.edges.some(edge => edge.from === input.id)) fail(`输入「${input.label}」没有连接内部步骤`);
  return value;
}

/** Extract any selected subgraph. Boundary materials become required public inputs. */
export function captureWorkflowTemplate(nodes: WorkflowNode[], selected: Set<string>, name: string, boundaryBindings?: Record<string, WorkflowInput>): WorkflowTemplate {
  const cards = nodes.filter(node => selected.has(node.id));
  if (!cards.length || cards.filter(node => node.kind !== "trigger").length > 23 || cards.some(node => node.kind === "text" || node.kind === "planner")) fail("请选择 1–23 张执行卡片，可包含触发器；内容卡作为外部输入接入");
  if (cards.some(node => node.profileId)) fail("已绑定的个人视觉规范不能分享，请改成从输入提炼后保存");
  const work = cards.filter(node => node.kind !== "trigger");
  if (!work.length) fail("模板需要至少一张执行卡片");
  const aliases = new Map(work.map((node, i) => [node.id, `card${i + 1}`]));
  const inputs: TemplateInput[] = [], external = new Map<string, string>(), edges: EdgeSpec[] = [];
  const bindingAlias = (binding: WorkflowInput, type: string) => {
    if (binding.nodeId && aliases.has(binding.nodeId)) return `${aliases.get(binding.nodeId)}.${binding.portId}`;
    if (type !== "text" && type !== "image") fail("外部视觉规范需要一并选入子流程，不能保存为他人账号的引用");
    const key = `${type}:${workflowBindingKey(binding)}`;
    let id = external.get(key);
    if (!id) { id = `source${inputs.length + 1}`; external.set(key, id); inputs.push({ id, type, label: `${type === "text" ? "文本" : "图片"}输入 ${inputs.length + 1}` }); if (boundaryBindings) boundaryBindings[id] = structuredClone(binding); }
    return `${id}.${type}`;
  };
  const specs: CardSpec[] = [{ id: "start", kind: "trigger" }];
  for (const node of work) {
    const id = aliases.get(node.id)!;
    let prompt = node.prompt;
    for (const ref of activePromptReferences(node)) prompt = prompt.replaceAll(`@[${ref.id}]`, `{{${bindingAlias(ref.input, ref.type)}}}`);
    if (prompt.includes("@[")) fail("卡片存在失效引用，请先重新选择输入");
    for (const [port, bindings] of Object.entries(node.inputs)) if (port !== "signal") for (const binding of bindings) {
      const [from, output] = bindingAlias(binding, port).split(".");
      edges.push({ from, output, to: id, input: port });
    }
    if (!Object.values(node.inputs).flat().some(input => input.nodeId && aliases.has(input.nodeId))) edges.push({ from: "start", output: "signal", to: id, input: "signal" });
    specs.push({ id, kind: node.kind as CardKind, prompt, ...(node.kind === "instruction" ? { action: node.action, ...(node.action === "describe" ? { overwriteDescribe: !!node.overwriteDescribe } : {}) } : {}), ...(node.kind === "skill" ? { skill: node.skill } : {}), ...(node.kind === "generation" ? { ratio: node.ratio } : {}) });
  }
  const outputs = work.filter(node => !work.some(other => Object.values(other.inputs).flat().some(input => input.nodeId === node.id)))
    .flatMap(node => workflowOutputs(node).filter(port => port.type !== "signal").map(port => ({ id: `out${aliases.get(node.id)}_${port.id.replaceAll("-", "_")}`, label: `${workflowTitle(node)} · ${port.label}`, node: aliases.get(node.id)!, port: port.id })));
  return parseWorkflowTemplate(JSON.stringify({ format: "bowerbird-workflow-template", schemaVersion: 1, id: crypto.randomUUID(), revision: 0, name, description: "",
    plan: { summary: name, nodes: specs, edges }, inputs, parameters: [], outputs }));
}

export const templateDefinition = (node: WorkflowNode) => planningSnapshotKey({ kind: node.kind, action: node.action, skill: node.skill, prompt: node.prompt, ratio: node.ratio,
  provider: node.provider, inputs: node.inputs, promptReferences: node.promptReferences, agentTransport: node.agentTransport, profileId: node.profileId, overwriteDescribe: !!node.overwriteDescribe });

export function instantiateWorkflowTemplate(template: WorkflowTemplate, bindings: Record<string, WorkflowInput>, values: Record<string, string>, provider: string,
  existing: WorkflowNode[], x: number, y: number): WorkflowNode[] {
  template = parseWorkflowTemplate(JSON.stringify(template));
  const plan = structuredClone(template.plan);
  for (const param of template.parameters) {
    const value = values[param.id] ?? param.defaultValue;
    const node = plan.nodes.find(node => node.id === param.node)!;
    if (typeof value !== "string" || value.length > 2000) fail(`参数「${param.label}」过长`);
    if (param.field === "ratio") { if (!ratios.includes(value)) fail("画面比例无效"); node.ratio = value || null; }
    else { if (/@\[|\{\{|\}\}/.test(value)) fail("附加要求不能包含内部引用语法"); if (value.trim()) node.prompt = `${node.prompt ?? ""}\n${value}`; }
  }
  const sources: PlanningSource[] = template.inputs.map(input => {
    const binding = bindings[input.id];
    if (!binding || ![binding.assetId, binding.nodeId, binding.canvasNodeId, binding.groupId].some(Boolean)) fail(`请选择「${input.label}」`);
    if (input.type === "text" && (binding.assetId || binding.groupId)) fail(`「${input.label}」需要文本来源`);
    if (binding.nodeId && !existing.some(node => node.id === binding.nodeId && workflowOutputs(node).some(port => port.id === binding.portId && port.type === input.type))) fail(`「${input.label}」的来源已失效`);
    return { ...input, input: structuredClone(binding) };
  });
  const owner = newWorkflowNode("planner", x - 380, y, provider);
  const result = buildWorkflowPlan(JSON.stringify(executablePlan(plan)), owner, sources, existing).nodes;
  result.forEach((node, i) => { if (plan.nodes[i].overwriteDescribe !== undefined) node.overwriteDescribe = plan.nodes[i].overwriteDescribe; });
  const dx = x - Math.min(...result.map(node => node.x)); result.forEach(node => { node.x += dx; if (node.kind === "agent") node.agentTransport = "cloud"; });
  // Embedded files belong to the library, not every canvas save/run snapshot.
  const snapshot = { ...structuredClone(template), inputs: template.inputs.map(({ content: _, ...input }) => input) };
  result[0].templateInstance = { template: snapshot, nodeIds: result.map(node => node.id), bindings: structuredClone(bindings), values: structuredClone(values), definitions: result.map(templateDefinition) };
  return result;
}

export function reconfigureTemplateInstance(nodes: WorkflowNode[], rootId: string, bindings: Record<string, WorkflowInput>, values: Record<string, string>, locked: (id: string) => boolean): WorkflowNode[] {
  const root = nodes.find(node => node.id === rootId), instance = root?.templateInstance;
  if (!root || !instance) fail("子流程实例已不存在");
  const members = instance.nodeIds.map(id => nodes.find(node => node.id === id));
  if (members.some((node, i) => !node || locked(node.id) || templateDefinition(node) !== instance.definitions[i])) fail("内部步骤已编辑、删除或正在运行，请直接编辑步骤，或从模板新建实例");
  if (Object.values(bindings).some(input => input.nodeId && instance.nodeIds.includes(input.nodeId))) fail("子流程不能把自己的输出接回输入");
  const others = nodes.filter(node => !instance.nodeIds.includes(node.id));
  const fresh = instantiateWorkflowTemplate(instance.template, bindings, values, root.provider, others, root.x, root.y);
  const remap = new Map(fresh.map((node, i) => [node.id, members[i]!.id]));
  for (const [i, node] of fresh.entries()) {
    for (const key of ["sessionNodeIds", "activeSessionNodeId", "resultNodeIds", "resultGroupId"] as const) Object.assign(node, { [key]: members[i]![key] });
    node.id = members[i]!.id; node.x = members[i]!.x; node.y = members[i]!.y;
    const map = (input: WorkflowInput) => input.nodeId && remap.has(input.nodeId) ? { ...input, nodeId: remap.get(input.nodeId)! } : input;
    node.inputs = Object.fromEntries(Object.entries(node.inputs).map(([port, inputs]) => [port, inputs.map(map)]));
    node.promptReferences = node.promptReferences?.map(ref => ({ ...ref, input: map(ref.input) }));
  }
  fresh[0].templateInstance = { ...fresh[0].templateInstance!, nodeIds: fresh.map(node => node.id), definitions: fresh.map(templateDefinition) };
  let result = nodes.map(node => fresh.find(next => next.id === node.id) ?? node);
  for (const node of fresh) { assertWorkflowAcyclic(result, node.id); result = invalidateWorkflow(result, node.id); }
  return result;
}
