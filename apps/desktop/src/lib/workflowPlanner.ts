import { activePromptReferences, assertWorkflowAcyclic, newWorkflowNode, workflowBindingKey, workflowImageContainer, workflowInputs, workflowOutputs, WORKFLOW_SKILLS,
  type WorkflowInput, type WorkflowNode, type WorkflowPortType } from "./canvasWorkflow";

export interface PlanningSource { id: string; type: "text" | "image"; input: WorkflowInput; label: string; preview?: string; contentKey?: string; parentId?: string }
export interface WorkflowPlanningState {
  requestId: string;
  status: "waiting" | "applied" | "cancelled" | "failed" | "undone";
  contextKey: string;
  sources: PlanningSource[];
  summary?: string;
  error?: string;
  appliedNodes?: WorkflowNode[];
  protocolVersion?: 2;
  proposal?: { revision: number; text: string; digest: string; error?: string };
}

/** Recovery for requests stopped by the older receiver's draft-overwrite terminal state. */
export function canResumeWorkflowPlanning(state?: WorkflowPlanningState): boolean {
  return state?.status === "failed" && (!state.protocolVersion
    || (!!state.proposal && state.proposal.revision < 3 && !!state.error?.includes("同一草稿版本被改写")));
}
// Rust serde_json may reorder object keys at persistence boundaries; arrays retain semantic order.
export const planningSnapshotKey = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function samePlanningContext(saved: string, current: string): boolean {
  try { return planningSnapshotKey(JSON.parse(saved)) === planningSnapshotKey(JSON.parse(current)); }
  catch { return false; }
}
export const plannerContextKey = (node: WorkflowNode) => planningSnapshotKey([node.prompt, node.provider, node.inputs,
  ...(activePromptReferences(node).length ? [activePromptReferences(node)] : [])]);

/** Preserve the user's sentence and bind each inline mention to a scoped planning source. */
export function compilePlanningPrompt(node: WorkflowNode, sources: PlanningSource[]): string {
  return node.prompt.replace(/@\[([^\]]+)\]/g, (_token, id: string) => {
    const reference = node.promptReferences?.find(ref => ref.id === id);
    const source = reference && sources.find(source => source.type === reference.type
      && workflowBindingKey(source.input) === workflowBindingKey(reference.input));
    if (!reference || !source || (reference.assetId && !workflowImageContainer(reference.input) && reference.assetId !== source.input.assetId)) {
      throw new Error(`引用「${reference?.label ?? "未知内容"}」已断开或失效，请重新按 @ 选择输入`);
    }
    return `【${source.id}.${source.type}：${reference.label}】`;
  });
}
const kinds = ["trigger", "instruction", "agent", "generation", "skill", "visual-profile"] as const;
export const planningContract = {
  version: 2,
  scope: "只创建新工作流，不执行任务、不修改旧卡片。只使用 sources 中明确给出的来源。缺少素材时返回 error 说明，不编造来源。图片只有名字，没有像素观察；需要理解图片时安排反推卡片。",
  capabilities: kinds.filter(kind => kind !== "trigger").map(kind => {
    const node = newWorkflowNode(kind, 0, 0, "");
    return { kind, inputs: workflowInputs(node), outputs: workflowOutputs(node),
      ...(kind === "instruction" ? { actions: { describe: "图片→文本反推，可多图", reuse: "单图→原生成提示词+参考图", layers: "单图→多个图层图片" } } : {}),
      ...(kind === "skill" ? { skills: WORKFLOW_SKILLS.map(({ id, label }) => ({ id, label })) } : {}),
    };
  }),
  result: { schemaVersion: 2, summary: "生成一张海报", sourceUses: [],
    nodes: [{ id: "draw", kind: "generation", prompt: "一只猫", ratio: "1:1" }], outputs: [{ node: "draw", label: "海报" }] },
  nodes: "最多 23 张工作卡，id 为字母开头的英文数字下划线，最长32字，不能与来源别名或 workflow_start 重复。字段仅 id/kind/action/skill/prompt/ratio/inputs。不填写 trigger、edges、坐标、provider 或真实 ID；应用自动创建触发器、检查依赖并排版，编译后最多64条线。",
  inputs: "generation/agent 的 text/image 输入只由 prompt 的 {{source1.image}}、{{describe.text}} 引用推导，不要再填写 inputs.text/image。其他卡用 inputs:{image:['source1.image'],text:['rewrite.text']}。visual-profile 端口可用 inputs:{'visual-profile':['style.visual-profile']}。同一来源只声明一次，不填 signal。",
  prompts: "只有 generation/agent 使用 {{别名.端口}}；其余卡片自动读取 inputs，用普通要求。禁止 @[]。每张卡必须通往 outputs 中的最终交付，禁止没有用途的分析步骤。agent 是文本改写，需要原文引用；用户只要求填入文案时，不额外改写文案。保持产品身份；不要从共享会话旧消息借用本次未给出的名字或要求。",
  sourceUses: "每个顶层来源必须声明 {source:'source1',role:'layout'|'subject'|'copy'|'reference',mode:'each'|'shared'} 并实际用于交付。多图 layout 默认 each（逐张改图）；只有用户明确要合成或只取整体风格才 shared。each 必须用 parentId 对应的每个子来源各出一份独立交付，不可用整组替代或把多页合一。",
  outputs: "声明最终交付 [{node:'draw',label:'第1页',forSource:'source1_cell1'}]。forSource 在 each 模式必填，每个子来源恰好对应一张不同的最终卡，且 layout 必须直接接到对应 generation 的图片输入。共享产品/文案应连到每一份 each 交付的依赖路径。输出数量与来源用途会显示给用户，不能仅在 summary 宣称完成。",
  execution: "只编排，不执行。应用由数据依赖自动连接触发器。prompt 最多4000字，整个方案最多16000字；ratio 仅 generation 可用 null 或 1:1/3:4/4:3/2:3/3:2/16:9/9:16。图片只有元数据，需要读文案时安排 describe 提取原文；需要保留版式时将原图直接用于生成。缺材料/能力返回 error。",
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("编排格式应为对象");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("编排含不支持的字段");
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("编排文本为空或过长");
  return value;
}

