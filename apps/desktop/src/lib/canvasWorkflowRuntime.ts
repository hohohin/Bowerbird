import { api } from "./api";
import { notify } from "./notify";
import { emit } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { loadDescribePrompt } from "./describePrompt";
import { existingWorkflowCaption, workflowCaptionSections } from "./workflowDescribe";
import { canStartAnotherAgentRun, canUseAgentRun, understandProvider } from "./entitlement";
import { renderLayerDocument } from "./layerDocument";
import { workflowLayerDecompose } from "./workflowLayerDecompose";
import { readCanvasNote, emptyCanvasCell, canvasGridWeights, canvasTextMinSize } from "./canvasNotes";
import { canvasInputValue, reconcileCanvasWorkflowReferences } from "./canvasSessionOutputs";
import { canvasContentInput } from "./canvasContentInput";
import { assertWorkflowAcyclic, rebindGenerationReferences } from "./canvasWorkflow";
import { WorkflowNodeError, workflowDiagnostic, type WorkflowDiagnostic } from "./workflowDiagnostics";
import { enqueueCloudAgentRunOperation } from "./cloudAgentRuntime";
import { describeBrandImage } from "./describeBrandImage";
import { compileAgentPrompt, activePromptReferences, compileGenerationPrompt, generationInputNode, workflowImageContainer, emptyWorkflow, newWorkflowNode, invalidateWorkflow, workflowExecutionNodes, workflowDependencies, workflowWriteNodes, workflowAccessConflict, workflowLockedNodes, workflowRuns, workflowRunActive, workflowInputProducers, workflowInputValues, workflowOrder, WORKFLOW_SKILLS,
  type WorkflowInput, type WorkflowRun, type WorkflowNode, type WorkflowStep, type WorkflowValue } from "./canvasWorkflow";

const controllers = new Map<string, CanvasWorkflowController>();
export function canvasWorkflowController(projectId: string) {
  let controller = controllers.get(projectId);
  if (!controller) { controller = new CanvasWorkflowController(projectId); controllers.set(projectId, controller); }
  return controller;
}

