import { api } from "./api";
import { canvasInputValue, canvasWorkflowInputState } from "./canvasSessionOutputs";
import { readCanvasNote } from "./canvasNotes";
import { activePromptReferences, workflowBindingKey, workflowOutputs, workflowRuns, workflowTitle, type CanvasWorkflow, type WorkflowNode } from "./canvasWorkflow";
import { buildWorkflowPlan, canResumeWorkflowPlanning, canUndoWorkflowPlan, compilePlanningPrompt, plannerContextKey, planningContract, planningSnapshotKey, samePlanningContext, type PlanningSource, type WorkflowPlanningState } from "./workflowPlanner";

interface Host {
  projectId: string;
  document: CanvasWorkflow;
  ready: boolean;
  error: string;
  edit(nodes: WorkflowNode[]): Promise<void>;
  isLocked(id: string): boolean;
}

/** Uses the existing DS queue. A proposal can only append validated cards to this project. */
export class WorkflowPlannerRuntime {
  private polling = new Set<string>();
  private starting = new Set<string>();
  constructor(private host: Host) {}
  private node(id: string) {
    const node = this.host.document.nodes.find(node => node.id === id && node.kind === "planner");
    if (!node) throw new Error("工作流助手已删除");
    return node;
  }
  private update(id: string, planning: WorkflowPlanningState) {
    return this.host.edit(this.host.document.nodes.map(node => node.id === id ? { ...node, planning } : node));
  }
  private async sources(owner: WorkflowNode): Promise<PlanningSource[]> {
    const canvas = await api.projectCanvasGet(this.host.projectId), sources: PlanningSource[] = [];
    let sourceIndex = 0;
    for (const type of ["text", "image"] as const) for (const original of owner.inputs[type] ?? []) {
      const input = structuredClone(original);
      if (++sourceIndex > 12) throw new Error("助手一次最多使用 12 个来源");
      const id = `source${sourceIndex}`, children: PlanningSource[] = [];
      const referenced = activePromptReferences(owner).some(ref => ref.type === type && workflowBindingKey(ref.input) === workflowBindingKey(input));
      const textPreview = (text: string) => referenced ? text : text.slice(0, 600);
      let label = "", preview = "", contentKey: string | undefined;
      if (input.nodeId) {
        const node = this.host.document.nodes.find(node => node.id === input.nodeId);
        if (!node || !workflowOutputs(node).some(port => port.id === input.portId && port.type === type)) throw new Error("连接的工作流来源已失效");
        label = workflowTitle(node); preview = textPreview(node.outputs[input.portId!]?.text ?? "等待上游输出");
      } else if (input.canvasNodeId) {
        if (canvasWorkflowInputState(input, canvas.nodes, this.host.document.nodes) === "missing") throw new Error("连接的内容单元格已删除");
        const node = canvas.nodes.find(node => node.id === input.canvasNodeId && node.hiddenAt == null);
        const value = node && canvasInputValue(node, input.cellId ?? "", canvas.nodes);
        contentKey = value ? JSON.stringify(value) : undefined;
        if (value && value.type !== type) throw new Error("来源内容类型已改变");
        label = type === "text" ? "内容卡文本" : "内容卡图片";
        preview = value?.type === "text" ? textPreview(value.text) : value ? `${value.assetIds.length} 张图片（未进行视觉分析）` : "等待上游输出";
        if (node?.kind === "note" && type === "image" && input.cellId === "*") {
          for (const [index, cell] of readCanvasNote(node).cells.flat().entries()) {
            if (cell.content_type !== "image") continue;
            const childInput = { ...input, cellId: cell.id! };
            const childValue = canvasInputValue(node, cell.id!, canvas.nodes);
            if (!childValue?.assetIds.length) continue;
            if (sources.length + children.length >= 47) throw new Error("助手一次最多处理 48 个来源（含图片单元格），请减少接入内容");
            const assets = await api.getAssetsByIds(childValue.assetIds);
            if (assets.length !== childValue.assetIds.length) throw new Error("连接的内容卡图片已失效");
            children.push({ id: `${id}_cell${index + 1}`, parentId: id, type, input: childInput,
              contentKey: JSON.stringify(childValue),
              label: `${label}第 ${index + 1} 格`,
              preview: `${assets.length} 张图片（未进行视觉分析）：${assets.map(asset => `${asset.name} (${asset.width}×${asset.height})`).join("、").slice(0, 600)}` });
          }
        }
      } else if (input.assetId || input.groupId) {
        if (input.groupId && !canvas.groups.some(group => group.id === input.groupId)) throw new Error("连接的素材文件夹已删除");
        if (input.assetNodeId && !canvas.nodes.some(node => node.id === input.assetNodeId && node.assetId === input.assetId && node.hiddenAt == null)) throw new Error("连接的画板图片已移除");
        if (input.groupId) input.assetIds = canvas.groupItems.filter(item => item.groupId === input.groupId).flatMap(item => {
          const node = canvas.nodes.find(node => node.id === item.nodeId && node.hiddenAt == null);
          return node?.assetId ? [node.assetId] : [];
        });
        const ids = input.assetId ? [input.assetId] : input.assetIds ?? [];
        const assets = await api.getAssetsByIds(ids);
        if (!assets.length || assets.length !== ids.length) throw new Error("连接的图片来源已失效");
        label = assets.map(asset => asset.name).join("、").slice(0, 300); preview = `${assets.length} 张图片（未进行视觉分析）`;
      } else throw new Error("不支持的编排来源");
      if (sources.length + children.length >= 48) throw new Error("助手一次最多处理 48 个来源（含图片单元格），请减少接入内容");
      sources.push({ id, type, input: structuredClone(input), label, preview, ...(contentKey !== undefined ? { contentKey } : {}) }, ...children);
    }
    return sources;
  }
  async start(id: string) {
    if (!import.meta.env.DEV) throw new Error("工作流助手目前仅在开发版使用本机 DSH");
    if (!this.host.ready || this.host.error) throw new Error("请先完成工作流载入和保存");
    if (this.starting.has(id) || this.node(id).planning?.status === "waiting") throw new Error("已有编排请求，请取回结果或取消等待");
    this.starting.add(id);
    try {
      const owner = this.node(id), contextKey = plannerContextKey(owner);
      if (!owner.prompt.trim() || owner.prompt.length > 4000) throw new Error("请填写 1–4000 字的工作流需求");
      const sources = await this.sources(owner);
      const instruction = compilePlanningPrompt(owner, sources);
      if (plannerContextKey(this.node(id)) !== contextKey) throw new Error("需求或来源已改变，请重新编排");
      const context = JSON.stringify({ contract: planningContract, sources: sources.map(({ input: _input, contentKey: _contentKey, ...source }) => source),
        ...(owner.planning?.status === "failed" ? { previousValidationError: owner.planning.error?.slice(0, 2000) } : {}) });
      if (context.length > 16000) throw new Error("编排上下文过长，请减少来源");
      const planning: WorkflowPlanningState = { requestId: `${Date.now()}-${crypto.randomUUID()}`, protocolVersion: 2, status: "waiting", contextKey, sources };
      await this.update(id, planning); // Save identity before delivery; reload never resubmits.
      try {
        const receipt = await api.agentDsWorkflowStart(planning.requestId, instruction, context, "planning-v2");
        if (this.node(id).planning?.requestId !== planning.requestId || this.node(id).planning?.status !== "waiting") return;
        const current = this.node(id).planning!;
        await this.update(id, { ...current, error: current.proposal ? current.error : receipt.notice ?? undefined });
        if (receipt.autoDelivered) void this.collect(id, true).catch(() => {});
      } catch (error) {
        // IPC can fail after durable delivery. Keep the same request for retrieval.
        if (this.node(id).planning?.requestId === planning.requestId && this.node(id).planning?.status === "waiting") await this.update(id, { ...this.node(id).planning!, error: `送达状态未知，可取回原请求：${String(error)}` });
      }
    } finally { this.starting.delete(id); }
  }
  async collect(id: string, wait = false) {
    let state = this.node(id).planning;
    if (!this.host.ready || this.host.error) throw new Error("请先完成工作流载入和保存");
    // Explicit retrieval can resume requests prematurely stopped by an older receiver.
    if (state && canResumeWorkflowPlanning(state) && !this.polling.has(state.requestId)) {
      await this.update(id, { ...state, status: "waiting", error: undefined });
      state = this.node(id).planning;
    }
    if (!state || state.status !== "waiting" || this.polling.has(state.requestId)) return;
    this.polling.add(state.requestId);
    const current = () => this.host.document.nodes.find(node => node.id === id)?.planning;
    let terminal = false;
    try {
      for (let attempt = 0; attempt < (wait ? 200 : 1); attempt++) {
        terminal = false;
        if (current()?.requestId !== state.requestId || current()?.status !== "waiting") return;
        let result;
        try { result = await api.agentDsWorkflowResult(state.requestId); }
        catch (error) {
          if (!wait || this.host.error) throw error;
          if (current()?.requestId !== state.requestId || current()?.status !== "waiting") return;
          if (current()?.error !== String(error)) await this.update(id, { ...current()!, error: String(error) });
          await new Promise(resolve => setTimeout(resolve, 1500));
          continue;
        }
        if (current()?.requestId !== state.requestId || current()?.status !== "waiting") return;
        if (result) {
          terminal = true;
          if (result.schemaVersion !== (state.protocolVersion ?? 1) || result.requestId !== state.requestId || !!result.text === !!result.error) throw new Error("编排回复身份或格式不匹配");
          if (result.error) throw new Error(result.error);
          const owner = this.node(id), sources = await this.sources(owner);
          const canvas = await api.projectCanvasGet(this.host.projectId);
          if (current()?.requestId !== state.requestId || current()?.status !== "waiting") return;
          const comparable = (items: PlanningSource[]) => planningSnapshotKey(items.map(({ parentId: _parentId, ...source }) => source));
          if (!samePlanningContext(state.contextKey, plannerContextKey(this.node(id))) || comparable(sources) !== comparable(state.sources)) throw new Error("需求或来源已变化，请按当前内容重新编排");
          const build = () => {
            if (state.protocolVersion === 2 && JSON.parse(result.text!).schemaVersion !== 2) throw new Error("请使用 schemaVersion:2 的声明式方案，移除 edges/trigger 并声明 sourceUses/outputs");
            return buildWorkflowPlan(result.text!, this.node(id), sources, this.host.document.nodes, [...canvas.nodes.filter(node => node.hiddenAt == null), ...canvas.groups]);
          };
          if (state.protocolVersion === 2) {
            const revision = result.revision;
            if (!Number.isInteger(revision) || revision! < 1 || revision! > 3 || !["proposal", "commit"].includes(result.phase ?? "")) throw new Error("编排版本或提交阶段无效");
            const previous = current()?.proposal;
            if (result.phase === "proposal") {
              const protocolError = previous && revision === previous.revision && result.text !== previous.text
                ? `同一草稿版本被改写；此内容未获准提交，请用 revision:${previous.revision + 1} 重新提交草稿。`
                : revision !== (previous?.revision ?? 0) && revision !== (previous?.revision ?? 0) + 1
                  ? `草稿版本不连续或过期；请使用 revision:${(previous?.revision ?? 0) + 1} 提交草稿。` : undefined;
              let validationError: string | undefined;
              try { build(); } catch (error) { validationError = String(error).slice(0, 2000); }
              validationError = [protocolError, validationError].filter(Boolean).join("\n").slice(0, 2000) || undefined;
              const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(result.text!))), byte => byte.toString(16).padStart(2, "0")).join("");
              if (current()?.requestId !== state.requestId || current()?.status !== "waiting") return;
              terminal = false; // Save / feedback transport failures keep this request resumable.
              const message = validationError ? `第 ${revision}/3 版校验未通过，等待修订：${validationError}` : `第 ${revision} 版校验通过，等待 Agent 确认提交。`;
              if (current()?.error !== message || (!protocolError && previous?.revision !== revision)) await this.update(id, { ...current()!,
                // Rejected replacements never overwrite the immutable validation record.
                ...(!protocolError ? { proposal: { revision: revision!, text: result.text!, digest, error: validationError } } : {}), error: message });
              if (current()?.requestId !== state.requestId || current()?.status !== "waiting") return;
              let receipt;
              try { receipt = await api.agentDsWorkflowFeedback(state.requestId, revision!, result.text!, validationError); }
              catch (error) {
                if (!wait || this.host.error) throw error;
                if (current()?.requestId !== state.requestId || current()?.status !== "waiting") return;
                if (current()?.error !== String(error)) await this.update(id, { ...current()!, error: String(error) });
                await new Promise(resolve => setTimeout(resolve, 1500));
                continue; // A newer proposal may have replaced the file while feedback was being written.
              }
              if (receipt !== digest) throw new Error("编排反馈校验值不一致，请重新取回");
              if (current()?.requestId !== state.requestId || current()?.status !== "waiting") return;
              if (validationError && (protocolError ? previous?.revision === 3 : revision === 3)) {
                await this.update(id, { ...current()!, status: "failed", error: `已达到三版修订上限：${validationError}` });
                return;
              }
              if (!wait) return;
              await new Promise(resolve => setTimeout(resolve, 1500));
              continue;
            }
            if (!previous || previous.error || previous.revision !== revision || previous.text !== result.text || previous.digest !== result.digest) throw new Error("提交与已校验草稿不一致，未创建卡片");
          }
          const plan = build();
          // One revision-checked save contains both inserted cards and the applied marker.
          await this.host.edit([...this.host.document.nodes.map(node => node.id === id ? { ...node, planning: { ...current()!, status: "applied" as const, summary: plan.summary, appliedNodes: structuredClone(plan.nodes), error: undefined } } : node), ...plan.nodes]);
          return;
        }
        if (wait) await new Promise(resolve => setTimeout(resolve, 1500));
      }
      if (current()?.requestId === state.requestId && current()?.status === "waiting") await this.update(id, { ...current()!, error: current()?.error ?? "仍在等待本机 DSH，稍后可取回结果；不会重复发送。" });
    } catch (error) {
      if (!this.host.error && current()?.requestId === state.requestId && current()?.status === "waiting") await this.update(id, { ...current()!, status: terminal ? "failed" : "waiting", error: String(error) });
      throw error;
    } finally { this.polling.delete(state.requestId); }
  }
  async cancel(id: string) {
    const state = this.node(id).planning;
    if (state?.status === "waiting") await this.update(id, { ...state, status: "cancelled", error: "已取消接收此编排；本机共享会话继续运行。" });
  }
  async undo(id: string) {
    const owner = this.node(id), state = owner.planning;
    if (!state || state.status !== "applied" || !canUndoWorkflowPlan(owner, this.host.document.nodes, nodeId => this.host.isLocked(nodeId)
      || workflowRuns(this.host.document).some(run => run.order.includes(nodeId)))) throw new Error("流程已编辑、运行或接入其他卡片，请手动调整；不会移除已有工作");
    const ids = new Set(state.appliedNodes!.map(node => node.id));
    await this.host.edit(this.host.document.nodes.filter(node => !ids.has(node.id)).map(node => node.id === id ? { ...node, planning: { ...state, status: "undone" as const, appliedNodes: undefined } } : node));
  }
}