/** Compile one declarative data-flow definition, rather than asking the model to keep two graphs in sync. */
function compilePlanSpec(plan: Record<string, unknown>, sources: PlanningSource[]) {
  keys(plan, ["schemaVersion", "summary", "sourceUses", "nodes", "outputs"]);
  if (!Array.isArray(plan.nodes) || !plan.nodes.length || plan.nodes.length > 23 || !Array.isArray(plan.sourceUses)
    || !Array.isArray(plan.outputs) || !plan.outputs.length || plan.outputs.length > 23) throw new Error("方案须声明工作卡、来源用途和最终交付");
  const nodes = plan.nodes.map(raw => {
    const spec = record(raw); keys(spec, ["id", "kind", "action", "skill", "prompt", "ratio", "inputs"]);
    if (spec.kind === "trigger" || spec.id === "workflow_start") throw new Error("触发器由应用创建，不需要声明");
    return spec;
  });
  const edges: { from: string; output: string; to: string; input: string }[] = [];
  const issues: string[] = [];
  for (const spec of nodes) {
    const to = string(spec.id, 32), inputs = spec.inputs === undefined ? {} : record(spec.inputs);
    const promptInputs = spec.kind === "generation" || spec.kind === "agent";
    const add = (token: string, input?: string) => {
      const match = /^([a-zA-Z][a-zA-Z0-9_]{0,31})\.(text|image|visual-profile)$/.exec(token);
      if (!match) { issues.push(`卡片 ${to} 的输入 ${token} 无效`); return; }
      const [, from, output] = match;
      if (!edges.some(edge => edge.from === from && edge.output === output && edge.to === to && edge.input === (input ?? output))) edges.push({ from, output, to, input: input ?? output });
    };
    for (const [port, refs] of Object.entries(inputs)) {
      if (!["text", "image", "visual-profile"].includes(port) || !Array.isArray(refs) || !refs.length) { issues.push(`卡片 ${to} 的 inputs 端口无效`); continue; }
      if (promptInputs && (port === "text" || port === "image")) { issues.push(`卡片 ${to} 的 ${port} 连线由 prompt 引用生成，请移除重复 inputs，并将这些来源明确写入 prompt 引用`); continue; }
      for (const ref of refs) add(string(ref, 64), port);
    }
    if (promptInputs && typeof spec.prompt === "string") for (const match of spec.prompt.matchAll(/\{\{([^{}]+)\}\}/g)) add(match[1]);
    if (!promptInputs && typeof spec.prompt === "string" && /\{\{|\}\}/.test(spec.prompt)) issues.push(`卡片 ${to}（${spec.kind}）的 prompt 不支持占位符；改用普通要求，来源写入 inputs`);
    if (spec.kind === "instruction" && !edges.some(edge => edge.to === to && edge.input === "image")) issues.push(`指令卡片 ${to} 缺少图片来源，请填写 inputs.image`);
  }
  const ancestors = (id: string) => {
    const found = new Set<string>([id]);
    for (const child of found) for (const edge of edges) if (edge.to === child) found.add(edge.from);
    return found;
  };
  const outputs = plan.outputs.map(raw => {
    const output = record(raw); keys(output, ["node", "label", "forSource"]);
    const node = string(output.node, 32), label = string(output.label, 200);
    if (!nodes.some(spec => spec.id === node)) throw new Error(`交付 ${label} 指向未知卡片`);
    if (output.forSource !== undefined && !sources.some(source => source.id === output.forSource)) throw new Error(`交付 ${label} 的来源无效`);
    return { node, label, forSource: output.forSource, ancestors: ancestors(node) };
  });
  if (new Set(outputs.map(output => output.node)).size !== outputs.length) throw new Error("每份交付须使用不同的输出卡片");
  for (const spec of nodes) if (!outputs.some(output => output.ancestors.has(String(spec.id)))) issues.push(`卡片 ${spec.id} 未用于任何最终交付，请移除或接入交付链路`);
  const uses = new Map<string, { role: string; mode: string }>();
  for (const raw of plan.sourceUses) {
    const use = record(raw); keys(use, ["source", "role", "mode"]);
    const source = string(use.source, 32), role = string(use.role, 20), mode = string(use.mode, 20);
    if (!sources.some(item => item.id === source && !item.parentId) || uses.has(source) || !["layout", "subject", "copy", "reference"].includes(role) || !["each", "shared"].includes(mode)) throw new Error("来源用途重复或无效");
    uses.set(source, { role, mode });
  }
  const eachOutputs = new Set<string>();
  for (const source of sources.filter(source => !source.parentId)) {
    const use = uses.get(source.id);
    if (!use) { issues.push(`请声明 ${source.id} 的用途`); continue; }
    const children = sources.filter(child => child.parentId === source.id);
    const leaves = children.length ? children : [source];
    if (use.mode === "each") {
      for (const leaf of leaves) {
        const matches = outputs.filter(output => output.forSource === leaf.id && output.ancestors.has(leaf.id));
        if (matches.length !== 1) { issues.push(`${leaf.id} 须对应一份独立交付，不能遗漏或合并多页`); continue; }
        const output = matches[0]; eachOutputs.add(output.node);
        if (use.role === "layout" && (!nodes.some(node => node.id === output.node && node.kind === "generation") || !edges.some(edge => edge.from === leaf.id && edge.to === output.node && edge.input === "image"))) issues.push(`${leaf.id} 的版式原图必须直接接到对应生成卡`);
      }
    } else if (!outputs.some(output => output.ancestors.has(source.id) || leaves.every(leaf => output.ancestors.has(leaf.id)))) issues.push(`来源 ${source.id} 未用于最终交付`);
  }
  for (const [source, use] of uses) if (use.mode === "shared" && ["subject", "copy"].includes(use.role)) {
    const leaves = sources.filter(child => child.parentId === source);
    for (const output of outputs.filter(output => eachOutputs.has(output.node))) if (!output.ancestors.has(source) && !(leaves.length && leaves.every(leaf => output.ancestors.has(leaf.id)))) issues.push(`交付 ${output.label} 缺少共享${use.role === "copy" ? "文案" : "产品"}来源 ${source}`);
  }
  if (issues.length) throw new Error([...new Set(issues)].slice(0, 20).join("\n"));
  for (const spec of nodes) if (!edges.some(edge => edge.to === spec.id && nodes.some(parent => parent.id === edge.from))) edges.push({ from: "workflow_start", output: "signal", to: String(spec.id), input: "signal" });
  const summary = string(plan.summary, 1200) + `\n交付 ${outputs.length} 份：${outputs.map(output => output.label).join("、")}。\n` + [...uses].map(([id, use]) => `${id}：${({ layout: "版式", subject: "产品/主体", copy: "文案", reference: "参考" })[use.role]}（${use.mode === "each" ? "逐份处理" : "共享参考"}）`).join("；");
  return { summary, nodes: [{ id: "workflow_start", kind: "trigger" }, ...nodes.map(({ inputs: _inputs, ...node }) => node)], edges };
}