/** Lives outside React: changing projects never redirects or repeats a provider submission. */
export class CanvasWorkflowController {
  document = emptyWorkflow();
  ready = false;
  error = "";
  issue: WorkflowDiagnostic | null = null;
  dismissIssue() { this.issue = null; this.emit(); }
  showIssue(issue: WorkflowDiagnostic) { this.issue = issue; this.emit(); }
  revision = 0;
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private executing = new Set<string>();
  private reservations = new Map<string, { access: string[]; writes: string[] }>();
  private stopped = new Set<string>();
  private stopping = new Set<string>();
  private profileAbort = new Map<string, Set<AbortController>>();
  private executionDrains = new Map<string, Promise<void>>();
  private resources = new Map<string, Promise<unknown>>();
  private async withResource<T>(key: string, work: () => Promise<T>): Promise<T> {
    const task = (this.resources.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    this.resources.set(key, task);
    try { return await task; }
    finally { if (this.resources.get(key) === task) this.resources.delete(key); }
  }
  isLocked(id: string) { return workflowLockedNodes(this.document).has(id) || [...this.reservations.values()].some(item => item.access.includes(id)); }
  private run(id: string) { return workflowRuns(this.document).find(run => run.id === id)!; }
  private saveRun(run: WorkflowRun, nodes = this.document.nodes) {
    const runs = workflowRuns(this.document);
    const updated = runs.some(item => item.id === run.id) ? runs.map(item => item.id === run.id ? run : item) : [...runs, run];
    return this.save({ ...this.document, nodes, runs: updated, run: updated[updated.length - 1] ?? null });
  }
  constructor(readonly projectId: string) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  load() {
    if (!this.loading) this.loading = (async () => {
      try {
        const snapshot = await api.canvasWorkflowGet(this.projectId);
        this.document = snapshot.document; this.revision = snapshot.revision;
        // Old dimension wires now carry the complete prompt through the single text port.
        const describes = new Set(this.document.nodes.filter(node => node.kind === "instruction" && node.action === "describe").map(node => node.id));
        const splits = new Set(this.document.nodes.filter(node => node.kind === "instruction" && node.action === "layers").map(node => node.id));
        const explicitTextTargets = new Set(this.document.nodes.flatMap(node => node.textTarget ? [node.textTarget.nodeId] : []));
        const aggregateInput = (input: WorkflowInput) => describes.has(input.nodeId ?? "") && input.portId?.startsWith("dimension-") ? { ...input, portId: "text" }
          : splits.has(input.nodeId ?? "") && input.portId?.startsWith("layer-") ? { ...input, portId: "image" } : input;
        this.document = { ...this.document, nodes: this.document.nodes.map(node => ({ ...node,
          ...(describes.has(node.id) ? { outputPorts: [], outputs: node.outputs.text ? { text: node.outputs.text } : {} } : {}),
          ...(splits.has(node.id) ? { outputPorts: [], outputs: node.outputs.image ? { image: node.outputs.image } : {} } : {}),
          ...(node.resultNodeIds ? { resultNodeIds: node.resultNodeIds.filter(id => !explicitTextTargets.has(id)) } : {}),
          ...(node.textTarget ? { textTarget: { ...node.textTarget, image: !!node.inputs.image?.length } } : {}),
          inputs: Object.fromEntries(Object.entries(node.inputs).map(([port, bindings]) => [port, bindings.map(aggregateInput)])),
          ...(node.promptReferences ? { promptReferences: node.promptReferences.map(ref => {
            const { assetId, ...reference } = ref;
            return { ...reference, ...(ref.type === "image" && workflowImageContainer(ref.input) ? {} : { assetId }), input: aggregateInput(ref.input) };
          }) } : {}),
        })) };
        // A crash is not permission to repeat a billable request. Continue only queries known jobs.
        const runs = workflowRuns(this.document);
        for (const run of runs) if (run.status === "running") {
          run.status = "waiting";
          for (const id of run.order) if (run.steps[id].status === "running") run.steps[id] = { ...run.steps[id],
            status: "waiting", error: "上次执行已中断，可继续取回已有任务；不会自动重新生成。" };
        }
        const canvas = await api.projectCanvasGet(this.projectId);
        this.document = { ...this.document, nodes: reconcileCanvasWorkflowReferences(this.document.nodes, canvas.nodes).map(rebindGenerationReferences), runs, run: runs[runs.length - 1] ?? null };
        const latest = runs[runs.length - 1];
        this.issue = latest?.status === "failed" ? Object.values(latest.steps).find(step => step.diagnostic)?.diagnostic ?? null : null;
        this.ready = true;
      } catch (error) { this.error = String(error); }
      this.emit();
    })();
    return this.loading;
  }
  async save(document = this.document) {
    this.document = document; this.emit();
    const snapshot = structuredClone(document);
    const write = this.writing.then(async () => {
      this.revision = await api.canvasWorkflowSave(this.projectId, this.revision, snapshot);
    });
    // A failed write blocks later writes and execution until explicitly retried.
    this.writing = write;
    try { await write; this.error = ""; }
    catch (error) { this.error = `工作流未保存：${String(error)}`; throw error; }
    finally { this.emit(); }
  }
  async retrySave() {
    if (!this.ready) { this.loading = null; await this.load(); return; }
    await this.writing.catch(() => {}); this.writing = Promise.resolve(); await this.save();
  }
  async edit(nodes: WorkflowNode[]) {
    if (!this.ready) throw new Error("工作流尚未载入");
    nodes = nodes.map(node => this.isLocked(node.id) ? node : rebindGenerationReferences(node));
    for (const node of this.document.nodes) if (this.isLocked(node.id) && JSON.stringify(node) !== JSON.stringify(nodes.find(next => next.id === node.id))) {
      throw new Error("此卡片关联的工作流正在运行，请先停止对应流程");
    }
    const runs = workflowRuns(this.document).filter(run => workflowRunActive(run) || run.order.every(id => nodes.some(node => node.id === id)));
    await this.save({ ...this.document, nodes, runs, run: runs[runs.length - 1] ?? null });
  }
  async syncCanvasReferences(canvas: Parameters<typeof reconcileCanvasWorkflowReferences>[1]) {
    if (!this.ready) return;
    const nodes = reconcileCanvasWorkflowReferences(this.document.nodes, canvas).map(node => this.isLocked(node.id) ? this.document.nodes.find(current => current.id === node.id)! : node);
    if (JSON.stringify(nodes) !== JSON.stringify(this.document.nodes)) await this.edit(nodes);
  }
  async bindTextInput(nodeId: string, cellId: string | undefined, source: WorkflowInput, type: "text" | "image") {
    const canvas = await api.projectCanvasGet(this.projectId);
    const target = canvas.nodes.find(node => node.id === nodeId && node.kind === "note" && node.hiddenAt == null);
    if (!target) throw new Error("文本卡片已不存在");
    const note = readCanvasNote(target);
    if (note.note_type !== "text" && note.note_type !== "images") throw new Error("请选择内容卡片");
    const previous = cellId ? this.document.nodes.find(node => node.textTarget?.nodeId === nodeId && node.textTarget.cellId === cellId) : undefined;
    if (this.document.nodes.some(node => (node.textTarget?.nodeId === nodeId || node.resultNodeIds?.includes(nodeId)) && this.isLocked(node.id))) throw new Error("关联工作流正在运行，请先停止");
    if (cellId && !note.cells.flat().some(cell => cell.id === cellId)) throw new Error("单元格已删除");
    const reuseEmptyImageCard = !cellId && type === "image" && note.cells.length === 1 && note.cells[0].length === 1
      && !note.cells[0][0].text && !note.cells[0][0].image_refs?.length
      && !this.document.nodes.some(node => node.textTarget?.nodeId === nodeId);
    const targetCellId = cellId ?? (reuseEmptyImageCard ? note.cells[0][0].id! : crypto.randomUUID());
    const writer: WorkflowNode = { ...(previous || newWorkflowNode("text", target.x, target.y, "")),
      textTarget: { ...previous?.textTarget, nodeId, cellId: targetCellId, append: !cellId || !!previous && previous.textTarget?.append, image: type === "image" }, inputs: { [type]: [source] } };
    // Once explicitly wired, this table is edited by cell writers, never rebuilt as an automatic result.
    const nodes = [...this.document.nodes.filter(node => node.id !== writer.id).map(node => ({ ...node,
      ...(node.resultNodeIds?.includes(nodeId) ? { resultNodeIds: node.resultNodeIds.filter(id => id !== nodeId) } : {}),
      ...(cellId && node.textTarget?.nodeId === nodeId && node.textTarget.cellIds?.includes(cellId)
        ? { textTarget: { ...node.textTarget, cellIds: node.textTarget.cellIds.filter(id => id !== cellId) } } : {}),
    })), writer];
    assertWorkflowAcyclic(nodes, writer.id); // Check wiring without validating or running downstream prompts.
    await this.edit(invalidateWorkflow(nodes, writer.id));
    {
      const row = note.cells[0].map((_, column) => ({ ...emptyCanvasCell(), id: column === 0 ? targetCellId : crypto.randomUUID(), content_type: column === 0 ? type : "text" as const }));
      const cells = cellId || reuseEmptyImageCard ? note.cells.map(row => row.map(cell => cell.id === targetCellId ? { ...cell, content_type: type } : cell)) : [...note.cells, row];
      await api.projectCanvasNoteUpdate(nodeId, JSON.stringify({ ...note, note_type: "text", cells, row_heights: cellId || reuseEmptyImageCard ? note.row_heights : [...canvasGridWeights(note.row_heights, note.cells.length), 1], text: cells.map(row => row.map(cell => cell.text).join("\t")).join("\n") }));
      if (type === "image" || !cellId) {
        const minimum = canvasTextMinSize(cells);
        await api.projectCanvasNodeUpdate(nodeId, { x: target.x, y: target.y, width: Math.max(target.width, minimum.width), height: Math.max(target.height, minimum.height), zIndex: target.zIndex, positionLocked: target.positionLocked });
      }
      await emit("creative://changed", { projectId: this.projectId });
    }
    // Binding an available value fills the cell immediately, without running model cards.
    if (!source.nodeId || this.document.nodes.find(node => node.id === source.nodeId)?.outputs[source.portId ?? ""]) await this.start(writer.id, true);
  }

  /** A drag places a local cell value, without retaining a dependency on its source. */
  async storeCellImages(nodeId: string, cellId: string, assetIds: string[], moveFromNodeId?: string) {
    await this.withResource("canvas", async () => {
      if (this.isLocked(nodeId) || this.document.nodes.some(node => (node.textSource === nodeId || node.textTarget?.nodeId === nodeId || node.resultNodeIds?.includes(nodeId)) && this.isLocked(node.id))) throw new Error("关联工作流正在运行，请先停止");
      const canvas = await api.projectCanvasGet(this.projectId);
      if (moveFromNodeId && !canvas.nodes.some(node => node.id === moveFromNodeId && node.kind === "asset" && node.hiddenAt == null && assetIds.includes(node.assetId ?? ""))) throw new Error("拖拽的画板图片已不存在");
      const table = canvas.nodes.find(node => node.id === nodeId && node.kind === "note" && node.hiddenAt == null);
      if (!table) throw new Error("内容卡片已删除");
      const note = readCanvasNote(table);
      if (!["text", "images"].includes(note.note_type) || !note.cells.flat().some(cell => cell.id === cellId)) throw new Error("单元格已删除");
      const assets = await api.getAssetsByIds(assetIds);
      if (assetIds.some(id => !assets.some(asset => asset.id === id && asset.store_path && !asset.duration))) throw new Error("图片已不可用，请重新选择");
      const result = canvasContentInput(note, { nodeId, cellId, image: true }, { type: "image", assetIds });
      await api.projectCanvasNoteUpdate(nodeId, JSON.stringify(result.note));
      const minimum = canvasTextMinSize(result.note.cells);
      if (table.height < minimum.height || table.width < minimum.width) await api.projectCanvasNodeUpdate(nodeId, {
        x: table.x, y: table.y, width: Math.max(table.width, minimum.width), height: Math.max(table.height, minimum.height), zIndex: table.zIndex, positionLocked: table.positionLocked,
      });
      // Remove only this canvas instance, and only after the destination is persisted.
      try {
        if (moveFromNodeId) await api.projectCanvasNodeRemove(moveFromNodeId);
      } finally {
        await emit("creative://changed", { projectId: this.projectId });
      }
    });
  }

  private writeContentInput(writer: WorkflowNode, value: WorkflowValue) {
    return this.withResource("canvas", () => this.writeContentInputUnlocked(writer, value));
  }
  private async writeContentInputUnlocked(writer: WorkflowNode, value: WorkflowValue) {
    const target = this.document.nodes.find(node => node.id === writer.id)?.textTarget ?? writer.textTarget!;
    const canvas = await api.projectCanvasGet(this.projectId);
    const table = canvas.nodes.find(node => node.id === target.nodeId && node.kind === "note" && node.hiddenAt == null);
    if (!table) throw new Error("输入的内容卡片已删除");
    const note = readCanvasNote(table);
    if (!note.cells.flat().some(cell => cell.id === target.cellId)) throw new Error("输入的单元格已删除，请重新连接");
    const result = canvasContentInput(note, target, value);
    // Save ownership before the table so a resumed run reuses the same slots.
    await this.save({ ...this.document, nodes: this.document.nodes.map(node => node.id === writer.id
      ? { ...node, textTarget: { ...target, cellIds: result.cellIds } } : node) });
    await api.projectCanvasNoteUpdate(table.id, JSON.stringify(result.note));
    const minimum = canvasTextMinSize(result.note.cells);
    if (table.height < minimum.height || table.width < minimum.width) await api.projectCanvasNodeUpdate(table.id, {
      x: table.x, y: table.y, width: Math.max(table.width, minimum.width), height: Math.max(table.height, minimum.height), zIndex: table.zIndex, positionLocked: table.positionLocked,
    });
  }

  async start(startId: string, single = false) {
    this.issue = null; this.emit();
    try { await this.startRun(startId, single); }
    catch (error) {
      const node = this.document.nodes.find(node => node.id === startId);
      if (node) { this.issue = workflowDiagnostic(error, node, "validation"); this.emit(); }
      throw error;
    }
  }
  private async startRun(startId: string, single = false) {
    if (!this.ready) throw new Error("工作流尚未载入");
    // A deleted result table may still be used as a relay by downstream cards.
    // Recover whole-output references before removing its writer/provenance.
    const snapshot = await api.projectCanvasGet(this.projectId);
    await this.syncCanvasReferences(snapshot.nodes);
    const liveTables = new Set(snapshot.nodes.filter(node => node.kind === "note" && node.hiddenAt == null).map(node => node.id));
    const recoveryScope = new Set(single ? [startId] : workflowOrder(this.document.nodes, startId));
    const forwardResult = (input: WorkflowInput): WorkflowInput => {
      if (!input.canvasNodeId || liveTables.has(input.canvasNodeId)) return input;
      const automatic = this.document.nodes.find(node => recoveryScope.has(node.id) && node.kind === "instruction" && node.action === "layers"
        && (node.resultNodeIds?.includes(input.canvasNodeId!) || input.canvasNodeId!.startsWith("workflow-layers:") && input.canvasNodeId!.endsWith(`:${node.id}`)));
      if (automatic && input.cellId === "*") return { nodeId: automatic.id, portId: "image" };
      const writers = this.document.nodes.filter(node => node.textTarget?.nodeId === input.canvasNodeId);
      if (writers.length !== 1) return input;
      const writer = writers[0], target = writer.textTarget!;
      const bindings = writer.inputs.image ?? [];
      if (bindings.length !== 1 || !this.document.nodes.some(node => recoveryScope.has(node.id) && node.id === bindings[0].nodeId && node.action === "layers")) return input;
      if (input.cellId === "*" || input.cellId === target.cellId && !target.append) return bindings[0];
      return input;
    };
    const forwarded = this.document.nodes.map(node => ({ ...node,
      inputs: Object.fromEntries(Object.entries(node.inputs).map(([port, inputs]) => [port, inputs.map(forwardResult)])),
      ...(node.promptReferences ? { promptReferences: node.promptReferences.map(ref => ({ ...ref, input: forwardResult(ref.input) })) } : {}),
    }));
    // A reusable prompt follows its connected input slot, not a deleted preview
    // container. Repair the unambiguous one-source replacement without touching
    // the prompt token. A producer counts as available even before it has a value.
    const hasSource = (input: WorkflowInput) => !input.canvasNodeId || liveTables.has(input.canvasNodeId)
      || workflowInputProducers(forwarded, input).length > 0;
    const rebound = forwarded.map(node => {
      if (node.kind !== "generation" && node.kind !== "agent") return node;
      const inputs = Object.fromEntries(Object.entries(node.inputs).map(([port, bindings]) => [port, bindings.filter(hasSource)]));
      const promptReferences = rebindGenerationReferences({ ...node, inputs }).promptReferences;
      // Keep unresolved bindings for a precise failure at this node, after its upstream runs.
      const changed = promptReferences?.some((ref, index) => ref.input !== node.promptReferences![index].input);
      return changed ? { ...node, inputs, promptReferences } : node;
    });
    if (JSON.stringify(rebound) !== JSON.stringify(this.document.nodes)) await this.edit(rebound);
    // Output writers can survive deletion of a table or an individual cell.
    // Include sibling writers covered by the table's write lock, not just direct image wires.
    const plannedOrder = single ? [startId] : workflowOrder(this.document.nodes, startId);
    const plannedWrites = new Set(workflowWriteNodes(workflowExecutionNodes(this.document.nodes, startId), plannedOrder));
    const writers = this.document.nodes.filter(node => node.id !== startId && plannedWrites.has(node.id) && node.textTarget);
    if (writers.length) {
      const canvas = await api.projectCanvasGet(this.projectId);
      const deleted = new Set(writers.filter(writer => {
        const table = canvas.nodes.find(node => node.id === writer.textTarget!.nodeId && node.kind === "note" && node.hiddenAt == null);
        return !table || !readCanvasNote(table).cells.flat().some(cell => cell.id === writer.textTarget!.cellId);
      }).map(writer => writer.id));
      if (deleted.size) await this.edit(this.document.nodes.filter(node => !deleted.has(node.id)));
    }
    const order = single ? [startId] : workflowOrder(this.document.nodes, startId);
    if (!this.document.nodes.some(node => node.id === startId)) throw new Error("卡片不存在");
    const executionNodes = workflowExecutionNodes(this.document.nodes, startId);
    const textSources = this.document.nodes.filter(node => node.textSource && order.includes(node.id)).map(node => node.textSource!);
    const lockedNodeIds = workflowDependencies(executionNodes, order);
    const writeNodeIds = workflowWriteNodes(executionNodes, order);
    const accesses = [
      ...workflowRuns(this.document).filter(workflowRunActive).map(run => ({
        access: run.lockedNodeIds ?? workflowDependencies(this.document.nodes, run.order),
        writes: run.writeNodeIds ?? workflowWriteNodes(this.document.nodes, run.order),
      })), ...this.reservations.values(),
    ];
    if (accesses.some(item => workflowAccessConflict(lockedNodeIds, writeNodeIds, item.access, item.writes))) throw new Error("此运行会修改其他工作流正在使用的卡片，请等待对应流程完成");
    const runId = crypto.randomUUID(), threadId = crypto.randomUUID();
    this.reservations.set(runId, { access: lockedNodeIds, writes: writeNodeIds }); this.emit();
    try {
    await this.writing;
    // Validate configuration and snapshot fixed inputs; cell values are checked by their consumers.
    for (const textSource of textSources) {
      const canvas = await api.projectCanvasGet(this.projectId);
      if (!canvas.nodes.some(node => node.id === textSource && node.kind === "note" && node.hiddenAt == null && ["text", "images"].includes(readCanvasNote(node).note_type))) throw new Error("起点内容卡片已删除");
    }
    const textTargets = this.document.nodes.filter(node => writeNodeIds.includes(node.id) && node.textTarget);
    if (textTargets.length) {
      const canvas = await api.projectCanvasGet(this.projectId);
      for (const writer of textTargets) {
        const table = canvas.nodes.find(node => node.id === writer.textTarget?.nodeId && node.kind === "note" && node.hiddenAt == null);
        if (!table || !readCanvasNote(table).cells.flat().some(cell => cell.id === writer.textTarget?.cellId)) throw new Error("接收产物的内容卡片或单元格已删除，请重新连接输出");
      }
    }
    for (const id of order) {
      const node = this.document.nodes.find(node => node.id === id)!;
      if (node.kind === "trigger") {
        if (!this.document.nodes.some(node => (node.inputs.signal ?? []).some(input => input.nodeId === startId))) throw new WorkflowNodeError("触发器还没有连接下游卡片，请从「触发」端口连接", node);
        continue;
      }
      if (node.kind === "generation" && !node.prompt.trim()) throw new WorkflowNodeError("请在生成卡片文本框中填写指令，或通过 @ 引入内容", node);
      if (node.kind === "agent" && !node.prompt.trim()) throw new WorkflowNodeError("请连接待修改的原文，并在 Agent 卡片中填写修改要求", node);
      if (node.kind === "agent" && !activePromptReferences(node).length) throw new WorkflowNodeError("请在 Agent 卡片中按 @ 引入要处理的文本；仅连接输入不会自动注入", node);
      if (node.kind === "agent" && node.prompt.length > 4000) throw new WorkflowNodeError("Agent 修改要求不能超过 4000 字", node);
      if (node.kind === "instruction" && !(node.inputs.image?.length)) throw new WorkflowNodeError("请先连接指令卡片的图片输入", node);
      if (node.kind === "visual-profile") {
        if (!node.profileId && !node.prompt.trim() && !node.inputs.text?.length && !node.inputs.image?.length) throw new WorkflowNodeError("请给视觉规范卡片连接图片、填写文字，或选用已有规范", node);
      } else if (node.kind !== "instruction" && node.kind !== "text" && !node.prompt.trim() && !node.inputs.text?.length) throw new WorkflowNodeError("请先填写指令或连接文本输入", node);
    }
    const instanceBindings = this.document.nodes.map(generationInputNode).filter(node => order.includes(node.id)).flatMap(node => Object.values(node.inputs).flat()).filter(input => input.assetNodeId);
    if (instanceBindings.length) {
      const canvas = await api.projectCanvasGet(this.projectId);
      if (instanceBindings.some(input => !canvas.nodes.some(node => node.id === input.assetNodeId && node.kind === "asset" && node.assetId === input.assetId && node.hiddenAt == null))) {
        throw new Error("连接的画板图片实例已移除，请重新连接");
      }
    }
    const cellBindings = this.document.nodes.map(generationInputNode).filter(node => order.includes(node.id)).flatMap(node => Object.values(node.inputs).flat()).filter(input => input.canvasNodeId);
    const groupIds = [...new Set(this.document.nodes.map(generationInputNode).filter(node => order.includes(node.id)).flatMap(node => Object.values(node.inputs).flat()).flatMap(input => input.groupId ? [input.groupId] : []))];
    const groupAssets = new Map<string, string[]>();
    if (groupIds.length) {
      const canvas = await api.projectCanvasGet(this.projectId);
      for (const groupId of groupIds) {
        if (!canvas.groups.some(group => group.id === groupId)) throw new Error("连接的文件夹已删除，请重新连接");
        const ids = [...new Set(canvas.groupItems.filter(item => item.groupId === groupId).sort((a, b) => a.ordinal - b.ordinal).flatMap(item => {
          const member = canvas.nodes.find(node => node.id === item.nodeId && node.kind === "asset" && node.hiddenAt == null);
          return member?.assetId ? [member.assetId] : [];
        }))];
        const assets = await api.getAssetsByIds(ids);
        const images = ids.filter(id => assets.some(asset => asset.id === id && !asset.duration && asset.store_path));
        if (!images.length) throw new Error("文件夹中没有可用图片，请添加图片后重新运行");
        groupAssets.set(groupId, images);
      }
    }
    const cellTexts: Record<string, string> = {};
    const cellValues: Record<string, WorkflowValue> = {};
    if (cellBindings.length) {
      const canvas = await api.projectCanvasGet(this.projectId);
      for (const input of cellBindings) {
        if (!textSources.includes(input.canvasNodeId!) && workflowInputProducers(this.document.nodes, input).some(id => order.includes(id))) continue;
        const source = canvas.nodes.find(node => node.id === input.canvasNodeId && node.hiddenAt == null);
        const value = source && canvasInputValue(source, input.cellId ?? "", canvas.nodes);
        // Missing content is a consumer error, never a reason to block upstream work.
        if (!value) continue;
        cellTexts[JSON.stringify([input.canvasNodeId, input.cellId])] = value.type === "text" ? value.text : "";
        cellValues[JSON.stringify([input.canvasNodeId, input.cellId])] = value;
      }
    }
    await api.projectThreadCreate({ id: threadId, projectId: this.projectId, title: "工作流", origin: "direct" });
    const invalidated = new Set(invalidateWorkflow(executionNodes, startId).filter(node => !Object.keys(node.outputs).length).map(node => node.id));
    const nodes = this.document.nodes.map(node => invalidated.has(node.id) ? { ...node, outputs: {} } : node).map(node => this.isLocked(node.id) && !writeNodeIds.includes(node.id) ? this.document.nodes.find(item => item.id === node.id)! : order.includes(node.id) ? {
      ...node, ...(node.kind === "generation" ? { activeSessionNodeId: null } : {}), inputs: Object.fromEntries(Object.entries(node.inputs).map(([port, bindings]) => [port, bindings.map(input => input.groupId && groupAssets.has(input.groupId) ? { ...input, assetIds: groupAssets.get(input.groupId)! } : input)])),
    } : node);
    await this.saveRun({ id: runId, startId, threadId, order, lockedNodeIds, writeNodeIds, cellTexts, cellValues, status: "running",
      accountId: useStore.getState().cloudAuth?.user_id ?? null,
      steps: Object.fromEntries(order.map(id => [id, { status: "pending" as const }])) }, nodes);
    } finally { this.reservations.delete(runId); this.emit(); }
    await this.continue(runId);
  }
  async stop(runId = this.document.run?.id) {
    if (!runId) return;
    if (this.stopping.has(runId)) return;
    this.stopping.add(runId);
    try {
    this.stopped.add(runId);
    for (const abort of this.profileAbort.get(runId) ?? []) abort.abort();
    const run = this.run(runId);
    if (!run) return;
    const active = Object.values(run.steps).filter(step => step.status === "running" || step.status === "waiting");
    // Keep the definition locked until cancellation requests have completed.
    await Promise.all(active.map(async step => {
      if (step.jobId) await api.cancelCodexCreate(step.jobId);
      if (step.agentRunId) await api.cloudAgentCancel(step.agentRunId);
      if (step.describeJobIds) await Promise.all(step.describeJobIds.map(jobId => api.cancelCodexDescribe(jobId)));
      if (step.assetId && !step.agentRunId && !step.jobId) {
        const node = this.document.nodes.find(node => run.steps[node.id] === step);
        if (node?.action === "describe" && !step.describeJobIds) await useStore.getState().cancelDescribe(step.assetId);
      }
    }));
    await this.executionDrains.get(runId);
    await this.saveRun({ ...this.run(runId), status: "stopped" });
    } finally { this.stopping.delete(runId); }
  }
  private async step(runId: string, id: string, patch: Partial<WorkflowStep>) {
    if (this.stopped.has(runId)) throw new Error("工作流已停止");
    const run = this.run(runId);
    await this.saveRun({ ...run, steps: { ...run.steps, [id]: { ...run.steps[id], ...patch } } });
    if (this.stopped.has(runId)) throw new Error("工作流已停止");
  }
  private progress(runId: string, id: string, detail: string) {
    if (this.stopped.has(runId)) return;
    const run = this.run(runId);
    const updated = { ...run, steps: { ...run.steps, [id]: { ...run.steps[id], detail } } };
    const runs = workflowRuns(this.document).map(item => item.id === runId ? updated : item);
    this.document = { ...this.document, runs, run: runs[runs.length - 1] ?? null }; this.emit();
  }
  private async finish(runId: string, node: WorkflowNode, outputs: Record<string, WorkflowValue>, ports = node.outputPorts) {
    if (this.stopped.has(runId)) return;
    const run = this.run(runId);
    await this.saveRun({ ...run, steps: { ...run.steps, [node.id]: { ...run.steps[node.id], status: "done", error: undefined } } },
      this.document.nodes.map(candidate => candidate.id === node.id ? { ...candidate, outputs, outputPorts: ports } : candidate));
  }

  private async localDsText(runId: string, node: WorkflowNode, step: WorkflowStep, instruction: string, source: string, halted: () => boolean): Promise<WorkflowValue | null> {
    let requestId = step.localDsRequestId;
    if (!requestId) {
      if (step.status !== "pending") throw new Error("本机 Agent DS 提交状态未知，请先检查投递队列");
      requestId = `${Date.now()}-${crypto.randomUUID()}`;
      await this.step(runId, node.id, { status: "running", localDsRequestId: requestId, detail: "正在投递到本机 Agent DS" });
      const delivery = await api.agentDsWorkflowStart(requestId, instruction, source);
      if (halted()) return null;
      const notice = delivery.autoDelivered ? `已送达 DSH 会话「${delivery.sessionTitle || "未命名"}」，等待改写结果` : `已投递到 DSH 队列（未自动送达：${delivery.notice || "未知原因"}）；可在 DSH 里说「看队列」`;
      notify(notice, delivery.autoDelivered ? "success" : "info");
      await this.step(runId, node.id, { detail: notice, ...(delivery.autoDelivered ? {} : { status: "waiting", error: notice }) });
      if (!delivery.autoDelivered) return null;
    }
    while (!halted()) {
      const result = await api.agentDsWorkflowResult(requestId);
      if (halted()) return null;
      if (result) {
        if (result.schemaVersion !== 1 || result.requestId !== requestId) throw new Error("Agent DS 返回了其他请求的结果");
        if (result.error) throw new Error(`Agent DS 改写失败：${result.error}（请求 ${requestId}）`);
        if (!result.text?.trim() || result.text.length > 16000) throw new Error("Agent DS 未返回有效的完整改写文本");
        return { type: "text", text: result.text };
      }
      // After a reload or failed delivery, Continue only checks the existing request.
      if (step.status === "waiting") {
        await this.step(runId, node.id, { status: "waiting", error: "Agent DS 尚未写回结果；请在 DSH 会话处理队列后继续", detail: `等待本机请求 ${requestId}` });
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return null;
  }

  async continue(runId = this.document.run?.id) {
    if (!runId || this.executing.has(runId) || this.stopping.has(runId) || !this.run(runId) || !workflowRunActive(this.run(runId))) return;
    this.executing.add(runId); this.stopped.delete(runId);
    let currentId = "";
    let drained!: () => void;
    this.executionDrains.set(runId, new Promise<void>(resolve => { drained = resolve; }));
    const failures = new Map<string, unknown>();
    const halted = () => this.stopped.has(runId) || failures.size > 0;
    const active = new Map<string, Promise<void>>();
    const attempted = new Set<string>();
    const execute = async (id: string) => {
      const accountId = this.run(runId).accountId;
      if (accountId !== undefined && accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后继续，或停止此工作流");
      const node = this.document.nodes.find(node => node.id === id)!;
      const step = this.run(runId).steps[id];
      if (step.status === "done" || halted()) return;
      this.progress(runId, id, node.kind === "generation" ? "生成图片，等待会话结果" : node.kind === "skill" ? "执行技能，等待任务结果或审批" : node.kind === "visual-profile" ? "处理视觉规范" : node.kind === "trigger" ? "触发下游流程" : "读取输入素材");
      const hasCells = Object.values(node.inputs).flat().some(input => input.canvasNodeId);
      const cellTexts = this.run(runId).cellTexts;
      const canvas = hasCells ? await api.projectCanvasGet(this.projectId) : null;
      const values = workflowInputValues(this.document.nodes, generationInputNode(node), (nodeId, cellId) => {
        const frozenSource = this.document.nodes.some(node => node.textSource === nodeId && this.run(runId).order.includes(node.id));
        const producedThisRun = !frozenSource && workflowInputProducers(this.document.nodes, { canvasNodeId: nodeId, cellId }).some(id => this.run(runId).order.includes(id));
        const frozen = this.run(runId).cellValues?.[JSON.stringify([nodeId, cellId])] ?? cellTexts?.[JSON.stringify([nodeId, cellId])];
        if (cellTexts && !producedThisRun && frozen !== undefined) return frozen;
        const source = canvas?.nodes.find(candidate => candidate.id === nodeId && candidate.hiddenAt == null);
        return source ? canvasInputValue(source, cellId, canvas!.nodes) : undefined;
      });
      const generated = node.kind === "generation" ? compileGenerationPrompt(node, values) : null;
      const assetIds = generated?.assetIds ?? [...new Set([...(values.image ?? []), ...(values.text ?? [])].flatMap(value => value.assetIds ?? []))];
      const assets = await api.getAssetsByIds(assetIds);
      if (assets.length !== assetIds.length || assets.some(asset => !asset.store_path || asset.duration)) throw new Error("输入图片已丢失或不是静态图片，请重新选择");
      const orderedAssets = assetIds.map(id => assets.find(asset => asset.id === id)!);
      const prompt = generated?.prompt ?? [...(values.text ?? []).map(value => value.text?.replace(/@图片\d+/g, token => {
        const ref = value.imageRefs?.find(ref => ref.token === token);
        const index = ref ? assetIds.indexOf(ref.asset_id) : -1;
        return index < 0 ? token : `@图片${index + 1}`;
      })), node.prompt].filter(Boolean).join("\n\n").trim();
      const visualProfileId = values["visual-profile"]?.[0]?.profileId ?? null;
      if (visualProfileId) {
        const profile = await api.visualProfileGet(visualProfileId);
        if (profile.status !== "confirmed" || profile.version !== values["visual-profile"][0].version) throw new Error("连接的视觉规范已删除或版本不匹配，请重新选择");
      }
      if (node.kind === "trigger" || node.textSource) {
        await this.finish(runId, node, {});
      } else if (node.kind === "text") {
        const textValue = values.text?.[0];
        const value: WorkflowValue = textValue ?? { type: "image", assetIds };
        await this.step(runId, id, { status: "running", detail: textValue ? "写入文本单元格" : "写入图片单元格" });
        await this.writeContentInput(node, value);
        await this.finish(runId, node, { [value.type]: value });
        await emit("creative://changed", { projectId: this.projectId });
      } else if (node.kind === "visual-profile") {
        const inputKey = JSON.stringify({ assets: assetIds.slice().sort(), prompt });
        let profileId = node.profileId || step.profileId || (node.profileCache?.inputKey === inputKey ? node.profileCache.profileId : undefined);
        if (!profileId) {
          if (step.status !== "pending") throw new Error("上次提炼状态未知，请检查已有规范后选择版本，或停止后重新提炼");
          if (prompt.length > 4000) throw new Error("视觉要求不能超过 4000 字");
          const missing = await api.visualProfileInputPreview(assetIds, prompt);
          if (this.stopped.has(runId)) return;
          await this.step(runId, id, { status: "running" });
          const abort = new AbortController();
          const aborts = this.profileAbort.get(runId) ?? new Set<AbortController>();
          aborts.add(abort); this.profileAbort.set(runId, aborts);
          for (const assetId of missing) {
            if (this.stopped.has(runId)) return;
            if (this.run(runId).accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请停止后重试");
            await describeBrandImage(assetId, abort.signal);
          }
          if (this.stopped.has(runId)) return;
          if (this.run(runId).accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请停止后重试");
          const profile = await api.visualProfileExtractInputs(`${this.projectId}:${node.id}`, node.profileName?.trim() || "画板视觉规范", assetIds, prompt);
          if (this.stopped.has(runId)) return;
          profileId = profile.id;
          await this.save({ ...this.document, nodes: this.document.nodes.map(n => n.id === id ? { ...n, profileCache: { inputKey, profileId: profile.id } } : n) });
          if (this.stopped.has(runId)) return;
        }
        const profile = await api.visualProfileGet(profileId);
        if (profile.status === "archived") throw new Error("此视觉规范已删除，请停止后选择其他版本");
        if (profile.status !== "confirmed") {
          await this.step(runId, id, { status: "waiting", profileId, error: "请查看并保存规范，再继续下游" });
          if (useStore.getState().activeProjectId === this.projectId) useStore.getState().openVisualProfile({ id: profile.folderId, name: profile.name, profileId });
          return;
        }
        await this.finish(runId, node, { "visual-profile": { type: "visual-profile", profileId, version: profile.version, summary: profile.summary } });
      } else if (node.kind === "instruction" && node.action === "reuse") {
        const history = await api.generationHistory(assetIds[0], null);
        // Use the compiled prompt so dimension chips cannot leak unresolved tokens downstream.
        const text = history.turns[0]?.prompt;
        if (!text) throw new Error("这张图片没有可复用的生成提示词");
        await this.finish(runId, node, { text: { type: "text", text }, image: { type: "image", assetIds: history.references.map(asset => asset.id) } });
      } else if (node.kind === "instruction" && node.action === "describe") {
        if (step.status !== "pending") throw new Error("上次反推的结果未知。请检查该图反推记录，停止流程后显式重试。");
        const state = useStore.getState();
        const cached = await Promise.all(assetIds.map(assetId => node.overwriteDescribe ? Promise.resolve([]) : existingWorkflowCaption(assetId)));
        if (this.stopped.has(runId)) return;
        const provider = state.defaultUnderstandProvider === "auto" ? understandProvider(state.cloudEntitlement) : state.defaultUnderstandProvider;
        if (!provider && cached.some(parts => !parts.length)) throw new Error("当前没有可用的反推引擎");
        const sections: Array<{ title: string; body: string }> = [];
        const rows: Array<{ assetId: string; name: string; prompt: string }> = [];
        const jobs = assetIds.map((_, index) => cached[index].length ? null : `workflow-describe-${crypto.randomUUID()}`);
        const describeJobIds = jobs.filter((job): job is string => !!job);
        const reused = cached.filter(parts => parts.length).length;
        await this.step(runId, id, { status: "running", describeJobIds, detail: `复用 ${reused} 张 · 反推 ${describeJobIds.length} 张` });
        let completed = 0, failed = false;
        let firstError: unknown;
        const pending = new Set(describeJobIds);
        // Settle all started requests before unlocking the card; an error cancels only this batch.
        const results = await Promise.allSettled(assetIds.map(async (assetId, index) => {
          try {
            if (cached[index].length) return cached[index];
            const analysisId = await api.describeAsset(assetId, node.prompt.trim() || loadDescribePrompt(), provider!, jobs[index]!);
            const analysis = (await api.listAnalysesByAsset(assetId)).find(item => item.id === analysisId);
            const parts = analysis ? workflowCaptionSections(analysis.payload) : [];
            if (!parts?.length) throw new Error(`第 ${index + 1} 张图片反推未返回可用维度`);
            completed++;
            if (!failed) this.progress(runId, id, `复用 ${reused} 张 · 并行反推 ${describeJobIds.length} 张 · 已完成 ${completed}/${describeJobIds.length}`);
            return parts;
          } catch (error) {
            if (!failed) {
              failed = true; firstError = error;
              this.progress(runId, id, `反推失败，正在停止本批次剩余任务`);
              await Promise.allSettled([...pending].filter(jobId => jobId !== jobs[index]).map(jobId => api.cancelCodexDescribe(jobId)));
            }
            throw error;
          } finally { if (jobs[index]) pending.delete(jobs[index]!); }
        }));
        if (this.stopped.has(runId)) return;
        if (failed) throw firstError;
        for (const [index, assetId] of assetIds.entries()) {
          const result = results[index];
          if (result.status !== "fulfilled") throw result.reason;
          const parts = result.value;
          rows.push({ assetId, name: orderedAssets[index].name, prompt: parts.map(part => `${part.title}：${part.body}`).join("\n\n") });
          for (const part of parts) {
            const body = assetIds.length > 1 ? `图片 ${index + 1}：${part.body}` : part.body;
            const existing = sections.find(section => section.title === part.title);
            if (existing) existing.body += `\n\n${body}`; else sections.push({ title: part.title, body });
          }
        }
        const promptText = sections.map(section => `${section.title}：${section.body}`).join("\n\n");
        await this.withResource("canvas", async () => {
          if (halted()) return;
          this.progress(runId, id, `已反推 ${rows.length} 张图片，正在生成素材 / 提示词表格`);
          const tableId = `workflow-describe:${runId}:${id}`;
          const cell = (text: string, key: string, bold = false) => ({ id: key, text, bold, italic: false, align: "left" });
          const cells = [[cell("素材", "heading-asset", true), cell("提示词", "heading-prompt", true)],
            ...rows.map(row => [{ ...cell("@图片1", `${row.assetId}-asset`), content_type: "image", image_refs: [{ asset_id: row.assetId, token: "@图片1" }] }, cell(row.prompt, `${row.assetId}-prompt`)])];
          const canvas = await api.projectCanvasGet(this.projectId);
          const writers = this.document.nodes.filter(candidate => candidate.textTarget && candidate.inputs.text?.some(input => input.nodeId === id && input.portId === "text"));
          // Explicit whole-card/cell bindings keep the text card's existing structure and cell identity.
          for (const tableId of new Set(writers.map(writer => writer.textTarget!.nodeId))) {
            const table = canvas.nodes.find(item => item.id === tableId && item.kind === "note" && item.hiddenAt == null);
            if (!table) throw new Error("连接的文本卡片已删除，请重新连接");
            const previous = readCanvasNote(table);
            const targets = writers.filter(writer => writer.textTarget!.nodeId === tableId).map(writer => writer.textTarget!.cellId);
            if (targets.some(target => !previous.cells.flat().some(cell => cell.id === target))) throw new Error("连接的文本单元格已删除，请重新连接");
            const updatedCells = previous.cells.map(row => row.map(cell => targets.includes(cell.id ?? "") ? { ...cell, content_type: "text", text: promptText, image_refs: [] } : cell));
            await api.projectCanvasNoteUpdate(tableId, JSON.stringify({ ...previous, cells: updatedCells, text: updatedCells.map(row => row.map(cell => cell.text).join("\t")).join("\n") }));
          }
          const x = node.x + 420, width = 640, height = 40 + 100 * cells.length;
          let y = node.y;
          const obstacles = [...canvas.nodes.filter(item => item.hiddenAt == null && item.id !== tableId),
            ...this.document.nodes.map(item => ({ ...item, width: 320, height: 400 }))];
          while (obstacles.some(item => x < item.x + item.width + 24 && x + width + 24 > item.x && y < item.y + item.height + 24 && y + height + 24 > item.y)) y += height + 40;
          const previousTables = canvas.nodes.filter(item => node.resultNodeIds?.includes(item.id) && item.kind === "note" && item.hiddenAt == null);
          const payload = { schema_version: 1, note_type: "text", title: `反推结果 · ${rows.length} 张素材`, cells, text: cells.map(row => row.map(item => item.text).join("\t")).join("\n"), member_ids: [], column_widths: [1, 3], row_heights: [0.45, ...rows.map(() => 1)] };
          if (previousTables.length) {
            for (const table of previousTables) {
              const previous = readCanvasNote(table);
              const updatedCells = cells.map((row, r) => row.map((cell, c) => ({ ...cell, id: previous.cells[r]?.[c]?.id ?? cell.id })));
              await api.projectCanvasNoteUpdate(table.id, JSON.stringify({ ...payload, cells: updatedCells }));
            }
          } else if (!writers.length) {
            await api.projectCanvasNodeCreate({ id: tableId, projectId: this.projectId, threadId: this.run(runId).threadId, kind: "note", assetId: null, role: null,
              payloadJson: JSON.stringify(payload), x, y, width, height, zIndex: Math.max(0, ...canvas.nodes.map(item => item.zIndex)) + 1, positionLocked: true });
            await this.save({ ...this.document, nodes: this.document.nodes.map(item => item.id === id ? { ...item, resultNodeIds: [tableId] } : item) });
          }
          await emit("creative://changed", { projectId: this.projectId, threadId: this.run(runId).threadId, jobId: runId, turnKey: tableId, status: "done" });
        });
        if (halted()) return;
        await this.finish(runId, node, { text: { type: "text", text: promptText } }, []);
      } else if (node.kind === "instruction" && node.action === "layers") {
        await this.withResource(`layer:${assetIds[0]}`, async () => {
          if (halted()) return;
          const key = step.layerRequestKey ?? `layers-${crypto.randomUUID()}`;
          const create = step.status === "pending" && !step.layerRequestKey;
          if (!create && !step.layerRequestKey) throw new Error("原分层步骤没有拆分任务，请重新运行卡片");
          await this.step(runId, id, { status: "running", assetId: assetIds[0], layerRequestKey: key });
          const document = await workflowLayerDecompose(assetIds[0], orderedAssets[0].store_path!, "", key, create, halted,
            detail => this.progress(runId, id, detail));
          if (halted()) return;
          const productIds: string[] = [];
          for (const [index, layer] of document.layers.entries()) {
            if (this.stopped.has(runId)) return;
            this.progress(runId, id, `导出第 ${index + 1}/${document.layers.length} 层：${layer.name}`);
            const doc = { ...document, layers: document.layers.map(item => ({ ...item, visible: item.id === layer.id })) };
            const image = await api.layerExport(assetIds[0], doc, await renderLayerDocument(doc), this.projectId, true);
            productIds.push(image.id);
          }
          if (this.stopped.has(runId)) return;
          const products = [...new Set(productIds)];
          await this.withResource("canvas", async () => {
            if (halted()) return;
            const canvas = await api.projectCanvasGet(this.projectId);
            const writers = this.document.nodes.filter(candidate => candidate.textTarget?.image && candidate.inputs.image?.some(input => input.nodeId === id && input.portId === "image"));
            // Fill explicit targets even for a single-card run, preserving all other cells.
            for (const writer of writers) {
              if (this.stopped.has(runId)) return;
              await this.writeContentInputUnlocked(writer, { type: "image", assetIds: products });
            }
            let resultId: string | undefined;
            if (!writers.length) {
              const previousTable = canvas.nodes.find(item => node.resultNodeIds?.includes(item.id) && item.kind === "note" && item.hiddenAt == null);
              resultId = previousTable?.id ?? `workflow-layers:${runId}:${id}`;
              const previous = previousTable && readCanvasNote(previousTable);
              const cells = previous?.cells ?? [[{ ...emptyCanvasCell(), id: crypto.randomUUID() }]];
              const slots = cells.flat().filter(cell => cell.content_type === "image").map(cell => cell.id!);
              const payload = canvasContentInput({ ...previous, schema_version: 1, note_type: "text", title: previous?.title ?? "拆分产物", cells, text: "", member_ids: [] },
                { nodeId: resultId, cellId: cells[0][0].id!, append: true, ...(slots.length > 1 ? { cellIds: slots } : {}) }, { type: "image", assetIds: products }).note;
              const minimum = canvasTextMinSize(payload.cells);
              if (this.stopped.has(runId)) return;
              if (previousTable) {
                await api.projectCanvasNoteUpdate(resultId, JSON.stringify(payload));
                if (previousTable.width < minimum.width || previousTable.height < minimum.height) await api.projectCanvasNodeUpdate(resultId, {
                  x: previousTable.x, y: previousTable.y, width: Math.max(previousTable.width, minimum.width), height: Math.max(previousTable.height, minimum.height), zIndex: previousTable.zIndex, positionLocked: previousTable.positionLocked,
                });
              }
              else {
                const x = node.x + 420, width = Math.max(440, minimum.width), height = Math.max(260, minimum.height);
                let y = node.y;
                const obstacles = [...canvas.nodes.filter(item => item.hiddenAt == null), ...canvas.groups, ...this.document.nodes.map(item => ({ ...item, width: 320, height: 400 }))];
                while (obstacles.some(item => x < item.x + item.width + 24 && x + width + 24 > item.x && y < item.y + item.height + 24 && y + height + 24 > item.y)) y += height + 40;
                await api.projectCanvasNodeCreate({ id: resultId, projectId: this.projectId, threadId: this.run(runId).threadId, kind: "note", assetId: null, role: null,
                  payloadJson: JSON.stringify(payload), x, y, width, height, zIndex: Math.max(0, ...canvas.nodes.map(item => item.zIndex)) + 1, positionLocked: true });
              }
            }
            if (this.stopped.has(runId)) return;
            await this.save({ ...this.document, nodes: this.document.nodes.map(item => item.id === id ? { ...item, resultNodeIds: resultId ? [resultId] : [], resultGroupId: undefined } : item) });
            const reveal = !this.document.nodes.some(item => Object.values(item.inputs).flat().some(input => workflowInputProducers(this.document.nodes, input).includes(id)));
            await emit("creative://changed", { projectId: this.projectId, threadId: this.run(runId).threadId, jobId: runId, turnKey: resultId ?? id, status: "done", ...(reveal && resultId ? { revealProductNodeId: resultId } : {}) });
          });
          if (halted()) return;
          await this.finish(runId, node, { image: { type: "image", assetIds: products } }, []);
        });
      } else if (node.kind === "agent") {
        const { source, prompt: agentPrompt } = compileAgentPrompt(node, values);
        if (!source.trim() || source.length > 16000) throw new WorkflowNodeError("Agent 原文必须为 1–16000 字，请检查上游文本输出", node);
        if (!node.prompt.trim() || node.prompt.length > 4000) throw new WorkflowNodeError("Agent 修改要求必须为 1–4000 字", node);
        let value: WorkflowValue;
        if (step.localDsRequestId || (!step.agentRunId && import.meta.env.DEV && node.agentTransport !== "cloud")) {
          const result = await this.localDsText(runId, node, step, agentPrompt, source, halted);
          if (!result) return;
          value = result;
        } else {
        let agentRunId = step.agentRunId;
        if (!agentRunId) {
          if (step.status !== "pending") throw new Error("文本改写提交状态未知，请检查 Agent 任务记录；不会自动重复提交");
          const account = useStore.getState();
          if (!account.cloudAuth?.logged_in || !account.cloudEntitlement?.is_test_account || account.cloudEntitlement.user_id !== account.cloudAuth.user_id ||
              !canUseAgentRun(account.cloudEntitlement, "bowerbird-unified-agent")) throw new Error("当前账号尚未开放 Cloud DSH，请使用已获授权的测试账号");
          const active = Object.values(account.cloudAgentRuns).filter(run => !["succeeded", "failed", "cancelled"].includes(run.status)).length;
          if (!canStartAnotherAgentRun(account.cloudEntitlement, active, "bowerbird-unified-agent")) throw new Error("Agent 并发已满，请等待当前任务结束");
          await this.step(runId, id, { status: "running", detail: "提交文本改写" });
          const created = await api.cloudAgentStart({ intentPrompt: agentPrompt, textRewrite: { source }, references: [],
            projectId: this.projectId, threadId: this.run(runId).threadId, imageProvider: "cloud", skillId: "bowerbird-unified-agent", agentRuntime: "dsh" });
          if (this.stopped.has(runId)) { await api.cloudAgentCancel(created.runId); return; }
          agentRunId = created.runId;
          await this.step(runId, id, { status: "running", agentRunId, detail: "Cloud DSH 正在修改文本" });
        }
        let result;
        while (!this.stopped.has(runId)) {
          const current = await api.cloudAgentGet(agentRunId);
          useStore.getState().openCloudAgentRun(current, { navigate: false });
          if (["failed", "cancelled"].includes(current.status)) {
            const code = current.snapshot.run.error_code;
            const message = code === "unified_agent_text_result_invalid" ? "模型没有返回有效的完整改写文本" : code === "unified_agent_input_invalid" ? "云端未识别文本改写输入，请检查 Worker 版本" : current.snapshot.run.safe_message || "文本改写未完成";
            throw new Error(`${message}（Cloud DSH 任务 ${agentRunId}${code ? `，${code}` : ""}）`);
          }
          if (current.status === "succeeded") { result = current; break; }
          if (current.status.startsWith("awaiting_")) throw new Error("云端未按文本改写模式执行，请检查 Cloud DSH 服务版本");
          this.progress(runId, id, current.status === "queued" ? "Cloud DSH 文本改写排队中" : "Cloud DSH 正在修改文本");
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        if (this.stopped.has(runId) || !result) return;
        const payload = result.snapshot.events.find(event => event.type === "text.result")?.display_payload;
        if (payload?.schemaVersion !== 1 || typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 16000) throw new Error("Cloud DSH 未返回有效的改写文本，请检查任务结果或服务版本");
        value = { type: "text", text: payload.text };
        }
        const writers = this.document.nodes.filter(item => item.textTarget && item.inputs.text?.some(input => input.nodeId === id && input.portId === "text"));
        // A single-card run also updates explicitly connected content cells.
        for (const writer of writers) await this.writeContentInput(writer, value);
        await this.finish(runId, node, { text: value });
        await emit("creative://changed", { projectId: this.projectId });
      } else if (node.kind === "generation") {
        let paths: string[] = [];
        if (step.jobId) {
          const previous = (await api.recentGenSessions(500)).find(job => job.id === step.jobId);
          if (!previous || previous.status !== "done") {
            if (previous?.status === "failed") throw new Error(previous.error || "生成失败");
            await this.step(runId, id, { status: "waiting", error: "原任务尚未完成，请稍后继续取回" }); return;
          }
          const turn = step.turnKey ? previous.turns.find(turn => turn.turn_key === step.turnKey) : previous.turns[0];
          paths = turn?.images ?? [];
        } else {
          if (step.status !== "pending") throw new Error("无法确认上次提交状态，请检查任务中心");
          const identity = { jobId: crypto.randomUUID(), turnKey: crypto.randomUUID() };
          const sessionNodeId = `gen-prompt:${identity.jobId}:${identity.turnKey}:0`;
          await this.save({ ...this.document, nodes: this.document.nodes.map(candidate => candidate.id === id
            ? { ...candidate, activeSessionNodeId: sessionNodeId, sessionNodeIds: [...(candidate.sessionNodeIds ?? []), sessionNodeId] } : candidate) });
          await this.step(runId, id, { status: "running", jobId: identity.jobId, turnKey: identity.turnKey });
          const result = await useStore.getState().startGeneration(prompt, orderedAssets, node.ratio, node.provider, prompt,
            undefined, undefined, undefined, visualProfileId, { projectId: this.projectId, threadId: this.run(runId).threadId }, false, undefined, identity);
          if (!result.accepted) throw new Error(result.error || "生成未完成");
          const turns = useStore.getState().genJobs[identity.jobId]?.turns ?? [];
          paths = (turns.find(turn => turn.turnKey === identity.turnKey) ?? (turns.length === 1 && !turns[0].turnKey ? turns[0] : undefined))?.images ?? [];
        }
        if (this.stopped.has(runId)) return;
        const assetIds = await Promise.all(paths.map(path => api.localAgentFindAssetId(path)));
        if (!assetIds.length || assetIds.some(id => !id)) {
          await this.step(runId, id, { status: "waiting", error: "本次生成图片尚未入库，请稍后继续取回" }); return;
        }
        await this.finish(runId, node, { image: { type: "image", assetIds: [...new Set(assetIds as string[])] } });
      } else {
        if (!step.agentRunId) {
          if (step.status !== "pending") throw new Error("技能提交状态未知，请先检查 Agent 任务记录");
          const skill = WORKFLOW_SKILLS.find(skill => skill.id === node.skill);
          if (!skill) throw new Error("技能不可用");
          const account = useStore.getState();
          if (!account.cloudAuth?.logged_in || !account.cloudEntitlement?.is_test_account
            || account.cloudEntitlement.user_id !== account.cloudAuth.user_id
            || !canUseAgentRun(account.cloudEntitlement, "bowerbird-unified-agent")) throw new Error("当前账号尚未开放此技能，请使用已获授权的测试账号");
          const active = Object.values(account.cloudAgentRuns).filter(run => !["succeeded", "failed", "cancelled"].includes(run.status)).length;
          if (!canStartAnotherAgentRun(account.cloudEntitlement, active, "bowerbird-unified-agent")) throw new Error("技能并发已满，请等待当前任务结束");
          await this.step(runId, id, { status: "running" });
          const run = await api.cloudAgentStart({ intentPrompt: `${skill.instruction}\n\n${prompt}`, references: assetIds.map(assetId => ({ assetId })),
            projectId: this.projectId, threadId: this.run(runId).threadId, visualProfileId, imageProvider: "cloud", skillId: "bowerbird-unified-agent", agentRuntime: "dsh", ratio: node.ratio });
          if (this.stopped.has(runId)) { await api.cloudAgentCancel(run.runId); return; }
          await this.step(runId, id, { status: "waiting", agentRunId: run.runId });
          useStore.getState().openCloudAgentRun(run, { navigate: false });
          return;
        }
        const run = await api.cloudAgentGet(step.agentRunId);
        useStore.getState().openCloudAgentRun(run, { navigate: false });
        if (["failed", "cancelled"].includes(run.status)) throw new Error(run.snapshot.run.safe_message || "技能执行未完成");
        if (run.status !== "succeeded") { await this.step(runId, id, { status: "waiting" }); return; }
        const images = await enqueueCloudAgentRunOperation(run.runId, () => api.cloudAgentIngestArtifacts(run.runId));
        if (!images.length) throw new Error("技能未交付可用图片");
        await this.finish(runId, node, { image: { type: "image", assetIds: images.map(image => image.id) } });
      }
    };
    try {
      await this.writing;
      if (this.stopped.has(runId)) return;
      await this.saveRun({ ...this.run(runId), status: "running" });
      const run = this.run(runId);
      const nodes = workflowExecutionNodes(this.document.nodes, run.startId);
      const dependencies = new Map(run.order.map(id => [id, Object.values(nodes.find(node => node.id === id)!.inputs).flat()
        .flatMap(input => workflowInputProducers(nodes, input)).filter(producer => run.order.includes(producer))]));
      while (!halted()) {
        for (const id of run.order) {
          if (attempted.has(id) || this.run(runId).steps[id].status === "done"
            || !dependencies.get(id)!.every(producer => this.run(runId).steps[producer].status === "done")) continue;
          attempted.add(id);
          const task = execute(id).catch(error => { failures.set(id, error); }).finally(() => { active.delete(id); });
          active.set(id, task);
        }
        if (!active.size) break;
        // Wake on each completion, so a fast branch never waits for an unrelated slow branch.
        await Promise.race(active.values());
      }
      await Promise.all(active.values());
      if (failures.size) {
        const [id, error] = failures.entries().next().value!;
        currentId = id; throw error;
      }

      if (!this.stopped.has(runId)) {
        const run = this.run(runId);
        await this.saveRun({ ...run, status: run.order.every(id => run.steps[id].status === "done") ? "done" : "waiting" });
      }
    } catch (error) {
      if (!this.stopped.has(runId) && this.run(runId)) {
        const run = this.run(runId);
        const failedNode = this.document.nodes.find(node => node.id === currentId);
        if (failedNode) this.issue = workflowDiagnostic(error, failedNode, "execution", runId, run.order.indexOf(currentId!) + 1);
        // Preserve identity for read-only recovery; never automatically resubmit after an error.
        const steps = { ...run.steps };
        if (currentId && !failures.size) failures.set(currentId, error);
        for (const [id, reason] of failures) {
          const node = this.document.nodes.find(node => node.id === id);
          const diagnostic = node && workflowDiagnostic(reason, node, "execution", runId, run.order.indexOf(id) + 1);
          steps[id] = { ...steps[id], status: "failed", error: String(reason), ...(diagnostic ? { diagnostic } : {}) };
        }
        this.stopped.add(runId);
        await this.saveRun({ ...run, status: "failed", steps }).catch(() => {});
      }
    } finally {
      await Promise.all(active.values());
      this.profileAbort.delete(runId); this.executing.delete(runId);
      this.executionDrains.delete(runId); drained(); this.emit();
    }
  }
}
