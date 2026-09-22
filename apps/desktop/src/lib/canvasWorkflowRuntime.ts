import { api } from "./api";
import { emit } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { loadDescribePrompt } from "./describePrompt";
import { canStartAnotherAgentRun, canUseAgentRun, understandProvider } from "./entitlement";
import { renderLayerDocument } from "./layerDocument";
import { workflowLayerDecompose } from "./workflowLayerDecompose";
import { readCanvasNote } from "./canvasNotes";
import { enqueueCloudAgentRunOperation } from "./cloudAgentRuntime";
import { describeBrandImage } from "./describeBrandImage";
import { emptyWorkflow, invalidateWorkflow, workflowDependencies, workflowLockedNodes, workflowRuns, workflowRunActive, workflowInputProducer, workflowInputValues, workflowOrder, WORKFLOW_SKILLS,
  type WorkflowRun, type WorkflowNode, type WorkflowStep, type WorkflowValue } from "./canvasWorkflow";

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
  revision = 0;
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private executing = new Set<string>();
  private reservations = new Map<string, string[]>();
  private stopped = new Set<string>();
  private stopping = new Set<string>();
  private profileAbort = new Map<string, AbortController>();
  isLocked(id: string) { return workflowLockedNodes(this.document).has(id) || [...this.reservations.values()].some(ids => ids.includes(id)); }
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
        this.document = snapshot.document; this.revision = snapshot.revision; this.ready = true;
        // A crash is not permission to repeat a billable request. Continue only queries known jobs.
        const runs = workflowRuns(this.document);
        for (const run of runs) if (run.status === "running") {
          run.status = "waiting";
          const nextId = run.order.find(id => run.steps[id].status !== "done");
          if (nextId) run.steps[nextId] = { ...run.steps[nextId],
            status: run.steps[nextId].status === "pending" ? "pending" : "waiting",
            error: "上次执行已中断，可继续取回已有任务；不会自动重新生成。" };
        }
        this.document = { ...this.document, runs, run: runs[runs.length - 1] ?? null };
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
    for (const node of this.document.nodes) if (this.isLocked(node.id) && JSON.stringify(node) !== JSON.stringify(nodes.find(next => next.id === node.id))) {
      throw new Error("此卡片关联的工作流正在运行，请先停止对应流程");
    }
    const runs = workflowRuns(this.document).filter(run => workflowRunActive(run) || run.order.every(id => nodes.some(node => node.id === id)));
    await this.save({ ...this.document, nodes, runs, run: runs[runs.length - 1] ?? null });
  }
  async start(startId: string, single = false) {
    if (!this.ready) throw new Error("工作流尚未载入");
    const order = single ? [startId] : workflowOrder(this.document.nodes, startId);
    if (!this.document.nodes.some(node => node.id === startId)) throw new Error("卡片不存在");
    const lockedNodeIds = workflowDependencies(this.document.nodes, order);
    if (lockedNodeIds.some(id => this.isLocked(id))) throw new Error("关联卡片正在执行其他工作流");
    const runId = crypto.randomUUID(), threadId = crypto.randomUUID();
    this.reservations.set(runId, lockedNodeIds); this.emit();
    try {
    await this.writing;
    // Validate all fixed inputs before starting any billable step.
    for (const id of order) {
      const node = this.document.nodes.find(node => node.id === id)!;
      if (node.kind === "instruction" && !(node.inputs.image?.length)) throw new Error("请先连接指令卡片的图片输入");
      if (node.kind === "visual-profile") {
        if (!node.profileId && !node.prompt.trim() && !node.inputs.text?.length && !node.inputs.image?.length) throw new Error("请给视觉规范卡片连接图片、填写文字，或选用已有规范");
      } else if (node.kind !== "instruction" && !node.prompt.trim() && !node.inputs.text?.length) throw new Error("请先填写指令或连接文本输入");
    }
    const cellBindings = this.document.nodes.filter(node => order.includes(node.id)).flatMap(node => Object.values(node.inputs).flat()).filter(input => input.canvasNodeId);
    const groupIds = [...new Set(this.document.nodes.filter(node => order.includes(node.id)).flatMap(node => Object.values(node.inputs).flat()).flatMap(input => input.groupId ? [input.groupId] : []))];
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
    if (cellBindings.length) {
      const canvas = await api.projectCanvasGet(this.projectId);
      for (const input of cellBindings) {
        if (order.includes(workflowInputProducer(this.document.nodes, input) ?? "")) continue;
        const source = canvas.nodes.find(node => node.id === input.canvasNodeId && node.kind === "note" && node.hiddenAt == null);
        const text = source && readCanvasNote(source).cells.flat().find(cell => cell.id === input.cellId)?.text;
        if (text === undefined) throw new Error("连接的文本单元格已不存在");
        cellTexts[JSON.stringify([input.canvasNodeId, input.cellId])] = text;
      }
    }
    await api.projectThreadCreate({ id: threadId, projectId: this.projectId, title: "工作流", origin: "direct" });
    const nodes = invalidateWorkflow(this.document.nodes, startId).map(node => this.isLocked(node.id) && !lockedNodeIds.includes(node.id) ? this.document.nodes.find(item => item.id === node.id)! : order.includes(node.id) ? {
      ...node, inputs: Object.fromEntries(Object.entries(node.inputs).map(([port, bindings]) => [port, bindings.map(input => input.groupId ? { ...input, assetIds: groupAssets.get(input.groupId)! } : input)])),
    } : node);
    await this.saveRun({ id: runId, startId, threadId, order, lockedNodeIds, cellTexts, status: "running",
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
    this.profileAbort.get(runId)?.abort();
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

  async continue(runId = this.document.run?.id) {
    if (!runId || this.executing.has(runId) || this.stopping.has(runId) || !this.run(runId) || !workflowRunActive(this.run(runId))) return;
    this.executing.add(runId); this.stopped.delete(runId);
    let currentId = "";
    try {
      await this.writing;
      if (this.stopped.has(runId)) return;
      await this.saveRun({ ...this.run(runId), status: "running" });
      for (const id of this.run(runId).order) {
        if (this.stopped.has(runId)) return;
        currentId = id;
        const accountId = this.run(runId).accountId;
        if (accountId !== undefined && accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后继续，或停止此工作流");
        const node = this.document.nodes.find(node => node.id === id)!;
        const step = this.run(runId).steps[id];
        if (step.status === "done") continue;
        this.progress(runId, id, node.kind === "generation" ? "生成图片，等待会话结果" : node.kind === "skill" ? "执行技能，等待任务结果或审批" : node.kind === "visual-profile" ? "处理视觉规范" : "读取输入素材");
        const hasCells = Object.values(node.inputs).flat().some(input => input.canvasNodeId);
        const cellTexts = this.run(runId).cellTexts;
        const liveCells = Object.values(node.inputs).flat().some(input => input.canvasNodeId && this.run(runId).order.includes(workflowInputProducer(this.document.nodes, input) ?? ""));
        const canvas = hasCells && (!cellTexts || liveCells) ? await api.projectCanvasGet(this.projectId) : null;
        const values = workflowInputValues(this.document.nodes, node, (nodeId, cellId) => {
          const producedThisRun = this.run(runId).order.includes(workflowInputProducer(this.document.nodes, { canvasNodeId: nodeId }) ?? "");
          if (cellTexts && !producedThisRun) return cellTexts[JSON.stringify([nodeId, cellId])];
          const source = canvas?.nodes.find(candidate => candidate.id === nodeId && candidate.kind === "note" && candidate.hiddenAt == null);
          return source ? readCanvasNote(source).cells.flat().find(cell => cell.id === cellId)?.text : undefined;
        });
        const assetIds = [...new Set((values.image ?? []).flatMap(value => value.assetIds ?? []))];
        const assets = await api.getAssetsByIds(assetIds);
        if (assets.length !== assetIds.length || assets.some(asset => !asset.store_path || asset.duration)) throw new Error("输入图片已丢失或不是静态图片，请重新选择");
        const orderedAssets = assetIds.map(id => assets.find(asset => asset.id === id)!);
        const prompt = [...(values.text ?? []).map(value => value.text), node.prompt].filter(Boolean).join("\n\n").trim();
        const visualProfileId = values["visual-profile"]?.[0]?.profileId ?? null;
        if (visualProfileId) {
          const profile = await api.visualProfileGet(visualProfileId);
          if (profile.status !== "confirmed" || profile.version !== values["visual-profile"][0].version) throw new Error("连接的视觉规范已删除或版本不匹配，请重新选择");
        }
        if (node.kind === "visual-profile") {
          const inputKey = JSON.stringify({ assets: assetIds.slice().sort(), prompt });
          let profileId = node.profileId || step.profileId || (node.profileCache?.inputKey === inputKey ? node.profileCache.profileId : undefined);
          if (!profileId) {
            if (step.status !== "pending") throw new Error("上次提炼状态未知，请检查已有规范后选择版本，或停止后重新提炼");
            if (prompt.length > 4000) throw new Error("视觉要求不能超过 4000 字");
            const missing = await api.visualProfileInputPreview(assetIds, prompt);
            if (this.stopped.has(runId)) return;
            await this.step(runId, id, { status: "running" });
            this.profileAbort.set(runId, new AbortController());
            for (const assetId of missing) {
              if (this.stopped.has(runId)) return;
              if (this.run(runId).accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请停止后重试");
              await describeBrandImage(assetId, this.profileAbort.get(runId)!.signal);
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
            break;
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
          const provider = state.defaultUnderstandProvider === "auto" ? understandProvider(state.cloudEntitlement) : state.defaultUnderstandProvider;
          if (!provider) throw new Error("当前没有可用的反推引擎");
          const sections: Array<{ title: string; body: string }> = [];
          const rows: Array<{ assetId: string; name: string; prompt: string }> = [];
          const describeJobIds = assetIds.map(() => `workflow-describe-${crypto.randomUUID()}`);
          await this.step(runId, id, { status: "running", describeJobIds, detail: `并行反推 ${assetIds.length} 张图片 · 已完成 0/${assetIds.length}` });
          let completed = 0, failed = false;
          let firstError: unknown;
          const pending = new Set(describeJobIds);
          // Settle all started requests before unlocking the card; an error cancels only this batch.
          const results = await Promise.allSettled(assetIds.map(async (assetId, index) => {
            try {
              const analysisId = await api.describeAsset(assetId, node.prompt.trim() || loadDescribePrompt(), provider, describeJobIds[index]);
              const analysis = (await api.listAnalysesByAsset(assetId)).find(item => item.id === analysisId);
              const parts = analysis ? JSON.parse(analysis.payload)?.sections as Array<{ title: string; body: string }> : null;
              if (!parts?.length) throw new Error(`第 ${index + 1} 张图片反推未返回可用维度`);
              completed++;
              if (!failed) this.progress(runId, id, `并行反推 ${assetIds.length} 张图片 · 已完成 ${completed}/${assetIds.length}`);
              return parts;
            } catch (error) {
              if (!failed) {
                failed = true; firstError = error;
                this.progress(runId, id, `反推失败，正在停止本批次剩余任务`);
                await Promise.allSettled([...pending].filter(jobId => jobId !== describeJobIds[index]).map(jobId => api.cancelCodexDescribe(jobId)));
              }
              throw error;
            } finally { pending.delete(describeJobIds[index]); }
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
          if (rows.length > 1 || node.resultNodeIds?.length) {
            if (this.stopped.has(runId)) return;
            this.progress(runId, id, `已反推 ${rows.length} 张图片，正在生成素材 / 提示词表格`);
            const tableId = `workflow-describe:${runId}:${id}`;
            const cell = (text: string, key: string, bold = false) => ({ id: key, text, bold, italic: false, align: "left" });
            const cells = [[cell("素材", "heading-asset", true), cell("提示词", "heading-prompt", true)],
              ...rows.map(row => [cell(row.name, `${row.assetId}-asset`), cell(row.prompt, `${row.assetId}-prompt`)])];
            const canvas = await api.projectCanvasGet(this.projectId);
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
            } else {
              await api.projectCanvasNodeCreate({ id: tableId, projectId: this.projectId, threadId: this.run(runId).threadId, kind: "note", assetId: null, role: null,
                payloadJson: JSON.stringify(payload), x, y, width, height, zIndex: Math.max(0, ...canvas.nodes.map(item => item.zIndex)) + 1, positionLocked: true });
              await this.save({ ...this.document, nodes: this.document.nodes.map(item => item.id === id ? { ...item, resultNodeIds: [...(item.resultNodeIds ?? []), tableId] } : item) });
            }
            await emit("creative://changed", { projectId: this.projectId, threadId: this.run(runId).threadId, jobId: runId, turnKey: tableId, status: "done" });
          }
          // A removed dimension must not silently rebind to a different dimension after reordering.
          const ports = sections.map(section => ({ id: `dimension-${encodeURIComponent(section.title)}`, label: section.title, type: "text" as const }));
          await this.finish(runId, node, { ...Object.fromEntries(sections.map((section, index) => [ports[index].id, { type: "text" as const, text: section.body }])),
            text: { type: "text", text: sections.map(section => `${section.title}：${section.body}`).join("\n\n") } }, ports);
        } else if (node.kind === "instruction" && node.action === "layers") {
          const layerRequestKey = step.layerRequestKey ?? `layers-${crypto.randomUUID()}`;
          const create = step.status === "pending" && !step.layerRequestKey;
          if (!create && !step.layerRequestKey) throw new Error("原分层步骤没有拆分任务，请重新运行卡片");
          await this.step(runId, id, { status: "running", assetId: assetIds[0], layerRequestKey });
          const document = await workflowLayerDecompose(assetIds[0], orderedAssets[0].store_path!, "", layerRequestKey, create, () => this.stopped.has(runId), detail => this.progress(runId, id, detail));
          const outputs: Record<string, WorkflowValue> = {}, ports = [];
          for (const [index, layer] of document.layers.entries()) {
            if (this.stopped.has(runId)) return;
            this.progress(runId, id, `导出第 ${index + 1}/${document.layers.length} 层：${layer.name}`);
            // Preserve the background-first workspace contract; render only the selected layer.
            const doc = { ...document, layers: document.layers.map(item => ({ ...item, visible: item.id === layer.id })) };
            const image = await api.layerExport(assetIds[0], doc, await renderLayerDocument(doc), this.projectId, true);
            const port = { id: `layer-${layer.id}`, label: layer.name, type: "image" as const };
            ports.push(port); outputs[port.id] = { type: "image", assetIds: [image.id] };
          }
          outputs.image = { type: "image", assetIds: Object.values(outputs).flatMap(output => output.assetIds ?? []) };
          const canvas = await api.projectCanvasGet(this.projectId);
          const groupId = node.resultGroupId ?? `workflow-products:${node.id}`;
          const existingGroup = canvas.groups.find(group => group.id === groupId);
          const x = existingGroup?.x ?? node.x + 420, width = 286, height = 230;
          let y = existingGroup?.y ?? node.y;
          if (!existingGroup) {
            const obstacles = [...canvas.nodes.filter(item => item.hiddenAt == null), ...canvas.groups, ...this.document.nodes.map(item => ({ ...item, width: 320, height: 400 }))];
            while (obstacles.some(item => x < item.x + item.width + 24 && x + width + 24 > item.x && y < item.y + item.height + 24 && y + height + 24 > item.y)) y += height + 40;
          }
          const products = await api.getAssetsByIds(outputs.image.assetIds!);
          const memberIds: string[] = [];
          for (const assetId of outputs.image.assetIds!) {
            const asset = products.find(item => item.id === assetId);
            if (!asset) throw new Error("分层产物已丢失，无法显示到画板");
            const memberId = `workflow-layer:${node.id}:${assetId}`;
            const existing = canvas.nodes.find(item => item.id === memberId);
            if (!existing) await api.projectCanvasNodeCreate({ id: memberId, projectId: this.projectId, threadId: this.run(runId).threadId, kind: "asset", assetId, role: "output",
              payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: asset.name, width: asset.width, height: asset.height } }),
              x, y, width: 190, height: 180, zIndex: 1, positionLocked: true });
            else if (existing.hiddenAt != null) await api.projectCanvasNodeRestore(this.projectId, memberId);
            memberIds.push(memberId);
          }
          // Keep older edited versions in the same folder; identical reruns reuse member identities.
          const members = [...new Set([...canvas.groupItems.filter(item => item.groupId === groupId).map(item => item.nodeId), ...memberIds])];
          if (existingGroup) await api.projectCanvasGroupSetItems(groupId, members);
          else await api.projectCanvasGroupCreate({ id: groupId, projectId: this.projectId, name: "分层产物", role: null, x, y, width, height, zIndex: Math.max(0, ...canvas.nodes.map(item => item.zIndex)) + 1 }, members);
          await this.save({ ...this.document, nodes: this.document.nodes.map(item => item.id === id ? { ...item, resultGroupId: groupId } : item) });
          await emit("creative://changed", { projectId: this.projectId, threadId: this.run(runId).threadId, jobId: runId, turnKey: groupId, status: "done" });
          await this.finish(runId, node, outputs, ports);
        } else if (node.kind === "generation") {
          let jobId = step.jobId;
          if (step.jobId) {
            const previous = (await api.recentGenSessions(500)).find(job => job.id === step.jobId);
            if (!previous || previous.status !== "done") {
              if (previous?.status === "failed") throw new Error(previous.error || "生成失败");
              await this.step(runId, id, { status: "waiting", error: "原任务尚未完成，请稍后继续取回" }); break;
            }
          } else {
            if (step.status !== "pending") throw new Error("无法确认上次提交状态，请检查任务中心");
            const identity = { jobId: crypto.randomUUID(), turnKey: crypto.randomUUID() };
            jobId = identity.jobId;
            const sessionNodeId = `gen-prompt:${identity.jobId}:${identity.turnKey}:0`;
            await this.save({ ...this.document, nodes: this.document.nodes.map(candidate => candidate.id === id
              ? { ...candidate, sessionNodeIds: [...(candidate.sessionNodeIds ?? []), sessionNodeId] } : candidate) });
            await this.step(runId, id, { status: "running", jobId: identity.jobId });
            const result = await useStore.getState().startGeneration(prompt, orderedAssets, node.ratio, node.provider, prompt,
              undefined, undefined, undefined, visualProfileId, { projectId: this.projectId, threadId: this.run(runId).threadId }, false, undefined, identity);
            if (!result.accepted) throw new Error(result.error || "生成未完成");
          }
          const nodeIds = this.document.nodes.find(candidate => candidate.id === id)?.sessionNodeIds?.filter(nodeId => nodeId.startsWith(`gen-prompt:${jobId}:`)) ?? [];
          await this.finish(runId, node, { session: { type: "session", nodeIds } });
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
            break;
          }
          const run = await api.cloudAgentGet(step.agentRunId);
          useStore.getState().openCloudAgentRun(run, { navigate: false });
          if (["failed", "cancelled"].includes(run.status)) throw new Error(run.snapshot.run.safe_message || "技能执行未完成");
          if (run.status !== "succeeded") { await this.step(runId, id, { status: "waiting" }); break; }
          const images = await enqueueCloudAgentRunOperation(run.runId, () => api.cloudAgentIngestArtifacts(run.runId));
          if (!images.length) throw new Error("技能未交付可用图片");
          await this.finish(runId, node, { image: { type: "image", assetIds: images.map(image => image.id) } });
        }
      }
      if (!this.stopped.has(runId)) {
        const run = this.run(runId);
        await this.saveRun({ ...run, status: run.order.every(id => run.steps[id].status === "done") ? "done" : "waiting" });
      }
    } catch (error) {
      this.error = String(error);
      if (!this.stopped.has(runId) && this.run(runId)) {
        const run = this.run(runId);
        // Preserve identity for read-only recovery; never automatically resubmit after an error.
        const steps = currentId ? { ...run.steps,
          [currentId]: { ...run.steps[currentId], status: "failed" as const, error: String(error) } } : run.steps;
        this.stopped.add(runId);
        await this.saveRun({ ...run, status: "failed", steps }).catch(() => {});
      }
    } finally { this.profileAbort.delete(runId); this.executing.delete(runId); this.emit(); }
  }
}