/** Untrusted model output becomes fresh, typed cards; never deserialize a full canvas document. */
export function buildWorkflowPlan(text: string, owner: WorkflowNode, sources: PlanningSource[], existing: WorkflowNode[], obstacles: { x: number; y: number; width: number; height: number }[] = []) {
  if (text.length > 16000) throw new Error("编排方案过大");
  const rawPlan = record(JSON.parse(text));
  const plan = rawPlan.schemaVersion === 2 ? compilePlanSpec(rawPlan, sources) : rawPlan;
  keys(plan, ["summary", "nodes", "edges"]);
  const summary = string(plan.summary, 2000);
  if (!Array.isArray(plan.nodes) || plan.nodes.length < 2 || plan.nodes.length > 24 || !Array.isArray(plan.edges) || plan.edges.length > 64) throw new Error("编排须包含触发器与工作卡片，最多 24 张卡片、64 条线");
  if (existing.length + plan.nodes.length > 500) throw new Error("画板工作流卡片数量已达上限");
  const aliases = new Map<string, WorkflowNode>();
  for (const raw of plan.nodes) {
    const spec = record(raw); keys(spec, ["id", "kind", "action", "skill", "prompt", "ratio"]);
    const id = string(spec.id, 32);
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(id) || aliases.has(id) || sources.some(source => source.id === id)) throw new Error("卡片标识重复或无效");
    if (!kinds.includes(spec.kind as typeof kinds[number])) throw new Error("方案使用了不存在的卡片类型");
    const node = newWorkflowNode(spec.kind as typeof kinds[number], 0, 0, owner.provider);
    if (spec.action !== undefined) {
      if (node.kind !== "instruction" || !["describe", "reuse", "layers"].includes(String(spec.action))) throw new Error("不支持的指令功能");
      node.action = spec.action as WorkflowNode["action"];
    }
    if (spec.skill !== undefined) {
      if (node.kind !== "skill" || !WORKFLOW_SKILLS.some(skill => skill.id === spec.skill)) throw new Error("不支持的技能");
      node.skill = String(spec.skill);
    }
    if (spec.prompt !== undefined) node.prompt = typeof spec.prompt === "string" && spec.prompt.length <= 4000 ? spec.prompt : string(spec.prompt, 4000);
    if (spec.ratio !== undefined && spec.ratio !== null) {
      if (node.kind !== "generation" || !["1:1", "3:4", "4:3", "2:3", "3:2", "16:9", "9:16"].includes(String(spec.ratio))) throw new Error("不支持的画面比例");
      node.ratio = String(spec.ratio);
    }
    if (["agent", "generation", "skill"].includes(node.kind)) string(node.prompt, 4000);
    aliases.set(id, node);
  }
  const nodes = [...aliases.values()], edges = new Set<string>();
  const referenceBindings = new Map<string, Map<string, { type: "text" | "image"; input: WorkflowInput }>>();
  for (const raw of plan.edges) {
    const edge = record(raw); keys(edge, ["from", "output", "to", "input"]);
    const from = string(edge.from, 32), output = string(edge.output, 32), to = string(edge.to, 32), input = string(edge.input, 32);
    const target = aliases.get(to), upstream = aliases.get(from), source = sources.find(source => source.id === from);
    if (!target || from === to || (!upstream && !source)) throw new Error("连线指向未知卡片或来源");
    const outType = upstream ? workflowOutputs(upstream).find(port => port.id === output)?.type : source?.type === output ? source.type : undefined;
    const inType: WorkflowPortType | undefined = input === "signal" && target.kind !== "trigger" ? "signal" : workflowInputs(target).find(port => port.id === input)?.type;
    if (!outType || inType !== outType) throw new Error("连线端口类型不匹配");
    const key = JSON.stringify([from, output, to, input]);
    if (edges.has(key)) throw new Error("方案包含重复连线"); edges.add(key);
    const binding = upstream ? { nodeId: upstream.id, portId: output } : structuredClone(source!.input);
    (target.inputs[input] ??= []).push(binding);
    if (input === "text" || input === "image") {
      const bindings = referenceBindings.get(to) ?? new Map(); bindings.set(`${from}.${output}`, { type: input, input: binding }); referenceBindings.set(to, bindings);
    }
  }
  for (const [alias, node] of aliases) {
    assertWorkflowAcyclic([...existing, ...nodes], node.id);
    if (node.kind === "instruction" && !node.inputs.image?.length) throw new Error("指令卡片缺少图片来源");
    if (node.kind === "instruction" && node.action !== "describe" && node.inputs.image.length !== 1) throw new Error("复用和分层只接收一个图片来源");
    if (node.kind === "visual-profile" && !node.prompt.trim() && !node.inputs.image?.length && !node.inputs.text?.length) throw new Error("视觉规范缺少要求或来源");
    if (node.kind === "agent" && !node.inputs.text?.length) throw new Error("文本 Agent 缺少原文");
    if (node.prompt.includes("@[")) throw new Error("方案使用了内部引用标识");
    const bindings = referenceBindings.get(alias) ?? new Map(), used = new Set<string>();
    node.prompt = node.prompt.replace(/\{\{([^{}]+)\}\}/g, (_match, key: string) => {
      const binding = bindings.get(key);
      if (node.kind !== "generation" && node.kind !== "agent") throw new Error(`卡片 ${alias}（${node.kind}）的 prompt 不支持 {{${key}}}，请写普通要求；此卡自动读取连线输入`);
      if (!binding) throw new Error(`卡片 ${alias} 的引用 {{${key}}} 没有对应连线`);
      used.add(key);
      const ref = node.promptReferences?.find(ref => ref.label === key) ?? { id: crypto.randomUUID(), label: key, ...binding };
      if (!node.promptReferences?.includes(ref)) (node.promptReferences ??= []).push(ref);
      return `@[${ref.id}]`;
    });
    if (node.prompt.includes("{{") || node.prompt.includes("}}")) throw new Error("提示词引用格式无效");
    const unused = [...bindings.keys()].filter(key => !used.has(key));
    if ((node.kind === "generation" || node.kind === "agent") && unused.length) throw new Error(`卡片 ${alias} 已连接的来源未用于提示词，请补充 ${unused.map(key => `{{${key}}}`).join("、")}`);
  }
  const triggers = nodes.filter(node => node.kind === "trigger");
  if (triggers.length !== 1) throw new Error("方案必须包含一个触发器");
  const reachable = new Set([triggers[0].id]);
  for (const id of reachable) for (const node of nodes) if (Object.values(node.inputs).flat().some(input => input.nodeId === id)) reachable.add(node.id);
  if (reachable.size !== nodes.length) throw new Error("存在未接入触发器的卡片");
  // Topological columns with enough vertical room for editors; never overlap existing cards.
  const depths = new Map<string, number>();
  const depth = (node: WorkflowNode): number => {
    if (depths.has(node.id)) return depths.get(node.id)!;
    const parents = nodes.filter(parent => Object.values(node.inputs).flat().some(input => input.nodeId === parent.id));
    const value = parents.length ? Math.max(...parents.map(depth)) + 1 : 0; depths.set(node.id, value); return value;
  };
  const columns = new Map<number, number>(), x = Math.max(owner.x + 380, ...existing.map(node => node.x + 380));
  for (const node of nodes) { const column = depth(node), row = columns.get(column) ?? 0; columns.set(column, row + 1); node.x = x + column * 380; node.y = owner.y + row * 560; }
  // Native material and content cards live outside the workflow document.
  for (let pass = 0; pass <= obstacles.length; pass++) {
    const collisions = obstacles.filter(rect => nodes.some(node => node.x < rect.x + rect.width + 24 && node.x + 344 > rect.x && node.y < rect.y + rect.height + 24 && node.y + 536 > rect.y));
    if (!collisions.length) break;
    const delta = Math.max(...collisions.map(rect => rect.y + rect.height + 40)) - Math.min(...nodes.map(node => node.y));
    for (const node of nodes) node.y += delta;
  }
  return { summary, nodes };
}

export function canUndoWorkflowPlan(owner: WorkflowNode, nodes: WorkflowNode[], locked: (id: string) => boolean): boolean {
  const applied = owner.planning?.appliedNodes;
  if (!applied?.length) return false;
  const ids = new Set(applied.map(node => node.id));
  const definition = ({ x: _x, y: _y, ...node }: WorkflowNode) => JSON.stringify(node);
  return applied.every(before => { const now = nodes.find(node => node.id === before.id); return now && !locked(now.id) && definition(now) === definition(before); })
    && !nodes.some(node => !ids.has(node.id) && Object.values(node.inputs).flat().some(input => input.nodeId && ids.has(input.nodeId)));
}
