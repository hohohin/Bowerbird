import { assignCanvasCardNames } from "./canvasCardNames";
import { mergeWorkflowChanges } from "./workflowExternalChanges";
import { cloudChatEndedMessage } from "./userError";
import { activeTriggerSchedule, advanceTriggerSchedule, triggerScheduleOccurrence, workflowTriggerMode } from "./workflowTriggerSchedule";
import { normalizeWorkflowLocalVideo, workflowTitle, workflowCardWidth, workflowCompletionTriggers, workflowTriggerScope } from "./canvasWorkflow";
import { resolveVideoCardOutputs } from "./workflowVideoFrames";
import { automaticInputMedia, planAutomaticConnection, type AutomaticOutput } from "./workflowAutoConnect";
import { isAudioPath } from "./audioMedia";
import { voiceApi } from "./voice";
import { defaultVoiceSample, voiceCardClip, voiceCardPreviewKey, type VoiceCardRequest } from "./voiceCard";
import { api } from "./api";
import type { Asset, CanvasNode } from "./types";
import { placeWorkflowOutput } from "./canvasOutputPlacement";
import { assetPayloadJson, canvasAssetNodeSize, createCanvasAssetSnapshot } from "./creativeCanvas";
import { DEFAULT_VIDEO_OPTIONS, isVideoPath, resolveVideoOptions, videoInputError } from "./videoGeneration";
import { profileExtractionIssue, profileInputKey, workflowGenerationProvider, workflowProviderIssue } from "./workflowProviderIssue";
import { chatProviderAccessIssue } from "./chatCapabilities";
import { generationProviderIssue } from "./generationAvailability";
import { autoRatioFromReferences } from "../components/creation/ratios";
import { workflowLoopScope, workflowLoopRows, workflowLoopOutputs, workflowLoopItems, validateLoopItems, validateLoopStart } from "./workflowLoop";
import { WorkflowPlannerRuntime } from "./workflowPlannerRuntime";
import { emit } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { existingWorkflowCaption, workflowCaptionSections, workflowDescribeInstruction } from "./workflowDescribe";
import { canStartAnotherAgentRun, canUseAgentRun, understandProvider } from "./entitlement";
import { renderLayerDocument } from "./layerDocument";
import { workflowLayerDecompose } from "./workflowLayerDecompose";
import { readCanvasNote, emptyCanvasCell, canvasGridWeights, canvasTextMinSize } from "./canvasNotes";
import { canvasInputValue, reconcileCanvasWorkflowReferences, resolveGenerationCells, latestWorkflowSessionImage, completedCanvasSessions } from "./canvasSessionOutputs";
import { canvasContentInput, contentInputAxisIndex } from "./canvasContentInput";
import { agentResultValue } from "./workflowAgentResult";
import { localChat, localChatRunning, type ChatConversation, type ChatProvider } from "./localChat";
import { useLocalChatStore } from "./localChatStore";
import { terminalDshTurnFailure, workflowAgentMessage, workflowAgentProvider, workflowChatOutputs } from "./workflowAgentChat";
import { contentTableRows } from "./contentTable";
import { cloudAgentProfilePrompt } from "./workflowAgentProfile";

import { agentOutputTargets, agentTextWriters, agentWriterValue, routeAgentOutputs } from "./workflowAgentOutputs";
import { assertWorkflowAcyclic, rebindGenerationReferences, normalizeWorkflowInputSlots, workflowBindingKey } from "./canvasWorkflow";
import { WorkflowNodeError, workflowDiagnostic, type WorkflowDiagnostic } from "./workflowDiagnostics";
import { enqueueCloudAgentRunOperation } from "./cloudAgentRuntime";
import { describeBrandImage } from "./describeBrandImage";
import { canUseComfyVideo, comfyEnvironment, comfyEnvironmentReady, comfyVideo, comfyVideoElapsed, comfyVideoMode, DEFAULT_COMFY_VIDEO, type ComfyVideoStatus } from "./comfyVideo";
import { cleanH3OptimizedPrompt, h3OptimizationInstruction } from "./h3PromptOptimization";
import { compileAgentPrompt, compileGenerationPrompt, generationInputNode, workflowImageContainer, emptyWorkflow, newWorkflowNode, invalidateWorkflow, workflowExecutionNodes, workflowDependencies, workflowWriteNodes, workflowAccessConflict, workflowLockedNodes, workflowRuns, workflowRunActive, workflowInputProducers, workflowInputValues, workflowOrder, WORKFLOW_SKILLS,
  type WorkflowInput, type WorkflowRun, type WorkflowNode, type WorkflowStep, type WorkflowValue } from "./canvasWorkflow";

const controllers = new Map<string, CanvasWorkflowController>();
class ConfirmedDshTurnFailure extends WorkflowNodeError {}

/** Filter new automatic bindings using actual asset metadata, before legacy frame conversion. */
export async function filterAutomaticMediaValues(node: WorkflowNode, values: Record<string, WorkflowValue[]>, nodes: readonly WorkflowNode[] = []) {
  const inputs = generationInputNode(node, nodes).inputs;
  const ids = [...new Set(Object.entries(values).flatMap(([port, items]) => items.flatMap((value, index) =>
    inputs[port]?.[index]?.mediaFilter ? value.assetIds ?? [] : [])))];
  if (!ids.length) return;
  const assets = new Map((await api.getAssetsByIds(ids)).map(asset => [asset.id, asset]));
  for (const [port, items] of Object.entries(values)) for (const [index, source] of items.entries()) {
    const binding = inputs[port]?.[index];
    const filter = binding?.mediaFilter;
    if (!filter) continue;
    const value = items[index] = structuredClone(source);
    const accepted = filter.filter(media => automaticInputMedia(node).includes(media));
    value.assetIds = value.assetIds?.filter(id => {
      const asset = assets.get(id);
      if (!asset?.store_path) throw new WorkflowNodeError("输入素材已丢失，请检查来源卡片", node);
      const media = isAudioPath(asset.store_path) ? "audio" : isVideoPath(asset.store_path) ? "video" : "image";
      return accepted.includes(media);
    });
    // A rejected media type may occur before a ranked image in the same container.
    if (binding.referenceRanks && value.assetIds?.length !== source.assetIds?.length) {
      const kept = new Set(value.assetIds);
      value.referenceRanks = source.assetIds?.flatMap((id, i) => kept.has(id) ? [binding.referenceRanks![i] ?? -1] : []);
    }
    const excludedTokens = new Set(value.imageRefs?.filter(ref => !value.assetIds?.includes(ref.asset_id)).map(ref => ref.token));
    value.imageRefs = value.imageRefs?.filter(ref => value.assetIds?.includes(ref.asset_id));
    if (excludedTokens.size) {
      const removeExcluded = (text: string) => text.replace(/@图片\d+/g, token => excludedTokens.has(token) ? "" : token);
      if (value.text !== undefined) value.text = removeExcluded(value.text);
      if (value.table) value.table = { ...value.table, rows: value.table.rows.map(row => row.map(removeExcluded)), ...(value.table.columns ? { columns: value.table.columns.map(removeExcluded) } : {}) };
    }
    if (value.type === "image" && !value.assetIds?.length && !value.nodeIds?.length) {
      throw new WorkflowNodeError("来源卡片没有当前任务可用的素材，请检查来源或任务模式", node);
    }
  }
}
const scheduleSessionStartedAt = Date.now();
export function canvasWorkflowController(projectId: string) {
  let controller = controllers.get(projectId);
  if (!controller) { controller = new CanvasWorkflowController(projectId); controllers.set(projectId, controller); }
  return controller;
}

/** Deletion abandons local scheduling without waiting for a provider's terminal state. */
export function discardProjectWorkflow(projectId: string) {
  controllers.get(projectId)?.discard();
  controllers.delete(projectId);
}

/** Lives outside React: changing projects never redirects or repeats a provider submission. */
export class CanvasWorkflowController {
  private discarded = false;
  discard() {
    this.discarded = true;
    for (const run of workflowRuns(this.document)) this.stopped.add(run.id);
    for (const aborts of this.profileAbort.values()) for (const abort of aborts) abort.abort();
    clearTimeout(this.triggerTimer); clearTimeout(this.sessionCompletionTimer);
    this.ready = false;
  }
  readonly planner = new WorkflowPlannerRuntime(this);
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
  private persistedDocument = emptyWorkflow();
  private queuedDocument = emptyWorkflow();
  private measuredSizes = new Map<string, { width: number; height: number }>();
  measureCard(id: string, width: number, height: number) {
    if (width > 0 && height > 0 && Number.isFinite(width + height)) this.measuredSizes.set(id, { width, height });
  }
  private layoutNodes() {
    return this.document.nodes.map(node => this.measuredSizes.has(node.id) ? { ...node, layoutSize: this.measuredSizes.get(node.id) } : node);
  }
  private pendingEditAuthorization = false;
  private encapsulating = false;
  private executing = new Set<string>();
  private reservations = new Map<string, { access: string[]; writes: string[] }>();
  private stopped = new Set<string>();
  private stopping = new Set<string>();
  private retryingLoops = new Set<string>();
  private profileAbort = new Map<string, Set<AbortController>>();
  private executionDrains = new Map<string, Promise<void>>();
  private resources = new Map<string, Promise<unknown>>();
  private sessionCompletionTimer: ReturnType<typeof setTimeout> | undefined;
  private checkingSessionCompletions = false;
  private dispatchingSessionCompletions = new Set<string>();
  private sessionCompletionFailures = new Set<string>();
  private historicalSessionCompletions = new Set<string>();
  private triggerTimer: ReturnType<typeof setTimeout> | undefined;
  private triggerTimersEnabled = true;
  private dispatchingSchedule = false;
  setTriggerTimersEnabled(enabled: boolean) {
    this.triggerTimersEnabled = enabled;
    this.scheduleTriggers();
  }
  private scheduleTriggers() {
    clearTimeout(this.triggerTimer);
    this.triggerTimer = undefined;
    if (this.discarded || !this.triggerTimersEnabled || !this.ready || this.error || this.dispatchingSchedule) return;
    const pending = this.document.nodes.flatMap(node => { const schedule = activeTriggerSchedule(node); return schedule?.status === "armed" ? [schedule.at] : []; });
    if (!pending.length) return;
    // Short bounded waits tolerate system-clock changes and resume from sleep.
    const remaining = Math.min(...pending) - Date.now();
    this.triggerTimer = setTimeout(() => {
      this.triggerTimer = undefined;
      void this.checkScheduledTriggers();
    }, remaining > 0 ? Math.min(1000, remaining) : 1000);
  }
  private async checkScheduledTriggers() {
    if (!this.triggerTimersEnabled || !this.ready || this.error || this.dispatchingSchedule || this.encapsulating) { this.scheduleTriggers(); return; }
    this.dispatchingSchedule = true;
    try {
      for (const node of this.document.nodes) {
        const schedule = activeTriggerSchedule(node);
        if (node.kind !== "trigger" || schedule?.status !== "armed" || schedule.at > Date.now() || this.isLocked(node.id)) continue;
        try { await this.startRun(node.id, false, undefined, true, triggerScheduleOccurrence(schedule)); }
        catch (error) {
          this.showIssue(workflowDiagnostic(error, node, "validation"));
          // Never retry the same occurrence after validation failure. Daily schedules keep tomorrow.
          if (!this.error && this.document.nodes.find(current => current.id === node.id)?.triggerSchedule?.id === schedule.id) {
            await this.save({ ...this.document, nodes: this.document.nodes.map(current => current.id === node.id && current.triggerSchedule?.status === "armed"
              ? { ...current, triggerSchedule: schedule.dailyAt ? advanceTriggerSchedule(schedule) : { ...schedule, status: "failed" } } : current) });
          }
        }
      }
    } catch (error) { console.warn("保存定时触发状态失败", error); }
    finally { this.dispatchingSchedule = false; this.scheduleTriggers(); }
  }
  private scheduleSessionCompletions() {
    if (this.discarded || this.sessionCompletionTimer || !this.ready || this.error || !this.document.nodes.some(node =>
      node.kind === "trigger" && workflowTriggerMode(node) === "completion" && (node.triggerCount ?? 0) > 0 && node.inputs.completion?.some(input => input.canvasNodeId))) return;
    this.sessionCompletionTimer = setTimeout(() => {
      this.sessionCompletionTimer = undefined;
      void this.checkSessionCompletions();
    }, 1500);
  }
  private async checkSessionCompletions() {
    if (!this.ready || this.error || this.checkingSessionCompletions || this.encapsulating) return;
    this.checkingSessionCompletions = true;
    try {
      if (!this.document.nodes.some(node => node.kind === "trigger" && workflowTriggerMode(node) === "completion" && node.inputs.completion?.some(input => input.canvasNodeId))) return;
      const canvas = await api.projectCanvasGet(this.projectId);
      for (const id of this.document.nodes.filter(node => node.kind === "trigger").map(node => node.id)) {
        const node = this.document.nodes.find(node => node.id === id);
        if (!node || workflowTriggerMode(node) !== "completion" || this.isLocked(id) || this.dispatchingSessionCompletions.has(id)) continue;
        const completed = completedCanvasSessions(node.inputs.completion ?? [], canvas.nodes, useStore.getState().genJobs);
        const unseen = completed.filter(id => !node.completionSeen?.includes(id) && !this.historicalSessionCompletions.has(id));
        if (!unseen.length) continue;
        if (!(node.triggerCount! > 0)) {
          await this.save({ ...this.document, nodes: this.document.nodes.map(current => current.id === id
            ? { ...current, completionSeen: [...(current.completionSeen ?? []), ...unseen] } : current) });
          continue;
        }
        const sessionId = unseen[0], key = `${id}:${sessionId}`;
        if (this.sessionCompletionFailures.has(key)) continue;
        this.dispatchingSessionCompletions.add(id);
        void this.startRun(id, false, sessionId).catch(error => {
          this.sessionCompletionFailures.add(key);
          this.showIssue(workflowDiagnostic(error, node, "validation"));
        }).finally(() => { this.dispatchingSessionCompletions.delete(id); this.scheduleSessionCompletions(); });
      }
    } catch (error) {
      // Canvas reads can fail transiently; a failed durable write already blocks execution.
      console.warn("读取绘画会话完成状态失败", error);
    } finally {
      this.checkingSessionCompletions = false;
      this.scheduleSessionCompletions();
    }
  }
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
  load(provisional = false) {
    // Untouched canvases have no database row. Their first edit materializes
    // the project before saving this empty, revision-zero workflow.
    if (provisional && !this.loading) {
      this.loading = Promise.resolve();
      this.ready = true;
      this.error = "";
      this.emit();
    }
    if (!this.loading) this.loading = (async () => {
      try {
        const snapshot = await api.canvasWorkflowGet(this.projectId);
        this.document = snapshot.document; this.revision = snapshot.revision;
        this.persistedDocument = structuredClone(snapshot.document);
        this.queuedDocument = structuredClone(snapshot.document);
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
        for (const run of runs) for (const step of Object.values(run.steps)) {
          step.comfyStopping = false;
          step.comfyProgress = undefined;
        }
        for (const run of runs) if (run.status === "running") {
          run.status = "waiting";
          for (const id of run.order) if (run.steps[id].status === "running") run.steps[id] = { ...run.steps[id],
            status: "waiting", error: "上次执行已中断，可继续取回已有任务；不会自动重新生成。" };
        }
        const canvas = await api.projectCanvasGet(this.projectId);
        // Conversation metadata may hydrate later; baseline all completed turns before grouping them.
        this.historicalSessionCompletions = new Set(completedCanvasSessions(canvas.nodes.filter(node => node.kind === "prompt")
          .map(node => ({ canvasNodeId: node.id, cellId: "image" })), canvas.nodes, {}));
        const recovering = workflowLockedNodes({ ...this.document, runs });
        this.document = { ...this.document, nodes: reconcileCanvasWorkflowReferences(this.document.nodes, canvas.nodes).map(node => {
          // Old runs may own sparse pipe numbers. Keep their submitted inputs when
          // projecting those numbers into today's contiguous positions.
          if (recovering.has(node.id) && node.promptReferences) node = { ...node, promptReferences: node.promptReferences.map(ref => {
            if (ref.direction === "output" || ref.slot === undefined) return ref;
            const index = node.inputs[ref.type]?.findIndex(input => input.slot === ref.slot) ?? -1;
            return index < 0 ? ref : { ...ref, slot: index + 1 };
          }) };
          return normalizeWorkflowLocalVideo(rebindGenerationReferences(node));
        }), runs, run: runs[runs.length - 1] ?? null };
        // Loading historical results never authorizes a new generation. Pending turns remain armed.
        this.document.nodes = this.document.nodes.map(node => node.kind === "trigger" && node.inputs.completion?.some(input => input.canvasNodeId)
          ? { ...node, completionSeen: [...new Set([...(node.completionSeen ?? []), ...completedCanvasSessions(node.inputs.completion, canvas.nodes, useStore.getState().genJobs)])] } : node);
        const latest = runs[runs.length - 1];
        this.issue = latest && ["failed", "waiting"].includes(latest.status) ? Object.values(latest.steps).find(step => step.status === "failed" && step.diagnostic)?.diagnostic ?? null : null;
        // Older H3 cards kept completed videos inside the card. Project the existing asset without generating again.
        for (const node of this.document.nodes.filter(node => node.kind === "comfy-video" && !node.resultNodeIds?.length && node.outputs.image?.assetIds?.length === 1)) {
          const run = [...runs].reverse().find(run => run.steps[node.id]?.status === "done" && run.steps[node.id]?.jobId);
          if (!run) continue;
          const [asset] = await api.getAssetsByIds(node.outputs.image!.assetIds!);
          if (asset) await this.deliverMediaAsset(run, node, asset, () => false);
        }
        this.ready = true;
        this.error = "";
        const scheduledNodes = this.document.nodes.map<WorkflowNode>(node => activeTriggerSchedule(node)?.status === "armed" && node.triggerSchedule!.at <= scheduleSessionStartedAt
          ? { ...node, triggerSchedule: node.triggerSchedule!.dailyAt ? advanceTriggerSchedule(node.triggerSchedule!) : { ...node.triggerSchedule!, status: "missed" } } : node);
        if (scheduledNodes.some((node, index) => node !== this.document.nodes[index])) {
          // Persist skipped occurrences before the next daily claim is compared with SQLite.
          await this.save({ ...this.document, nodes: scheduledNodes });
        }
        this.scheduleTriggers();
        this.scheduleSessionCompletions();
      } catch (error) { this.error = String(error); }
      this.emit();
    })();
    return this.loading;
  }
  async save(document = this.document, authorizeEdit = false) {
    if (this.discarded) return;
    if (authorizeEdit) this.pendingEditAuthorization = true;
    document = { ...document, nodes: document.nodes.map(node => this.measuredSizes.has(node.id)
      ? { ...node, layoutSize: this.measuredSizes.get(node.id) } : node) };
    document = { ...document, cardNames: assignCanvasCardNames(document.cardNames, document.nodes.filter(node => !node.textTarget && !node.textSource).map(node => ({ id: node.id, title: workflowTitle(node) }))) };
    this.document = document; this.emit();
    const snapshot = structuredClone(document);
    const base = this.queuedDocument;
    this.queuedDocument = snapshot;
    const write = this.writing.then(async () => {
      if (this.discarded) return;
      if (authorizeEdit) await api.canvasWorkflowAuthorize();
      let merged = mergeWorkflowChanges(base, snapshot, this.persistedDocument);
      let mergeBase = this.persistedDocument, revision = this.revision;
      // A chat turn can append four batches while unrelated runs checkpoint.
      for (let conflicts = 0; ; conflicts++) {
        if (this.discarded) return;
        try {
          this.revision = await api.canvasWorkflowSave(this.projectId, revision, merged);
          break;
        } catch (error) {
          if (!String(error).includes("工作流已被其他窗口修改") || conflicts >= 4) throw error;
          const latest = await api.canvasWorkflowGet(this.projectId);
          merged = mergeWorkflowChanges(mergeBase, merged, latest.document);
          mergeBase = latest.document; revision = latest.revision;
        }
      }
      this.persistedDocument = structuredClone(merged);
      this.document = mergeWorkflowChanges(snapshot, this.document, merged);
      if (this.queuedDocument === snapshot) this.queuedDocument = structuredClone(merged);
    });
    // A failed write blocks later writes and execution until explicitly retried.
    this.writing = write;
    try {
      await write; this.error = "";
      if (this.writing === write) this.pendingEditAuthorization = false;
    }
    catch (error) { this.error = `工作流未保存：${String(error)}`; throw error; }
    finally { this.emit(); this.scheduleSessionCompletions(); this.scheduleTriggers(); }
  }
  async flush() {
    await this.load();
    await this.writing;
    if (this.error) throw new Error(this.error);
  }
  async refreshExternalCards() {
    await this.load();
    if (this.error) throw new Error(this.error);
    let readFailure: { error: unknown } | undefined;
    // A refresh must not replace the merge base of an in-flight save/CAS retry.
    const refresh = this.writing.then(async () => {
      const latest = await api.canvasWorkflowGet(this.projectId).catch(error => { readFailure = { error }; return null; });
      if (!latest || latest.revision <= this.revision) return;
      const document = mergeWorkflowChanges(this.persistedDocument, this.document, latest.document);
      const queued = mergeWorkflowChanges(this.persistedDocument, this.queuedDocument, latest.document);
      this.document = document;
      this.persistedDocument = structuredClone(latest.document);
      this.revision = latest.revision;
      // Rebase queued snapshots without treating unsaved live progress as persisted.
      this.queuedDocument = structuredClone(queued);
    });
    this.writing = refresh;
    try { await refresh; }
    catch (error) { this.error = `工作流未保存：${String(error)}`; throw error; }
    finally { this.emit(); this.scheduleTriggers(); }
    // A transient read failure is reported without blocking unrelated run checkpoints.
    if (readFailure) throw readFailure.error;
  }
  async retrySave() {
    if (!this.ready) { this.loading = null; await this.load(); return; }
    await this.writing.catch(() => {}); this.writing = Promise.resolve();
    this.queuedDocument = structuredClone(this.persistedDocument);
    await this.save(this.document, this.pendingEditAuthorization);
  }
  async edit(nodes: WorkflowNode[], history?: { removedRuns: WorkflowRun[]; runOrder: string[] }) {
    // Moving/removing an existing conversation keeps the composer's access rules.
    // Native workflow_save still authorizes all definition changes and new runs.
    const chatLayout = (node: WorkflowNode) => {
      const { x: _x, y: _y, layoutSize: _size, ...definition } = node;
      return node.kind === "agent" && node.chatConversationId ? definition : node;
    };
    const before = this.document.nodes.filter(node => node.kind !== "text");
    const after = nodes.filter(node => node.kind !== "text");
    const projectionOnly = after.every(node => {
      const previous = before.find(candidate => candidate.id === node.id);
      return previous && JSON.stringify(chatLayout(previous)) === JSON.stringify(chatLayout(node));
    }) && before.every(node => after.some(candidate => candidate.id === node.id) || node.kind === "agent" && !!node.chatConversationId);
    const authorizeEdit = !projectionOnly && (before.length > 0 || after.length > 0);
    if (this.encapsulating) throw new Error("正在封装卡片，请稍后再编辑");
    if (!this.ready) throw new Error("工作流尚未载入");
    nodes = nodes.map(node => this.isLocked(node.id) ? node : normalizeWorkflowLocalVideo(normalizeWorkflowInputSlots(node)));
    for (const node of this.document.nodes) if (this.isLocked(node.id) && JSON.stringify(node) !== JSON.stringify(nodes.find(next => next.id === node.id))) {
      throw new Error("此卡片关联的工作流正在运行，请先停止对应流程");
    }
    const currentRuns = workflowRuns(this.document);
    this.sessionCompletionFailures.clear();
    // Undoing a configuration edit must not replay an already consumed session.
    nodes = nodes.map(node => {
      const previous = this.document.nodes.find(previous => previous.id === node.id);
      const seen = previous?.completionSeen;
      if (node.triggerSchedule?.status === "armed") {
        const consumed = [...currentRuns, ...(history?.removedRuns ?? [])].some(run => run.scheduleId === triggerScheduleOccurrence(node.triggerSchedule!));
        if (node.triggerSchedule.dailyAt && previous?.triggerSchedule?.id === node.triggerSchedule.id && previous.triggerSchedule.at > node.triggerSchedule.at) {
          node = { ...node, triggerSchedule: previous.triggerSchedule };
        } else if (consumed || previous?.triggerSchedule?.id === node.triggerSchedule.id && previous.triggerSchedule.status !== "armed") {
          node = { ...node, triggerSchedule: consumed ? advanceTriggerSchedule(node.triggerSchedule) : { ...node.triggerSchedule, status: previous!.triggerSchedule!.status } };
        } else if (node.triggerSchedule.id !== previous?.triggerSchedule?.id && node.triggerSchedule.at <= Date.now()) {
          node = { ...node, triggerSchedule: node.triggerSchedule.dailyAt ? advanceTriggerSchedule(node.triggerSchedule) : { ...node.triggerSchedule, status: "missed" } };
        }
      }
      return node.kind === "trigger" && (node.completionSeen || seen) ? { ...node,
        completionSeen: [...new Set([...(seen ?? []), ...(node.completionSeen ?? [])])] } : node;
    });
    // Undoing deletion restores its terminal history, retaining newer run states.
    const byId = new Map([...(history?.removedRuns ?? []).filter(run => !workflowRunActive(run)), ...currentRuns].map(run => [run.id, run]));
    const runOrder = new Set([...(history?.runOrder ?? []), ...currentRuns.map(run => run.id)]);
    const runs = [...runOrder].flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
      .filter(run => workflowRunActive(run) || run.order.every(id => nodes.some(node => node.id === id)));
    // Controlled inputs and undo need the edit synchronously; authorize each snapshot in the write queue.
    await this.save({ ...this.document, nodes, runs, run: runs[runs.length - 1] ?? null }, authorizeEdit);
  }
  async encapsulate(name: string, members: string[], bounds: Parameters<typeof api.workflowEncapsulate>[4], template: Parameters<typeof api.workflowEncapsulate>[5]) {
    if (this.encapsulating || !this.ready || this.error) throw new Error("请先完成当前工作流保存");
    if (this.reservations.size || this.executing.size || workflowRuns(this.document).some(workflowRunActive)) throw new Error("请先停止当前运行的工作流再封装");
    this.encapsulating = true;
    try {
      await this.writing;
      const result = await api.workflowEncapsulate(this.projectId, this.revision, name, members, bounds, template);
      this.document = result.document; this.revision = result.revision; this.emit();
      this.persistedDocument = structuredClone(result.document);
      this.queuedDocument = structuredClone(result.document);
      await emit("creative://changed", { projectId: this.projectId }).catch(() => {});
      return result;
    } finally { this.encapsulating = false; }
  }
  async syncCanvasReferences(canvas: Parameters<typeof reconcileCanvasWorkflowReferences>[1]) {
    if (!this.ready) return;
    const nodes = reconcileCanvasWorkflowReferences(this.document.nodes, canvas).map(node => this.isLocked(node.id) ? this.document.nodes.find(current => current.id === node.id)! : node);
    if (JSON.stringify(nodes) !== JSON.stringify(this.document.nodes)) await this.edit(nodes);
    void this.checkSessionCompletions();
    if (!canvas.some(node => node.kind === "note" && node.hiddenAt == null && readCanvasNote(node).cells.flat().some(cell => cell.generation_ref))) return;
    await this.withResource("canvas", async () => {
      const snapshot = await api.projectCanvasGet(this.projectId);
      let changed = false;
      for (const table of snapshot.nodes.filter(node => node.kind === "note" && node.hiddenAt == null)) {
        if (this.isLocked(table.id) || this.document.nodes.some(node => node.textTarget?.nodeId === table.id && this.isLocked(node.id))) continue;
        const note = readCanvasNote(table);
        const next = resolveGenerationCells(note, snapshot.nodes);
        if (next === note) continue;
        await api.projectCanvasNoteUpdate(table.id, JSON.stringify(next));
        changed = true;
      }
      if (changed) await emit("creative://changed", { projectId: this.projectId });
    });
  }
  async bindTextInput(nodeId: string, cellId: string | undefined, source: WorkflowInput, type: "text" | "image") {
    const canvas = await api.projectCanvasGet(this.projectId);
    const target = canvas.nodes.find(node => node.id === nodeId && node.kind === "note" && node.hiddenAt == null);
    if (!target) throw new Error("文本卡片已不存在");
    const note = readCanvasNote(target);
    if (note.note_type !== "text" && note.note_type !== "images") throw new Error("请选择内容卡片");
    const axisMatch = /^(row|column):(.+)$/.exec(cellId ?? "");
    const appendAxis = axisMatch?.[1] as "row" | "column" | undefined;
    const anchorId = axisMatch?.[2];
    if (appendAxis) cellId = undefined;
    const axisRow = note.cells.findIndex(row => row.some(cell => cell.id === anchorId));
    const axisColumn = axisRow < 0 ? -1 : note.cells[axisRow].findIndex(cell => cell.id === anchorId);
    if (appendAxis && axisRow < 0) throw new Error("接收产物的行或列已删除");
    const axisCellIds = appendAxis === "row" ? note.cells[axisRow].map(cell => cell.id!)
      : appendAxis === "column" ? note.cells.map(row => row[axisColumn].id!) : undefined;
    const previous = cellId ? this.document.nodes.find(node => node.textTarget?.nodeId === nodeId && node.textTarget.cellId === cellId) : undefined;
    if (this.document.nodes.some(node => (node.textTarget?.nodeId === nodeId || node.resultNodeIds?.includes(nodeId)) && this.isLocked(node.id))) throw new Error("关联工作流正在运行，请先停止");
    if (cellId && !note.cells.flat().some(cell => cell.id === cellId)) throw new Error("单元格已删除");
    const reuseEmptyCard = !appendAxis && !cellId && note.cells.length === 1 && note.cells[0].length === 1
      && !note.cells[0][0].text && !note.cells[0][0].image_refs?.length
      && !this.document.nodes.some(node => node.textTarget?.nodeId === nodeId);
    const targetCellId = cellId ?? (reuseEmptyCard ? note.cells[0][0].id! : crypto.randomUUID());
    const writer: WorkflowNode = { ...(previous || newWorkflowNode("text", target.x, target.y, "")),
      textTarget: { nodeId, cellId: targetCellId, append: !cellId, image: type === "image", ...(appendAxis ? { appendAxis, axisCellIds } : {}) }, inputs: { [type]: [source] } };
    // Once explicitly wired, this table is edited by cell writers, never rebuilt as an automatic result.
    const nodes = [...this.document.nodes.filter(node => node.id !== writer.id).map(node => ({ ...node,
      ...(node.resultNodeIds?.includes(nodeId) ? { resultNodeIds: node.resultNodeIds.filter(id => id !== nodeId) } : {}),
      ...(cellId && node.textTarget?.nodeId === nodeId && node.textTarget.cellIds?.includes(cellId)
        ? { textTarget: { ...node.textTarget, cellIds: node.textTarget.cellIds.filter(id => id !== cellId) } } : {}),
    })), writer];
    assertWorkflowAcyclic(nodes, writer.id); // Check wiring without validating or running downstream prompts.
    await this.edit(invalidateWorkflow(nodes, writer.id));
    if (!appendAxis) {
      const row = note.cells[0].map((_, column) => ({ ...emptyCanvasCell(), id: column === 0 ? targetCellId : crypto.randomUUID(), content_type: column === 0 ? type : "text" as const }));
      const cells = cellId || reuseEmptyCard ? note.cells.map(row => row.map(cell => cell.id === targetCellId ? { ...cell, content_type: type, generation_ref: undefined } : cell)) : [...note.cells, row];
      await api.projectCanvasNoteUpdate(nodeId, JSON.stringify({ ...note, note_type: "text", cells, row_heights: cellId || reuseEmptyCard ? note.row_heights : [...canvasGridWeights(note.row_heights, note.cells.length), 1], text: cells.map(row => row.map(cell => cell.text).join("\t")).join("\n") }));
      if (type === "image" || !cellId) {
        const minimum = canvasTextMinSize(cells);
        await api.projectCanvasNodeUpdate(nodeId, { x: target.x, y: target.y, width: Math.max(target.width, minimum.width), height: Math.max(target.height, minimum.height), zIndex: target.zIndex, positionLocked: target.positionLocked });
      }
      await emit("creative://changed", { projectId: this.projectId });
    }
    // Binding an available value fills the cell immediately, without running model cards.
    if (!source.nodeId || this.document.nodes.find(node => node.id === source.nodeId)?.outputs[source.portId ?? ""]) await this.start(writer.id, true);
  }

  /** A single gesture produces one durable edit, even when it carries several content types. */
  async connectAutomatic(outputs: AutomaticOutput[], target: { nodeId?: string; canvasNodeId?: string; cellId?: string }, options: { createNodes?: WorkflowNode[] } = {}) {
    return this.withResource("canvas", async () => {
      await this.flush();
      const nativeIds = new Set(outputs.map(({ binding }) => binding.assetNodeId ?? binding.canvasNodeId).filter((id): id is string => !!id));
      if (target.canvasNodeId) nativeIds.add(target.canvasNodeId);
      const trigger = this.document.nodes.find(node => node.id === target.nodeId) ?? options.createNodes?.find(node => node.id === target.nodeId);
      // Only session completion needs older turns and outputs grouped at read time.
      const needsSessions = trigger?.kind === "trigger" && (nativeIds.size > 0 || trigger.inputs.completion?.some(input => input.canvasNodeId));
      const canvasNodes = needsSessions ? (await api.projectCanvasGet(this.projectId)).nodes
        : nativeIds.size ? await api.projectCanvasVisibleNodes(this.projectId, [...nativeIds]) : [];
      const before = structuredClone(this.document);
      const createdNodeIds: string[] = [];
      let nodes = [...this.document.nodes];
      for (const node of options.createNodes ?? []) {
        if (nodes.some(existing => existing.id === node.id)) throw new Error("创建的卡片身份已存在");
        nodes.push(node); createdNodeIds.push(node.id);
      }
      for (const output of outputs) {
        const input = output.binding;
        const sourceId = input.assetNodeId ?? input.canvasNodeId;
        if (sourceId && !canvasNodes.some(node => node.id === sourceId && node.hiddenAt == null)) throw new Error("来源卡片已不存在");
        if (input.nodeId && !nodes.some(node => node.id === input.nodeId)) throw new Error("来源卡片已不存在");
        if ([sourceId, input.nodeId, ...workflowInputProducers(nodes, input)].some(id => id && this.isLocked(id))) throw new Error("关联工作流正在运行，请先停止");
      }
      const connectionId = crypto.randomUUID();
      const changedIds: string[] = [];
      if (target.nodeId) {
        const receiver = nodes.find(node => node.id === target.nodeId);
        if (!receiver) throw new Error("接收卡片已不存在");
        if (this.isLocked(receiver.id)) throw new Error("关联工作流正在运行，请先停止");
        if (receiver.kind === "visual-profile" && receiver.profileId) throw new Error("请先切换到从输入提炼");
        const plan = planAutomaticConnection(nodes, outputs, receiver.id);
        if (plan.error) throw new Error(plan.error);
        if (receiver.kind === "trigger" && plan.bindings.some(({ binding }) => binding.canvasNodeId
          && !canvasNodes.some(node => node.id === binding.canvasNodeId && node.kind === "prompt"))) throw new Error("请连接执行卡片或绘画会话的输出端口");
        const inputs = { ...receiver.inputs };
        for (const item of plan.bindings) {
          const binding: WorkflowInput = { ...item.binding, autoConnect: connectionId };
          const current = inputs[item.inputId] ?? [];
          if (current.some(input => workflowBindingKey(input) === workflowBindingKey(binding))) continue;
          inputs[item.inputId] = [...current, binding];
          changedIds.push(receiver.id);
        }
        if (receiver.kind === "trigger" && workflowTriggerMode(receiver) !== "completion") changedIds.push(receiver.id);
        nodes = nodes.map(node => node.id === receiver.id ? { ...node, inputs,
          ...(receiver.kind === "trigger" ? { triggerMode: "completion" as const, triggerSchedule: undefined,
            completionSeen: [...new Set([...(node.completionSeen ?? []), ...completedCanvasSessions(inputs.completion ?? [], canvasNodes, useStore.getState().genJobs)])] } : {}) } : node);
      } else if (target.canvasNodeId) {
        const card = canvasNodes.find(node => node.id === target.canvasNodeId && node.kind === "note" && node.hiddenAt == null);
        if (!card) throw new Error("接收卡片已不存在");
        const note = readCanvasNote(card);
        if (note.note_type !== "text" && note.note_type !== "images") throw new Error("此卡片不接收内容");
        if (this.isLocked(card.id) || nodes.some(node => node.textTarget?.nodeId === card.id && this.isLocked(node.id))) throw new Error("关联工作流正在运行，请先停止");
        if (outputs.some(output => output.binding.canvasNodeId === card.id || output.binding.assetNodeId === card.id)) throw new Error("不能连接卡片自身");
        const axisMatch = /^(row|column):(.+)$/.exec(target.cellId ?? "");
        const appendAxis = axisMatch?.[1] as "row" | "column" | undefined, anchorId = axisMatch?.[2];
        const cellId = appendAxis ? undefined : target.cellId;
        const axisRow = note.cells.findIndex(row => row.some(cell => cell.id === anchorId));
        if (appendAxis && axisRow < 0) throw new Error("接收产物的行或列已删除");
        const axisColumn = axisRow < 0 ? -1 : note.cells[axisRow].findIndex(cell => cell.id === anchorId);
        const axisCellIds = appendAxis === "row" ? note.cells[axisRow].map(cell => cell.id!)
          : appendAxis === "column" ? note.cells.map(row => row[axisColumn].id!) : undefined;
        const cell = cellId && note.cells.flat().find(cell => cell.id === cellId);
        if (cellId && !cell) throw new Error("接收单元格已删除");
        const compatible = outputs.filter(output => (output.type === "text" || output.type === "image")
          && (!cell || output.type === (cell.content_type ?? "text")) && (note.note_type !== "images" || appendAxis || output.type === "image")
          && (!output.media || (Array.isArray(output.media) ? output.media : [output.media]).some(type => type !== "audio")));
        if (!compatible.length) throw new Error("此卡片没有可接收的内容");
        for (const output of compatible) {
          const sameInput = (node: WorkflowNode) => node.textTarget?.nodeId === card.id
            && (appendAxis ? node.textTarget.appendAxis === appendAxis && contentInputAxisIndex(note, node.textTarget) === (appendAxis === "row" ? axisRow : axisColumn)
              : cellId ? node.textTarget.cellId === cellId : node.textTarget.append && !node.textTarget.appendAxis)
            && (node.inputs[output.type] ?? []).some(input => workflowBindingKey(input) === workflowBindingKey(output.binding));
          if (nodes.some(sameInput)) continue;
          if (cellId && nodes.some(node => node.textTarget?.nodeId === card.id && node.textTarget.cellId === cellId)) throw new Error("此位置已有输入，请先断开原连接");
          const reuseEmpty = !appendAxis && !cellId && note.cells.length === 1 && note.cells[0].length === 1
            && !note.cells[0][0].text && !note.cells[0][0].image_refs?.length && !note.cells[0][0].generation_ref
            && !nodes.some(node => node.textTarget?.nodeId === card.id);
          const writer: WorkflowNode = { ...newWorkflowNode("text", card.x, card.y, ""),
            textTarget: { nodeId: card.id, cellId: cellId ?? (reuseEmpty ? note.cells[0][0].id! : crypto.randomUUID()), append: !cellId, image: output.type === "image", ...(appendAxis ? { appendAxis, axisCellIds } : {}) },
            inputs: { [output.type]: [{ ...output.binding, autoConnect: connectionId, mediaFilter: ["image", "video"] }] } };
          nodes = nodes.map(node => node.resultNodeIds?.includes(card.id) ? { ...node, resultNodeIds: node.resultNodeIds.filter(id => id !== card.id) } : node);
          nodes.push(writer); changedIds.push(writer.id);
        }
      } else throw new Error("请选择接收卡片");
      if (!changedIds.length && !createdNodeIds.length) return { before, after: before, createdNodeIds };
      for (const id of changedIds) assertWorkflowAcyclic(nodes, id);
      for (const id of new Set(changedIds)) nodes = invalidateWorkflow(nodes, id);
      await this.edit(nodes);
      return { before, after: structuredClone(this.document), createdNodeIds };
    });
  }

  async disconnectAutomatic(connectionId: string) {
    return this.withResource("canvas", async () => {
      await this.flush();
      const before = structuredClone(this.document);
      const changed = before.nodes.filter(node => Object.values(node.inputs).flat().some(input => input.autoConnect === connectionId));
      if (changed.some(node => this.isLocked(node.id))) throw new Error("关联工作流正在运行，请先停止");
      let nodes = before.nodes.map(node => ({ ...node, inputs: Object.fromEntries(Object.entries(node.inputs).map(([port, inputs]) =>
        [port, inputs.filter(input => input.autoConnect !== connectionId)])) }));
      for (const node of changed) nodes = invalidateWorkflow(nodes, node.id);
      nodes = nodes.filter(node => !changed.some(item => item.id === node.id) || !node.textTarget || Object.values(node.inputs).some(inputs => inputs.length));
      if (changed.length) await this.edit(nodes);
      return { before, after: structuredClone(this.document) };
    });
  }

  /** Keep a pending turn in a cell; completion only resolves its existing output. */
  async storeCellGeneration(nodeId: string, cellId: string, sessionNodeId: string, outputNodeId?: string) {
    await this.withResource("canvas", async () => {
      if (this.isLocked(nodeId) || this.document.nodes.some(node => (node.textSource === nodeId || node.textTarget?.nodeId === nodeId || node.resultNodeIds?.includes(nodeId)) && this.isLocked(node.id))) throw new Error("关联工作流正在运行，请先停止");
      const canvas = await api.projectCanvasGet(this.projectId);
      const session = canvas.nodes.find(node => node.id === sessionNodeId && node.kind === "prompt" && node.hiddenAt == null);
      if (!session) throw new Error("生成会话已不存在");
      const table = canvas.nodes.find(node => node.id === nodeId && node.kind === "note" && node.hiddenAt == null);
      if (!table) throw new Error("内容卡片已删除");
      const note = readCanvasNote(table);
      if (!["text", "images"].includes(note.note_type) || !note.cells.flat().some(cell => cell.id === cellId)) throw new Error("单元格已删除");
      const cells = note.cells.map(row => row.map(cell => cell.id === cellId ? { ...cell, content_type: "image" as const, text: "", image_refs: [],
        generation_ref: { session_node_id: sessionNodeId, ...(outputNodeId ? { output_node_id: outputNodeId } : {}) } } : cell));
      const next = resolveGenerationCells({ ...note, cells, text: cells.map(row => row.map(cell => cell.text).join("\t")).join("\n") }, canvas.nodes);
      await api.projectCanvasNoteUpdate(nodeId, JSON.stringify(next));
      const minimum = canvasTextMinSize(next.cells);
      if (table.height < minimum.height || table.width < minimum.width) await api.projectCanvasNodeUpdate(nodeId, {
        x: table.x, y: table.y, width: Math.max(table.width, minimum.width), height: Math.max(table.height, minimum.height), zIndex: table.zIndex, positionLocked: table.positionLocked,
      });
      await emit("creative://changed", { projectId: this.projectId });
    });
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

  private writeContentInput(runId: string, writer: WorkflowNode, value: WorkflowValue, halted: () => boolean, sessionId?: string) {
    return this.withResource("canvas", () => this.writeContentInputUnlocked(runId, writer, value, halted, sessionId));
  }
  private async writeContentInputUnlocked(runId: string, writer: WorkflowNode, value: WorkflowValue, halted: () => boolean, sessionId?: string) {
    if (halted()) return;
    const writerStep = this.run(runId).steps[writer.id];
    const savedTarget = sessionId ? writerStep.agentSessionDeliveries?.[sessionId]?.target : writerStep.contentTarget;
    let target = savedTarget ?? this.document.nodes.find(node => node.id === writer.id)?.textTarget ?? writer.textTarget!;
    const canvas = await api.projectCanvasGet(this.projectId);
    if (halted()) return;
    const table = canvas.nodes.find(node => node.id === target.nodeId && node.kind === "note" && node.hiddenAt == null);
    if (!table) throw new Error("输入的内容卡片已删除");
    let note = readCanvasNote(table);
    if (target.appendAxis && !savedTarget) {
      target = { ...target, cellId: crypto.randomUUID(), cellIds: undefined, tableCellIds: undefined, axisOffset: undefined };
    }
    if (target.append && !target.appendAxis) {
      if (!savedTarget) {
        // Only a newly connected, still-empty placeholder can be reused. Each
        // subsequent delivery owns a fresh region, including each loop item.
        const anchor = note.cells.flat().find(cell => cell.id === target.cellId);
        const unused = !target.cellIds?.length && !target.tableCellIds && anchor && !anchor.text && !anchor.image_refs?.length && !anchor.generation_ref;
        if (!unused) target = { nodeId: target.nodeId, cellId: crypto.randomUUID(), append: true, image: target.image, ...(target.automaticImageRelay ? { automaticImageRelay: true } : {}) };
      }
      if (!note.cells.flat().some(cell => cell.id === target.cellId)) {
        const row = note.cells[0].map((_, column) => ({ ...emptyCanvasCell(), id: column === 0 ? target.cellId : crypto.randomUUID() }));
        note = { ...note, cells: [...note.cells, row], row_heights: [...canvasGridWeights(note.row_heights, note.cells.length), 1] };
      }
    }
    if (!target.appendAxis && !note.cells.flat().some(cell => cell.id === target.cellId)) throw new Error("输入的单元格已删除，请重新连接");
    const reserved = this.document.nodes.filter(node => (node.id !== writer.id || !!target.appendAxis && !savedTarget) && node.textTarget?.nodeId === target.nodeId)
      .flatMap(node => [node.textTarget!.cellId, ...(node.textTarget!.cellIds ?? [])]);
    if (value.nodeIds?.some(id => !canvas.nodes.some(node => node.id === id && node.kind === "prompt" && node.hiddenAt == null))) throw new Error("生成会话已不存在，请检查原任务");
    const result = canvasContentInput(note, target, value, reserved);
    result.note = resolveGenerationCells(result.note, canvas.nodes);
    // Persist the destination on this execution step before writing the table.
    // Retries reuse it; a new run/loop item has a new step and appends again.
    const contentTarget = { ...target, cellIds: result.cellIds, tableCellIds: result.tableCellIds,
      ...("axisOffset" in result ? { cellId: result.cellIds[0] ?? target.cellId, axisOffset: result.axisOffset, axisCellIds: result.axisCellIds } : {}) };
    const run = this.run(runId);
    const delivery = sessionId ? { agentSessionDeliveries: { ...run.steps[writer.id].agentSessionDeliveries, [sessionId]: { target: contentTarget } } } : { contentTarget };
    await this.saveRun({ ...run, steps: { ...run.steps, [writer.id]: { ...run.steps[writer.id], ...delivery } } },
      this.document.nodes.map(node => node.id === writer.id ? { ...node, textTarget: contentTarget } : node));
    if (halted()) return;
    await api.projectCanvasNoteUpdate(table.id, JSON.stringify(result.note));
    const minimum = canvasTextMinSize(result.note.cells);
    if (table.height < minimum.height || table.width < minimum.width) await api.projectCanvasNodeUpdate(table.id, {
      x: table.x, y: table.y, width: Math.max(table.width, minimum.width), height: Math.max(table.height, minimum.height), zIndex: table.zIndex, positionLocked: table.positionLocked,
    });
    if (sessionId && !halted()) await this.step(runId, writer.id, { agentSessionDeliveries: {
      ...this.run(runId).steps[writer.id].agentSessionDeliveries, [sessionId]: { target: contentTarget, done: true },
    } });
  }

  async start(startId: string, single = false, background = false) {
    this.issue = null; this.emit();
    try { await this.startRun(startId, single, undefined, background); }
    catch (error) {
      const node = this.document.nodes.find(node => node.id === startId);
      if (node) { this.issue = workflowDiagnostic(error, node, "validation"); this.emit(); }
      throw error;
    }
  }
  private async checkNewSubmission(node: WorkflowNode, chatProvider?: ChatProvider) {
    if (node.kind === "agent" && !chatProvider) {
      const chats = useLocalChatStore.getState().summaries;
      const chat = node.chatConversationId ? chats[node.chatConversationId]
        : Object.values(chats).find(chat => chat.projectId === this.projectId && chat.nodeId === node.id);
      chatProvider = chat?.provider;
    }
    const issue = workflowProviderIssue(node, useStore.getState(), chatProvider);
    if (issue) throw new WorkflowNodeError(issue.message, node);
    if (node.kind === "comfy-video") {
      const options = node.comfyVideo ?? DEFAULT_COMFY_VIDEO;
      const environment = await comfyEnvironment("detect", options.endpoint, undefined, undefined, comfyVideoMode(options));
      if (!comfyEnvironmentReady(environment)) throw new WorkflowNodeError(environment.message || "本地 H3 视频环境尚未就绪。", node);
    }
    if (node.kind === "voice") {
      const environment = await voiceApi.environment();
      if (environment.phase !== "ready") throw new WorkflowNodeError(environment.message || "本机配音环境尚未就绪。", node);
    }
  }
  private async startRun(startId: string, single = false, completionSessionId?: string, background = false, scheduleId?: string) {
    if (this.discarded) return;
    if (this.document.nodes.some(node => node.kind !== "text")) await api.canvasWorkflowAuthorize();
    if (this.encapsulating) throw new Error("正在封装卡片，请稍后再运行");
    if (!this.ready) throw new Error("工作流尚未载入");
    if (this.document.nodes.find(node => node.id === startId)?.kind === "loop") single = false;
    if (this.document.nodes.find(node => node.id === startId)?.kind === "planner") throw new Error("请使用助手的编排按钮；助手不参与工作流执行");
    // A deleted result table may still be used as a relay by downstream cards.
    // Recover whole-output references before removing its writer/provenance.
    const snapshot = await api.projectCanvasGet(this.projectId);
    await this.syncCanvasReferences(snapshot.nodes);
    const liveTables = new Set(snapshot.nodes.filter(node => node.kind === "note" && node.hiddenAt == null).map(node => node.id));
    const recoveryScope = new Set(workflowOrder(this.document.nodes, startId, single));
    const forwardResult = (input: WorkflowInput): WorkflowInput => {
      if (!input.canvasNodeId || liveTables.has(input.canvasNodeId)) return input;
      const automatic = this.document.nodes.find(node => recoveryScope.has(node.id) && node.kind === "instruction" && node.action === "layers"
        && (node.resultNodeIds?.includes(input.canvasNodeId!) || input.canvasNodeId!.startsWith("workflow-layers:") && input.canvasNodeId!.endsWith(`:${node.id}`)));
      const metadata = { slot: input.slot, ...(input.autoConnect ? { autoConnect: input.autoConnect } : {}), ...(input.mediaFilter ? { mediaFilter: input.mediaFilter } : {}),
        ...(input.referenceRanks ? { referenceRanks: input.referenceRanks } : {}) };
      if (automatic && input.cellId === "*") return { nodeId: automatic.id, portId: "image", ...metadata };
      const writers = this.document.nodes.filter(node => node.textTarget?.nodeId === input.canvasNodeId);
      if (writers.length !== 1) return input;
      const writer = writers[0], target = writer.textTarget!;
      const bindings = writer.inputs.image ?? [];
      if (bindings.length !== 1 || !this.document.nodes.some(node => recoveryScope.has(node.id) && node.id === bindings[0].nodeId && node.action === "layers")) return input;
      if (input.cellId === "*" || input.cellId === target.cellId && !target.append) {
        const { autoConnect: _group, mediaFilter: _filter, ...source } = bindings[0];
        return { ...source, ...metadata };
      }
      return input;
    };
    const forwarded = this.document.nodes.map(node => ({ ...node,
      inputs: Object.fromEntries(Object.entries(node.inputs).map(([port, inputs]) => [port, inputs.map(forwardResult)])),
      ...(node.promptReferences ? { promptReferences: node.promptReferences.map(ref => ({ ...ref, input: forwardResult(ref.input) })) } : {}),
    }));
    // Keep every numbered input in place. The consumer resolves its original session,
    // cell or asset and reports a missing source without shifting subsequent references.
    if (JSON.stringify(forwarded) !== JSON.stringify(this.document.nodes)) await this.edit(forwarded);
    // Output writers can survive deletion of a table or an individual cell.
    // Include sibling writers covered by the table's write lock, not just direct image wires.
    const plannedOrder = workflowOrder(this.document.nodes, startId, single);
    const plannedWrites = new Set(workflowWriteNodes(workflowExecutionNodes(this.document.nodes, startId), plannedOrder));
    const writers = this.document.nodes.filter(node => node.id !== startId && plannedWrites.has(node.id) && node.textTarget);
    if (writers.length) {
      const canvas = await api.projectCanvasGet(this.projectId);
      const deleted = new Set(writers.filter(writer => {
        const table = canvas.nodes.find(node => node.id === writer.textTarget!.nodeId && node.kind === "note" && node.hiddenAt == null);
        return !table || (writer.textTarget!.appendAxis ? contentInputAxisIndex(readCanvasNote(table), writer.textTarget!) < 0 : !writer.textTarget!.append && !readCanvasNote(table).cells.flat().some(cell => cell.id === writer.textTarget!.cellId));
      }).map(writer => writer.id));
      if (deleted.size) await this.edit(this.document.nodes.filter(node => !deleted.has(node.id)));
    }
    const order = workflowOrder(this.document.nodes, startId, single);
    const startNode = this.document.nodes.find(node => node.id === startId);
    if (!startNode) throw new Error("卡片不存在");
    const executionNodes = workflowExecutionNodes(this.document.nodes, startId);
    const loop = workflowLoopScope(executionNodes, order);
    const triggerScope = workflowTriggerScope(this.document.nodes, order);
    const textSources = this.document.nodes.filter(node => node.textSource && triggerScope.includes(node.id)).map(node => node.textSource!);
    const lockedNodeIds = workflowDependencies(executionNodes, triggerScope);
    const writeNodeIds = workflowWriteNodes(executionNodes, triggerScope);
    const accesses = [
      ...workflowRuns(this.document).filter(workflowRunActive).map(run => ({
        access: run.lockedNodeIds ?? workflowDependencies(this.document.nodes, run.order),
        writes: run.writeNodeIds ?? workflowWriteNodes(this.document.nodes, run.order),
      })), ...this.reservations.values(),
    ];
    if (accesses.some(item => workflowAccessConflict(lockedNodeIds, writeNodeIds, item.access, item.writes))) {
      if (completionSessionId || scheduleId) return; // Leave the event unconsumed until the downstream cards are free.
      throw new Error("此运行会修改其他工作流正在使用的卡片，请等待对应流程完成");
    }
    const runId = crypto.randomUUID(), threadId = crypto.randomUUID();
    this.reservations.set(runId, { access: lockedNodeIds, writes: writeNodeIds }); this.emit();
    try {
    await this.writing;
    if (scheduleId) {
      const owner = this.document.nodes.find(node => node.id === startId);
      const schedule = owner && activeTriggerSchedule(owner);
      if (!this.triggerTimersEnabled || !schedule || triggerScheduleOccurrence(schedule) !== scheduleId || schedule.status !== "armed" || schedule.at > Date.now()) return;
    }
    if (completionSessionId) {
      const trigger = this.document.nodes.find(node => node.id === startId)!;
      if (workflowTriggerMode(trigger) !== "completion" || !(trigger.triggerCount! > 0) || trigger.completionSeen?.includes(completionSessionId)
        || !completedCanvasSessions(trigger.inputs.completion ?? [], snapshot.nodes, useStore.getState().genJobs).includes(completionSessionId)) return;
    }
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
        if (!table || (writer.textTarget?.appendAxis ? contentInputAxisIndex(readCanvasNote(table), writer.textTarget) < 0 : !writer.textTarget?.append && !readCanvasNote(table).cells.flat().some(cell => cell.id === writer.textTarget?.cellId))) throw new Error("接收产物的内容卡片或单元格已删除，请重新连接输出");
      }
    }
    for (const id of triggerScope) {
      const node = this.document.nodes.find(node => node.id === id)!;
      await this.checkNewSubmission(node);
      if (node.kind === "loop") {
        if (node.loopMode === "count") workflowLoopItems(node, this.document.nodes, []);
        else if (!(node.inputs[node.loopMode === "rows" ? "text" : "image"]?.length)) throw new WorkflowNodeError("请先连接循环的待处理内容", node);
        continue;
      }
      if (node.kind === "trigger") {
        if (!this.document.nodes.some(target => (target.inputs.signal ?? []).some(input => input.nodeId === id))) throw new WorkflowNodeError("触发器还没有连接下游卡片，请从「触发」端口连接", node);
        continue;
      }
      if (node.kind === "generation" && !node.prompt.trim()) throw new WorkflowNodeError("请在生成卡片文本框中填写指令，或通过 @ 引入内容", node);
      if (node.kind === "voice") {
        if (node.voice?.id) {
          if (!node.prompt.trim() && !node.inputs.text?.length) throw new WorkflowNodeError("请输入配音台词或连接文本输入", node);
        } else {
          if (node.inputs.image?.length !== 1) throw new WorkflowNodeError("请选择一段参考录音", node);
          if (!(node.voice?.sampleText ?? defaultVoiceSample).trim()) throw new WorkflowNodeError("请输入试听台词", node);
        }
        continue;
      }
      if (node.kind === "agent" && !node.prompt.trim()) throw new WorkflowNodeError("请在 Agent 卡片中填写要求，可按 @ 引用文字或图片", node);
      if (node.kind === "agent") {
        try { agentOutputTargets(node, this.document.nodes); }
        catch (error) { throw new WorkflowNodeError(String(error instanceof Error ? error.message : error), node); }
      }
      if (node.kind === "instruction" && !(node.inputs.image?.length)) throw new WorkflowNodeError("请先连接指令卡片的图片输入", node);
      if (node.kind === "visual-profile") {
        if (!node.profileId && !node.prompt.trim() && !node.inputs.text?.length && !node.inputs.image?.length) throw new WorkflowNodeError("请给视觉规范卡片连接图片、填写文字，或选用已有规范", node);
      } else if (node.kind !== "instruction" && node.kind !== "text" && !node.prompt.trim() && !node.inputs.text?.length) throw new WorkflowNodeError("请先填写指令或连接文本输入", node);
    }
    const scopeBindings = this.document.nodes.filter(node => triggerScope.includes(node.id)).flatMap(node =>
      Object.values(generationInputNode(node, this.document.nodes).inputs).flat());
    const instanceBindings = scopeBindings.filter(input => input.assetNodeId);
    if (instanceBindings.length) {
      const canvas = await api.projectCanvasGet(this.projectId);
      if (instanceBindings.some(input => !canvas.nodes.some(node => node.id === input.assetNodeId && node.kind === "asset" && node.assetId === input.assetId && node.hiddenAt == null))) {
        throw new Error("连接的画板图片实例已移除，请重新连接");
      }
    }
    const cellBindings = scopeBindings.filter(input => input.canvasNodeId);
    const groupBindings = scopeBindings.filter(input => input.groupId);
    const groupIds = [...new Set(groupBindings.map(input => input.groupId!))];
    const groupAssets = new Map<string, { image: string[]; media: string[] }>();
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
        const media = ids.filter(id => assets.some(asset => asset.id === id && asset.store_path));
        if (!media.length || !images.length && groupBindings.some(input => input.groupId === groupId && !input.autoConnect)) throw new Error("文件夹中没有可用图片，请添加图片后重新运行");
        groupAssets.set(groupId, { image: images, media });
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
    if (loop) {
      const owner = this.document.nodes.find(node => node.id === loop.nodeId)!;
      if (owner.loopMode === "count") loop.items = validateLoopStart(workflowLoopItems(owner, this.document.nodes, []), loop.index, owner);
      else if (owner.loopMode === "rows" && !(owner.inputs.text ?? []).some(input => input.cellId === "*latest" && cellValues[JSON.stringify([input.canvasNodeId, input.cellId])]?.nodeIds?.length)
        && (owner.inputs.text ?? []).every(input => textSources.includes(input.canvasNodeId ?? "")
        || !workflowInputProducers(executionNodes, input).some(id => order.includes(id)))) {
        loop.items = validateLoopStart(workflowLoopRows(owner, this.document.nodes, (await api.projectCanvasGet(this.projectId)).nodes), loop.index, owner);
      }
    }
    await api.projectThreadCreate({ id: threadId, projectId: this.projectId, title: "工作流", origin: "direct" });
    const invalidated = new Set(invalidateWorkflow(executionNodes, startId).filter(node => !Object.keys(node.outputs).length).map(node => node.id));
    const nodes = this.document.nodes.map(node => invalidated.has(node.id) ? { ...node, outputs: {} } : node).map(node => this.isLocked(node.id) && !writeNodeIds.includes(node.id) ? this.document.nodes.find(item => item.id === node.id)! : triggerScope.includes(node.id) ? {
      ...node, ...(node.kind === "generation" ? { activeSessionNodeId: null } : {}), inputs: Object.fromEntries(Object.entries(node.inputs).map(([port, bindings]) => [port, bindings.map(input => input.groupId && groupAssets.has(input.groupId) ? { ...input, assetIds: groupAssets.get(input.groupId)![input.autoConnect ? "media" : "image"] } : input)])),
    } : node).map(node => node.id === startId && completionSessionId ? { ...node, triggerCount: (node.triggerCount ?? 0) - 1,
      completionSeen: [...(node.completionSeen ?? []), completionSessionId] } : node)
      .map(node => node.id === startId && scheduleId ? { ...node, triggerSchedule: advanceTriggerSchedule(node.triggerSchedule!) } : node);
    await this.saveRun({ id: runId, startId, threadId, order, lockedNodeIds, writeNodeIds, cellTexts, cellValues, status: "running",
      ...(single && !background && startNode.kind === "agent" ? { manualCardRun: true as const } : {}),
      ...(scheduleId ? { scheduleId } : {}),
      ...(loop ? { loop } : {}),
      accountId: useStore.getState().cloudAuth?.user_id ?? null,
      steps: Object.fromEntries(order.map(id => [id, { status: "pending" as const }])) }, nodes);
    } finally { this.reservations.delete(runId); this.emit(); }
    const execution = this.continue(runId);
    if (background) void execution.catch(error => { this.error = String(error); this.emit(); });
    else await execution;
  }
  canDiscardLocalVideo(nodeId: string) {
    const node = this.document.nodes.find(node => node.id === nodeId);
    const run = workflowRuns(this.document).find(run => run.status === "waiting" && run.steps[nodeId]?.status === "waiting");
    return node?.kind === "comfy-video" && !!run && !this.executing.has(run.id) && !this.stopping.has(run.id);
  }
  async discardLocalVideo(nodeId: string) {
    if (!this.canDiscardLocalVideo(nodeId)) throw new Error("当前视频仍在处理，请等待进入中断状态后删除");
    const run = workflowRuns(this.document).find(run => run.status === "waiting" && run.steps[nodeId]?.status === "waiting")!;
    // Abandon the local wait only. An unavailable ComfyUI must not block card removal.
    // This is not cancellation confirmation and does not retrieve or import an output.
    this.stopped.add(run.id);
    await this.saveRun({ ...run, status: "stopped", triggerQueue: [] });
  }
  async stop(runId = this.document.run?.id) {
    if (!runId) return;
    if (this.stopping.has(runId)) return;
    this.stopping.add(runId);
    try {
    const localIds = this.document.nodes.filter(node => node.kind === "comfy-video" && ["pending", "running", "waiting"].includes(this.run(runId)?.steps[node.id]?.status)).map(node => node.id);
    for (const id of localIds) {
      this.progress(runId, id, this.run(runId).steps[id].comfyOptimization ? "正在停止提示词优化…" : "正在中断本机生成…");
      this.run(runId).steps[id].comfyStopping = true;
    }
    this.emit();
    this.stopped.add(runId);
    for (const abort of this.profileAbort.get(runId) ?? []) abort.abort();
    const run = this.run(runId);
    if (!run) return;
    const active = Object.values(run.steps).filter(step => step.status === "running" || step.status === "waiting");
    // Keep the definition locked until cancellation requests have completed.
    await Promise.all(active.map(async step => {
      if (step.voiceRequest?.jobId) await voiceApi.cancel(step.voiceRequest.jobId);
      if (step.jobId && step.generationSubmission !== "submitted" && !this.document.nodes.some(node => node.kind === "comfy-video" && run.steps[node.id] === step)) await api.cancelCodexCreate(step.jobId, step.turnKey);
      for (const generation of Object.values(step.localDsGenerations ?? {})) {
        if (!generation.response) await api.cancelCodexCreate(generation.jobId, generation.turnKey);
      }
      if (step.localDsRequestId && step.localAgentTransport === "codex-cli") await api.agentDsWorkflowCancel(step.localDsRequestId);
      if (step.agentRunId) await api.cloudAgentCancel(step.agentRunId);
      if (step.chatInput) {
        const chat = step.chatConversationId ? await localChat.get(step.chatConversationId) : await localChat.getByRequest(step.chatInput.requestId);
        if (chat && localChatRunning(chat)) await useLocalChatStore.getState().stop(chat.id);
      }
      if (step.describeJobIds) await Promise.all(step.describeJobIds.map(jobId => api.cancelCodexDescribe(jobId)));
      if (step.assetId && !step.agentRunId && !step.jobId) {
        const node = this.document.nodes.find(node => run.steps[node.id] === step);
        if (node?.action === "describe" && !step.describeJobIds) await useStore.getState().cancelDescribe(step.assetId);
      }
    }));
    await this.executionDrains.get(runId);
    const cancellationErrors: string[] = [];
    for (const id of localIds) {
      const current = this.run(runId), step = current.steps[id];
      try {
        // Drain any in-flight submission before cancelling its durable request.
        const result = step.jobId ? await comfyVideo("cancel", this.projectId, step.jobId) : { status: "cancelled", message: "已取消，未提交生成" };
        if (result.status !== "cancelled" && result.status !== "done") throw new Error(result.message);
        await this.saveRun({ ...current, steps: { ...current.steps, [id]: { ...step, comfyCancelled: result.status === "cancelled", comfyStopping: false, comfyProgress: undefined, error: undefined, detail: result.message } } });
      } catch (error) {
        await this.saveRun({ ...this.run(runId), status: "waiting", steps: { ...this.run(runId).steps, [id]: { ...step, status: "waiting", comfyStopping: false, comfyProgress: undefined, error: `尚未确认停止：${String(error)}` } } });
        cancellationErrors.push(String(error));
      }
    }
    if (cancellationErrors.length) {
      this.stopped.delete(runId);
      throw new Error(cancellationErrors.join("\n"));
    }
    await this.saveRun({ ...this.run(runId), status: "stopped", triggerQueue: [] });
    } finally { this.stopping.delete(runId); }
  }
  async restartLoop(runId: string) {
    await this.writing;
    const run = this.run(runId), loop = run?.loop;
    if (!loop || run.status !== "stopped" || this.stopping.has(runId) || this.executing.has(runId)) return;
    if (loop.items && (loop.startIndex ?? 0) + loop.completed.length === loop.items.length) return;
    const nodes = workflowExecutionNodes(this.document.nodes, run.startId);
    const order = workflowOrder(this.document.nodes, run.startId);
    const scope = workflowLoopScope(nodes, order);
    if (JSON.stringify(order) !== JSON.stringify(run.order) || JSON.stringify(scope?.bodyIds) !== JSON.stringify(loop.bodyIds)) {
      throw new Error("循环连接已变化，请选择起始项后开始新循环");
    }
    for (const id of loop.bodyIds) await this.checkNewSubmission(this.document.nodes.find(node => node.id === id)!);
    if (this.run(runId) !== run || this.stopping.has(runId) || this.executing.has(runId)) return;
    const scopeIds = workflowTriggerScope(this.document.nodes, order);
    const access = workflowDependencies(nodes, scopeIds), writes = workflowWriteNodes(nodes, scopeIds);
    if (workflowRuns(this.document).filter(workflowRunActive).some(other => workflowAccessConflict(access, writes,
      other.lockedNodeIds ?? workflowDependencies(this.document.nodes, other.order), other.writeNodeIds ?? workflowWriteNodes(this.document.nodes, other.order)))
      || [...this.reservations.values()].some(other => workflowAccessConflict(access, writes, other.access, other.writes))) {
      throw new Error("此运行会修改其他工作流正在使用的卡片，请等待对应流程完成");
    }
    // Explicitly restart the interrupted item, keeping frozen input and completed items.
    const steps = { ...run.steps };
    for (const id of loop.bodyIds) steps[id] = { status: "pending" };
    if (!loop.items) steps[loop.nodeId] = { status: "pending" };
    this.stopped.delete(runId);
    await this.saveRun({ ...run, status: "waiting", steps, lockedNodeIds: access, writeNodeIds: writes }, this.document.nodes.map(node =>
      loop.bodyIds.includes(node.id) ? { ...node, outputs: {}, ...(node.kind === "generation" ? { activeSessionNodeId: null } : {}) }
        : node.id === loop.nodeId && loop.items ? { ...node, outputs: workflowLoopOutputs(loop.items[loop.index], loop.index) } : node));
    await this.continue(runId);
  }
  private async step(runId: string, id: string, patch: Partial<WorkflowStep>) {
    if (this.stopped.has(runId)) throw new Error("工作流已停止");
    const run = this.run(runId);
    const previous = run.steps[id];
    const agentProgress = this.document.nodes.some(node => node.id === id && node.kind === "agent") && patch.detail && patch.detail !== previous.detail
      ? [...(previous.agentProgress ?? []), { text: patch.detail, at: Date.now() }].slice(-100) : previous.agentProgress;
    await this.saveRun({ ...run, steps: { ...run.steps, [id]: { ...previous, ...patch, ...(agentProgress ? { agentProgress } : {}) } } });
    if (this.stopped.has(runId)) throw new Error("工作流已停止");
  }
  async retryLoop(runId: string, confirmedRequestIds?: string[]) {
    if (this.retryingLoops.has(runId)) return;
    this.retryingLoops.add(runId);
    try {
    await this.writing;
    const run = this.run(runId);
    if (!run?.loop || run.status !== "waiting" || this.executing.has(runId) || this.stopping.has(runId)) return;
    const steps = { ...run.steps };
    if (confirmedRequestIds?.some(key => !Object.values(steps).some(step => step.status === "failed" && step.chatInput?.requestId === key))) return;
    const requestIds: string[] = [], cardNames: string[] = [];
    for (const [id, step] of Object.entries(steps)) {
      if (step.status !== "failed") continue;
      let retry = step.retrySafe === true;
      if (step.jobId) {
        const job = (await api.recentGenSessions(500)).find(job => job.id === step.jobId);
        if (!job) throw new Error("无法确认原生成任务状态，请检查任务中心；停止循环后才能重新提交");
        retry = job.status === "failed";
      } else if (step.chatInput) {
        const input = step.chatInput;
        const chat = input.provider === "dsh-local" ? await localChat.getByRequest(input.requestId) : null;
        const turnId = chat?.submittedTurnId;
        if (chat && (chat.projectId !== this.projectId || chat.nodeId !== id
          || chat.provider !== input.provider || !turnId || (step.chatTurnId && step.chatTurnId !== turnId)
          || (step.chatConversationId && step.chatConversationId !== chat.id) || (input.conversationId && input.conversationId !== chat.id))) {
          throw new Error("Agent 回复与原卡片或轮次不匹配");
        }
        if (chat && turnId && terminalDshTurnFailure(chat, turnId, step.confirmedFailedChatTurnId)) {
          await this.checkNewSubmission(this.document.nodes.find(node => node.id === id)!, input.provider);
          const created = (chat.actions ?? []).filter(action => action.turnId === turnId && action.conversationId === chat.id && action.status === "created").flatMap(action => action.cards);
          if (created.length) {
            requestIds.push(input.requestId); cardNames.push(...created.map(card => card.title));
            if (!confirmedRequestIds?.includes(input.requestId)) continue;
          }
          steps[id] = { ...step, status: "waiting", error: undefined, diagnostic: undefined, chatTurnId: undefined,
            confirmedFailedChatTurnId: undefined, chatConversationId: chat.id, chatInput: { ...input, conversationId: chat.id, requestId: crypto.randomUUID() } };
        } else {
          steps[id] = { ...step, status: "waiting", error: undefined, diagnostic: undefined };
        }
        continue;
      } else if (step.localDsRequestId) {
        const result = await api.agentDsWorkflowResult(step.localDsRequestId);
        if (result?.submissionUnknown) throw new Error("Codex CLI 原请求状态未知，请检查原任务；停止循环后才能重新提交");
        retry = !!result?.error;
      } else if (step.agentRunId) {
        const result = await api.cloudAgentGet(step.agentRunId);
        retry = ["failed", "cancelled"].includes(result.status);
      } else if (!retry) {
        throw new Error("此步骤的提交结果尚需核对，请检查原任务；停止循环后才能重新提交，已完成结果会保留");
      }
      if (retry) await this.checkNewSubmission(this.document.nodes.find(node => node.id === id)!);
      steps[id] = retry ? { status: "pending", ...(step.contentTarget ? { contentTarget: step.contentTarget } : {}) } : { ...step, status: "waiting", error: undefined, diagnostic: undefined };
    }
    if (this.run(runId) !== run || this.discarded || this.stopping.has(runId) || this.executing.has(runId)) return;
    if (requestIds.some(key => !confirmedRequestIds?.includes(key))) return { requestIds, cardNames };
    this.issue = null;
    await this.saveRun({ ...run, steps });
    await this.continue(runId);
    } finally { this.retryingLoops.delete(runId); }
  }
  private progress(runId: string, id: string, detail: string, comfyProgress?: import("./comfyVideo").ComfyVideoProgress) {
    if (this.stopped.has(runId)) return;
    const run = this.run(runId);
    const updated = { ...run, steps: { ...run.steps, [id]: { ...run.steps[id], detail, comfyProgress } } };
    const runs = workflowRuns(this.document).map(item => item.id === runId ? updated : item);
    this.document = { ...this.document, runs, run: runs[runs.length - 1] ?? null }; this.emit();
  }
  private async finish(runId: string, node: WorkflowNode, outputs: Record<string, WorkflowValue>, ports = node.outputPorts) {
    if (this.stopped.has(runId)) return;
    const triggers = this.run(runId).completionRecoveryOnly ? [] : workflowCompletionTriggers(this.document.nodes, node.id);
    // A submitted image session is not a completed task. Event receivers wait for its actual result.
    const sessions = Object.values(outputs).filter(value => value.nodeIds?.length);
    if (triggers.length && sessions.length && !await this.resolveInputGenerations(runId, node, structuredClone(sessions), () => this.stopped.has(runId))) return;
    const run = this.run(runId);
    if (run.steps[node.id].status === "done") return;
    await this.saveRun({ ...run, triggerQueue: [...(run.triggerQueue ?? []), ...triggers.map(trigger => trigger.id)], steps: { ...run.steps, [node.id]: { ...run.steps[node.id], ...(node.kind === "agent" ? { agentOutputs: outputs } : {}), status: "done", error: undefined, diagnostic: undefined } } },
      this.document.nodes.map(candidate => candidate.id === node.id ? { ...candidate, outputs, outputPorts: ports } : candidate));
  }

  /** Image consumers wait for the exact submitted turns; cell writers store them immediately. */
  private async resolveInputGenerations(runId: string, node: WorkflowNode, values: WorkflowValue[], halted: () => boolean, started = Date.now(), readLatest?: (canvas: CanvasNode[]) => WorkflowValue[]) {
    await this.step(runId, node.id, { detail: "等待上游生成图片" });
    while (!halted()) {
      const canvas = await api.projectCanvasGet(this.projectId);
      const current = readLatest ? readLatest(canvas.nodes) : values;
      let pending = false;
      const resolved = new Map<string, string[]>();
      for (const id of new Set(current.flatMap(value => value.nodeIds ?? []))) {
        const session = canvas.nodes.find(item => item.id === id && item.kind === "prompt" && item.hiddenAt == null);
        if (!session) throw new Error("上游生成会话已不存在，请检查原任务");
        const status = JSON.parse(session.payloadJson).status;
        if (["failed", "cancelled", "canceled"].includes(status)) throw new Error("上游生成任务未成功，请在原生成会话中查看原因");
        if (status !== "done") { pending = true; continue; }
        const latest = latestWorkflowSessionImage(session, canvas.nodes);
        if (!latest?.assetId) throw new Error("上游生成会话未返回可用图片");
        resolved.set(id, [latest.assetId]);
      }
      if (!pending) {
        for (const value of current) value.assetIds = [...new Set([...(value.assetIds ?? []), ...(value.nodeIds ?? []).flatMap(id => resolved.get(id) ?? [])])];
        return true;
      }
      if (Date.now() - started > 30 * 60 * 1000) {
        await this.step(runId, node.id, { status: "pending", error: "上游图片仍在生成，请稍后继续；不会重新提交生成任务" });
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return false;
  }

  private async chatResult(runId: string, node: WorkflowNode, step: WorkflowStep, halted: () => boolean): Promise<Record<string, WorkflowValue> | null> {
    const store = useLocalChatStore.getState();
    let input = step.chatInput;
    if (!input) {
      if (step.status !== "pending") throw new Error("原 Agent 提交状态未知，请先核对原任务，不能重新提交");
      await store.loadProject(this.projectId);
      const summaries = useLocalChatStore.getState().summaries;
      const existing = node.chatConversationId ? summaries[node.chatConversationId]
        : Object.values(summaries).find(chat => chat.projectId === this.projectId && chat.nodeId === node.id);
      const provider = existing?.provider ?? workflowAgentProvider(node);
      const issue = chatProviderAccessIssue(provider, useStore.getState());
      if (issue) throw new WorkflowNodeError(issue.message, node);
      const run = this.run(runId), snapshot = run.steps[node.id].agentInput!;
      input = { requestId: crypto.randomUUID(), projectId: this.projectId, agentNodeId: node.id,
        ...(run.manualCardRun && run.startId === node.id ? { manualCardRun: true } : {}),
        conversationId: existing?.id ?? node.chatConversationId, provider,
        ...(provider === "dsh-cloud" && node.chatDshSkill ? { dshSkill: node.chatDshSkill } : {}),
        codexOptions: existing ? useLocalChatStore.getState().drafts[existing.id]?.codexOptions ?? existing.codexOptions ?? node.chatCodexOptions : node.chatCodexOptions,
        text: workflowAgentMessage(cloudAgentProfilePrompt(snapshot.prompt, snapshot.visualProfile), snapshot.source),
        referenceAssetIds: snapshot.assetIds,
        cardDefaults: { provider: useStore.getState().activeGenProvider || useStore.getState().defaultProvider, videoChannel: "jimeng", videoOptions: { ...DEFAULT_VIDEO_OPTIONS } },
        placement: { x: node.x, y: node.y, width: workflowCardWidth(node), height: node.layoutSize?.height ?? 330, zIndex: Date.now() % 1000000 } };
      await this.step(runId, node.id, { status: "running", chatInput: input, detail: "正在发送" });
    }
    let chat: ChatConversation | null;
    try {
      chat = await localChat.getByRequest(input.requestId);
      if (halted()) return null;
      if (!chat) chat = await store.send(input); // The persisted native request key makes an uncertain IPC replay safe.
    } catch (error) {
      if (!halted()) await this.step(runId, node.id, { status: "waiting", error: String(error), detail: "等待核对原回复" });
      return null;
    }
    if (chat.projectId !== this.projectId || chat.nodeId !== node.id || !chat.submittedTurnId) throw new Error("Agent 回复与原卡片或轮次不匹配");
    const turnId = chat.submittedTurnId;
    if (halted()) { if (localChatRunning(chat)) await store.stop(chat.id); return null; }
    await this.refreshExternalCards();
    await this.step(runId, node.id, { status: "running", chatConversationId: chat.id, chatTurnId: turnId, detail: "正在回复" });
    for (;;) {
      if (halted()) return null;
      useLocalChatStore.getState().applyConversation(chat);
      const messages = chat.messages.filter(message => message.turnId === turnId && message.role === "assistant");
      if (messages.some(message => ["failed", "interrupted", "stopped"].includes(message.status))) {
        if (chat.messages[chat.messages.length - 1]?.turnId === turnId && cloudChatEndedMessage(chat.error)) throw new Error(chat.error!);
        // A host-confirmed failure is terminal: waiting and re-querying the same turn would keep
        // showing "take back the original reply" for a reply that can never exist.
        if (terminalDshTurnFailure(chat, turnId)) throw new ConfirmedDshTurnFailure(chat.error!, node);
        await this.step(runId, node.id, { status: "waiting", error: (chat.messages[chat.messages.length - 1]?.turnId === turnId && chat.error) || "回复未完成，请打开对话详情取回原回复后继续" });
        return null;
      }
      const outputs = workflowChatOutputs(chat, turnId);
      if (outputs) return outputs;
      await new Promise(resolve => setTimeout(resolve, 1000));
      const current: ChatConversation | null = await store.loadConversation(chat.id).catch(async error => {
        if (!halted()) await this.step(runId, node.id, { status: "waiting", error: String(error), detail: "等待取回原回复" });
        return null;
      });
      if (!current) return null;
      chat = current;
    }
  }

  private async localDsResult(runId: string, node: WorkflowNode, step: WorkflowStep, images: string[], halted: () => boolean): Promise<Record<string, WorkflowValue> | null> {
    const requestId = step.localDsRequestId!;
    const transport = step.localAgentTransport ?? "local-ds";
    const agentName = transport === "codex-cli" ? "Codex CLI" : "Agent DS";
    const videoTask = step.localAgentSkill === "hyperframes";
    while (!halted()) {
      if (!await this.localDsGenerate(runId, node, requestId, images, halted)) return null;
      if (!await this.deliverSubmittedSessions(runId, node, halted)) return null;
      const result = await api.agentDsWorkflowResult(requestId);
      if (halted()) return null;
      if (result) {
        if (result.schemaVersion !== 1 || result.requestId !== requestId) throw new Error(`${agentName} 返回了其他请求的结果`);
        if (result.error) throw new Error(`${agentName} 处理失败：${result.error}（请求 ${requestId}）`);
        const outputs: Record<string, WorkflowValue> = {};
        const sessions = Object.values(this.run(runId).steps[node.id].localDsGenerations ?? {}).flatMap(call => call.response?.submitted ? [call.response.submitted.sessionNodeId] : []);
        if (sessions.length) outputs.image = { type: "image", nodeIds: sessions };
        if (result.text !== undefined) outputs.text = agentResultValue(result.text);
        if (result.images !== undefined && (!Array.isArray(result.images) || !result.images.length || result.images.some(path => typeof path !== "string" || !path.trim()))) throw new Error(`${agentName} 返回图片格式无效`);
        const media = result.videos ?? result.images;
        if (result.videos && (!videoTask || transport !== "codex-cli" || result.videos.length !== 1)) throw new Error("视频交付与当前任务不匹配，请检查原请求");
        if (media?.length) {
          const assets = await api.agentDsWorkflowIngestImages(requestId);
          if (halted()) return null;
          if (assets.length !== media.length) throw new Error(`${agentName} 素材未完整入库，请继续取回原请求`);
          const imageIds = assets.map(asset => asset.id);
          await this.step(runId, node.id, { generatedAssetIds: [...new Set(imageIds)] });
          if (halted()) return null;
          if (result.videos) {
            await this.step(runId, node.id, { videoProjectPath: result.projectPath });
            await this.deliverMediaAsset(this.run(runId), node, assets[0], halted, `workflow-video:${requestId}`);
            if (halted()) return null;
          }
          // Directed results index the outer images array, including duplicate bytes.
          outputs.image = { ...outputs.image, type: "image", assetIds: this.run(runId).steps[node.id].agentOutputTargets?.length ? imageIds : [...new Set(imageIds)] };
        }
        if (!Object.keys(outputs).length) throw new Error(`${agentName} 未返回文字或图片`);
        return outputs;
      }
      // After a reload or failed delivery, Continue only checks the existing request.
      if (step.status === "waiting") {
        await this.step(runId, node.id, { status: "waiting", error: transport === "codex-cli" ? "Codex CLI 尚在处理，请稍后继续取回" : "Agent DS 尚未写回结果；请在 DSH 会话处理队列后继续", detail: `等待本机请求 ${requestId}` });
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return null;
  }

  private async localDsGenerate(runId: string, node: WorkflowNode, requestId: string, inputImages: string[], halted: () => boolean): Promise<boolean> {
    const request = await api.agentDsWorkflowGenerationRequest(requestId);
    if (halted()) return false;
    if (!request) return true;
    const step = this.run(runId).steps[node.id];
    if (!step.localDsImageProvider) throw new Error("此旧 Agent 请求没有默认生图配置，请停止后重新运行卡片");
    let call = step.localDsGenerations?.[request.id];
    if (call && JSON.stringify(call.request) !== JSON.stringify(request)) throw new Error("Agent 生图请求使用相同 id 修改了参数");
    if (!call) {
      const issue = generationProviderIssue(step.localDsImageProvider, useStore.getState());
      if (issue) {
        await api.agentDsWorkflowGenerationResponse(requestId, request, { error: issue.message });
        return true;
      }
      const allowed = new Set([...inputImages, ...Object.values(step.localDsGenerations ?? {}).flatMap(call => call.response?.images ?? [])]);
      if (request.images.some(path => !allowed.has(path))) throw new Error("Agent 生图只能引用本卡片输入或本次已生成的图片");
      const ids = await Promise.all(request.images.map(path => api.localAgentFindAssetId(path)));
      if (ids.some(id => !id)) throw new Error("Agent 生图参考图片已失效");
      const assets = await api.getAssetsByIds(ids as string[]);
      const references = ids.map(id => assets.find(asset => asset.id === id));
      if (references.some(asset => !asset?.store_path)) throw new Error("Agent 生图参考图片已失效");
      if (halted()) return false;
      call = { request, jobId: crypto.randomUUID(), turnKey: crypto.randomUUID() };
      await this.step(runId, node.id, { localDsGenerations: { ...step.localDsGenerations, [request.id]: call }, detail: `Agent 正在使用默认生图引擎 ${step.localDsImageProvider}` });
      // Persist identity before submission. Recovery only queries this job, never submits again.
      const sessionNodeId = `gen-prompt:${call.jobId}:${call.turnKey}:0`;
      if (step.localDsGenerationMode === "session") {
        await this.save({ ...this.document, nodes: this.document.nodes.map(candidate => candidate.id === node.id
          ? { ...candidate, activeSessionNodeId: sessionNodeId, sessionNodeIds: [...(candidate.sessionNodeIds ?? []), sessionNodeId] } : candidate) });
      }
      try {
        if (step.localDsGenerationMode === "session") {
          const result = await useStore.getState().startGeneration(request.prompt, references as NonNullable<typeof references[number]>[], request.ratio,
            step.localDsImageProvider, request.prompt, undefined, undefined, undefined, step.agentInput?.visualProfile?.id ?? null,
            { projectId: this.projectId, threadId: this.run(runId).threadId }, true, undefined, { jobId: call.jobId, turnKey: call.turnKey });
          if (!result.accepted) throw new Error(result.error || "生成任务未提交");
          call = { ...call, response: { submitted: { jobId: call.jobId, turnKey: call.turnKey, sessionNodeId } } };
        } else {
          await api.codexCreateImage({
            jobId: call.jobId, turnKey: call.turnKey, internalAgent: true,
            prompt: request.prompt, promptRaw: request.prompt, referenceImages: request.images, visualProfileId: step.agentInput?.visualProfile?.id ?? null,
            ratio: request.ratio ?? autoRatioFromReferences(references as NonNullable<typeof references[number]>[]), provider: step.localDsImageProvider,
            projectId: this.projectId, threadId: this.run(runId).threadId,
          });
        }
      } catch (error) {
        call = { ...call, response: { error: String(error) } };
      }
    }
    if (halted()) return false;
    if (!call.response) {
      const previous = await api.agentDsWorkflowGenerationJob(call.jobId, call.turnKey);
      if (halted()) return false;
      if (previous && ["failed", "cancelled", "cancelled_local"].includes(previous.status)) call = { ...call, response: { error: previous.error || "默认引擎生图失败" } };
      else if (previous && step.localDsGenerationMode === "session") {
        call = { ...call, response: { submitted: { jobId: call.jobId, turnKey: call.turnKey, sessionNodeId: `gen-prompt:${call.jobId}:${call.turnKey}:0` } } };
      } else if (previous?.status === "done") {
        const images = previous.images;
        if (images.length) call = { ...call, response: { images } };
      }
    }
    if (!call.response) {
      await this.step(runId, node.id, { status: "waiting", error: step.localDsGenerationMode === "session" ? "无法确认原生成任务是否已提交，请检查任务中心后继续；不会重复提交" : "Agent 的原生图任务尚未完成，请稍后继续取回；不会重复提交" });
      return false;
    }
    await this.step(runId, node.id, { localDsGenerations: { ...this.run(runId).steps[node.id].localDsGenerations, [request.id]: call } });
    if (halted()) return false;
    if (!await this.deliverSubmittedSessions(runId, node, halted)) return false;
    try {
      await api.agentDsWorkflowGenerationResponse(requestId, request, call.response);
    } catch (error) {
      if (halted()) return false;
      await this.step(runId, node.id, { status: "waiting", error: `生图结果回传未完成，请继续重试回传：${String(error)}` });
      return false;
    }
    if (!halted()) await this.step(runId, node.id, { detail: call.response.error ? "生图失败，Agent 正在处理反馈" : call.response.submitted ? "生成任务已提交，会话卡片正在生图" : "生图完成，Agent 正在检查和整理结果" });
    return !halted();
  }

  /** Deliver submitted sessions before Agent replies or completion-trigger waits. */
  private async deliverSubmittedSessions(runId: string, node: WorkflowNode, halted: () => boolean): Promise<boolean> {
    const run = this.run(runId), step = run.steps[node.id];
    if (step.agentOutputTargets?.length) return true;
    const sessions = node.kind === "generation" && step.generationSubmission === "submitted" && step.jobId && step.turnKey
      ? [`gen-prompt:${step.jobId}:${step.turnKey}:0`]
      : [...new Set(Object.values(step.localDsGenerations ?? {}).flatMap(call => call.response?.submitted ? [call.response.submitted.sessionNodeId] : []))];
    for (const writer of this.document.nodes.filter(writer => run.order.includes(writer.id) && writer.textTarget?.image
      && writer.inputs.image?.some(input => input.nodeId === node.id && input.portId === "image"))) {
      try {
        if (!writer.textTarget!.append && sessions.length > 1) throw new Error("多个生成结果请连接内容卡行或列图片输入，每个任务占一个单元格");
        for (const sessionId of sessions) {
          if (halted()) return false;
          if (this.run(runId).steps[writer.id].agentSessionDeliveries?.[sessionId]?.done) continue;
          await this.writeContentInput(runId, writer, { type: "image", nodeIds: [sessionId] }, halted, sessionId);
          if (halted()) return false;
          await emit("creative://changed", { projectId: this.projectId });
        }
      } catch (error) {
        if (halted()) return false;
        await this.step(runId, node.id, { status: "waiting", error: `生成会话写入内容卡未完成，请继续补写：${String(error)}` });
        return false;
      }
    }
    return !halted();
  }

  private async writeAgentResult(runId: string, node: WorkflowNode, value: WorkflowValue, hasWriters: boolean, halted: () => boolean) {
    if (!node.resultNodeIds?.length && (hasWriters || !value.table)) return;
    await this.withResource("canvas", async () => {
      if (halted()) return;
      const canvas = await api.projectCanvasGet(this.projectId);
      const table = canvas.nodes.find(item => node.resultNodeIds?.includes(item.id) && item.kind === "note" && item.hiddenAt == null);
      if (!table && (hasWriters || !value.table)) return;
      const id = table?.id ?? `workflow-agent:${runId}:${node.id}`;
      // Persist a stable destination before creating it; recovery can find the same node.
      if (!table) await this.save({ ...this.document, nodes: this.document.nodes.map(item => item.id === node.id ? { ...item, resultNodeIds: [id] } : item) });
      if (halted()) return;
      const previous = table ? readCanvasNote(table) : null;
      const data = value.table ? contentTableRows(value.table) : [[value.text ?? ""]];
      const width = Math.max(data[0].length, previous?.cells[0]?.length ?? 0);
      const height = Math.max(data.length, previous?.cells.length ?? 0);
      const cells = Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => ({
        ...emptyCanvasCell(), ...previous?.cells[r]?.[c], id: previous?.cells[r]?.[c]?.id ?? crypto.randomUUID(),
        content_type: "text" as const, text: data[r]?.[c] ?? "", image_refs: [], bold: !!value.table?.columns && r === 0,
      })));
      const payload = { ...previous, schema_version: 1, note_type: "text", member_ids: [], title: value.table?.title || "Agent 结果",
        cells, text: cells.map(row => row.map(cell => cell.text).join("\t")).join("\n"),
        column_widths: canvasGridWeights(previous?.column_widths, width), row_heights: canvasGridWeights(previous?.row_heights, height) };
      const minimum = canvasTextMinSize(cells);
      if (table) {
        await api.projectCanvasNoteUpdate(table.id, JSON.stringify(payload));
        if (table.width < minimum.width || table.height < minimum.height) await api.projectCanvasNodeUpdate(table.id, {
          x: table.x, y: table.y, width: Math.max(table.width, minimum.width), height: Math.max(table.height, minimum.height), zIndex: table.zIndex, positionLocked: table.positionLocked,
        });
      } else {
        const { x, y } = placeWorkflowOutput(canvas, this.layoutNodes(), node, minimum);
        await api.projectCanvasNodeCreate({ id, projectId: this.projectId, threadId: this.run(runId).threadId, kind: "note", assetId: null, role: null,
          payloadJson: JSON.stringify(payload), x, y, ...minimum, zIndex: Math.max(0, ...canvas.nodes.map(item => item.zIndex)) + 1, positionLocked: true });
      }
      await emit("creative://changed", { projectId: this.projectId });
    });
  }

  /** Deliver an Agent's text into the content cards it is wired to; the writer's own run then
   * rewrites the same slots, so this only moves the landing earlier (idempotent either way). */
  private async writeAgentText(runId: string, node: WorkflowNode, value: WorkflowValue, writers: WorkflowNode[], halted: () => boolean) {
    if (!value.table && !value.text?.trim()) return;
    for (const writer of writers) {
      if (halted()) return;
      await this.writeContentInput(runId, writer, value, halted);
    }
    if (!halted() && writers.length > 1) this.progress(runId, node.id, `已写入 ${writers.length} 张连接的内容卡`);
  }

  private async deliverMediaAsset(run: WorkflowRun, node: WorkflowNode, asset: Asset, halted: () => boolean, resultId = `workflow-comfy:${run.steps[node.id].jobId}`) {
    await this.withResource("canvas", async () => {
      if (halted()) return;
      const canvas = await api.projectCanvasGet(this.projectId);
      if (halted()) return;
      // Stable identity covers a crash between node creation and workflow save; never resurrect deleted results.
      if (!canvas.nodes.some(item => item.id === resultId)) {
        const snapshot = createCanvasAssetSnapshot(asset, resultId);
        const { width, height } = canvasAssetNodeSize(snapshot, 280);
        const current = this.document.nodes.find(item => item.id === node.id) ?? node;
        const position = placeWorkflowOutput(canvas, this.layoutNodes(), current, { width, height });
        await api.projectCanvasNodeCreate({ id: resultId, projectId: this.projectId, threadId: run.threadId,
          kind: "asset", assetId: asset.id, role: "output", payloadJson: JSON.stringify({ ...JSON.parse(assetPayloadJson(snapshot)), workflow_source: node.id }),
          ...position, width, height, zIndex: Math.max(0, ...canvas.nodes.map(item => item.zIndex)) + 1, positionLocked: false });
      }
      if (halted()) return;
      await this.save({ ...this.document, nodes: this.document.nodes.map(item => item.id === node.id ? { ...item, resultNodeIds: [resultId] } : item) });
      await emit("creative://changed", { projectId: this.projectId });
    });
  }

  private async runVoice(runId: string, node: WorkflowNode, halted: () => boolean, values?: Record<string, WorkflowValue[]>) {
    const run = this.run(runId);
    const voice = node.voice ?? {};
    let request: VoiceCardRequest | undefined = run.steps[node.id].voiceRequest;
    const recovering = !!request;
    if (!request) {
      const environment = await voiceApi.environment();
      if (environment.phase !== "ready") throw new Error(environment.message);
      const key = crypto.randomUUID();
      let text = [...(values?.text ?? []).map(value => value.text), node.prompt].filter(Boolean).join("\n").trim();
      let preview: Parameters<typeof voiceApi.start>[3];
      request = { key };
      if (!voice.id) {
        if (run.order.length !== 1) throw new Error("请先为角色声音卡片选择声音");
        const ids = (values?.image ?? []).flatMap(value => value.assetIds ?? []);
        if (ids.length !== 1) throw new Error("请选择一段参考录音");
        const [asset] = await api.getAssetsByIds(ids);
        if (!asset || !isAudioPath(asset.store_path)) throw new Error("请选择音频素材作为参考录音");
        const clip = voiceCardClip(voice, asset);
        text = (voice.sampleText ?? defaultVoiceSample).trim();
        request.previewKey = voiceCardPreviewKey(voice, asset);
        preview = { assetId: asset.id, start: clip.start, end: clip.end, transcript: clip.transcript, draftKey: request.previewKey };
      }
      if (!text) throw new Error(voice.id ? "请输入配音台词" : "请输入试听台词");
      if (halted()) return;
      await this.step(runId, node.id, { status: "running", voiceRequest: request, detail: voice.id ? "正在生成配音" : "正在生成试听" });
      if (halted()) return;
      let jobId: string;
      try { jobId = await voiceApi.start(this.projectId, text, voice.id ?? null, preview, key); }
      catch (error) {
        const snapshot = await voiceApi.snapshot(this.projectId).catch(() => null);
        if (!snapshot) {
          if (!halted()) await this.step(runId, node.id, { status: "waiting", error: "提交状态待确认，点击继续以查询原任务" });
          return;
        }
        const original = snapshot.jobs.find(item => item.request_key === key);
        if (!original) throw error;
        jobId = original.id;
      }
      if (halted()) { await voiceApi.cancel(jobId); return; }
      request = { ...request, jobId };
      await this.step(runId, node.id, { voiceRequest: request });
    }
    let retrySave = recovering;
    while (!halted()) {
      if (run.accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) throw new Error("请登录原账号后继续取回配音");
      let snapshot: Awaited<ReturnType<typeof voiceApi.snapshot>>;
      try { snapshot = await voiceApi.snapshot(this.projectId); }
      catch (error) {
        if (!halted()) await this.step(runId, node.id, { status: "waiting", error: `配音查询中断，可继续查询原任务。${String(error)}` });
        return;
      }
      if (halted()) return;
      const identity: VoiceCardRequest = request;
      const job = snapshot.jobs.find(item => item.id === identity.jobId || item.request_key === identity.key);
      if (!job) { await this.step(runId, node.id, { status: "waiting", error: "尚未找到原配音任务，可继续查询" }); return; }
      if (!request.jobId) {
        request = { ...request, jobId: job.id };
        await this.step(runId, node.id, { voiceRequest: request });
      }
      if (job.status === "succeeded") {
        const asset = snapshot.assets.find(item => item.id === job.asset_id);
        if (!asset) throw new Error("配音素材已移除");
        if (!request.previewKey) {
          try { await this.deliverMediaAsset(this.run(runId), node, asset, halted, `workflow-voice:${job.id}`); }
          catch (error) {
            if (!halted()) await this.step(runId, node.id, { status: "waiting", error: `配音已保存，点击继续添加到画板。${String(error)}` });
            return;
          }
        }
        if (halted()) return;
        await this.step(runId, node.id, { voiceRequest: { ...request, assetId: asset.id } });
        await this.finish(runId, node, request.previewKey ? {} : { image: { type: "image", assetIds: [asset.id] } });
        return;
      }
      if (job.recoverable) {
        if (retrySave) { retrySave = false; await voiceApi.recover(job.id); continue; }
        await this.step(runId, node.id, { status: "waiting", error: "音频已生成，点击继续以重试保存" });
        return;
      }
      if (job.status !== "running") throw new Error(job.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /** Explicit paid text action. It never invalidates outputs or executes connected cards. */
  async optimizeComfyPrompt(nodeId: string) {
    if (!this.ready) throw new Error("工作流尚未载入");
    await api.canvasWorkflowAuthorize();
    await this.writing;
    const node = this.document.nodes.find(node => node.id === nodeId);
    if (node?.kind !== "comfy-video") throw new Error("请选择本地 H3 视频卡片");
    if (this.encapsulating || this.isLocked(nodeId)) throw new Error("卡片正在使用，请等待当前任务结束");
    const prompt = node.prompt.trim(), options = node.comfyVideo ?? DEFAULT_COMFY_VIDEO, mode = comfyVideoMode(options);
    if (!prompt || prompt.length > 16000) throw new Error("请在卡片中填写 1–16000 字提示词后再优化");
    const input = { prompt, mode, seconds: options.seconds, ratio: options.ratio,
      firstFrameCount: mode !== "text" && node.inputs["first-frame"]?.length ? 1 : 0,
      lastFrameCount: mode === "frames" && node.inputs["last-frame"]?.length ? 1 : 0 };
    const runId = crypto.randomUUID(), threadId = crypto.randomUUID(), accountId = useStore.getState().cloudAuth?.user_id ?? null;
    this.reservations.set(runId, { access: [nodeId], writes: [nodeId] }); this.emit();
    try {
      await api.projectThreadCreate({ id: threadId, projectId: this.projectId, title: "H3 提示词优化", origin: "direct" });
      await this.saveRun({ id: runId, startId: nodeId, threadId, order: [nodeId], lockedNodeIds: [nodeId], writeNodeIds: [nodeId], accountId, status: "running",
        steps: { [nodeId]: { status: "pending", comfyOptimization: { input, instruction: h3OptimizationInstruction(input) } } } });
    } finally { this.reservations.delete(runId); this.emit(); }
    await this.continue(runId);
    return runId;
  }

  private async runComfyPromptOptimization(runId: string, node: WorkflowNode, halted: () => boolean) {
    const id = node.id, originalStep = this.run(runId).steps[id];
    const assertAccount = () => {
      const account = useStore.getState();
      if (this.run(runId).accountId !== (account.cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后继续，或停止此工作流");
      if (!canUseComfyVideo(account.cloudAuth, account.cloudEntitlement)) throw new Error("本地 H3 视频需要有效的 Pro／Studio 权益或测试账号资格");
      return account;
    };
    assertAccount();
    let snapshot = originalStep.comfyOptimization;
    if (!snapshot) throw new Error("缺少本次优化输入，请重新点击优化提示词");
    if (!snapshot.result) {
      let terminalFailure = false;
      try {
        let agentRunId = originalStep.agentRunId;
        if (!agentRunId) {
          if (snapshot.submissionStarted) throw new Error("提示词优化提交状态未知，请核对 Agent 任务记录；不会自动重复提交");
          const account = assertAccount();
          if (!account.cloudEntitlement?.is_test_account || !canUseAgentRun(account.cloudEntitlement, "bowerbird-unified-agent")) throw new Error("当前账号尚未开放 Cloud DSH，请使用已获授权的测试账号");
          const active = Object.values(account.cloudAgentRuns).filter(run => !["succeeded", "failed", "cancelled"].includes(run.status)).length;
          if (!canStartAnotherAgentRun(account.cloudEntitlement, active, "bowerbird-unified-agent")) throw new Error("Agent 并发已满，请等待当前任务结束");
          snapshot = { ...snapshot, instruction: h3OptimizationInstruction(snapshot.input), submissionStarted: true };
          await this.step(runId, id, { status: "running", comfyOptimization: snapshot, error: undefined, detail: "提交 H3 提示词优化" });
          if (halted()) return;
          const created = await api.cloudAgentStart({ intentPrompt: snapshot.instruction, textRewrite: { source: snapshot.input.prompt }, references: [],
            projectId: this.projectId, threadId: this.run(runId).threadId, imageProvider: "cloud", skillId: "bowerbird-unified-agent", agentRuntime: "dsh" });
          if (this.stopped.has(runId)) { await api.cloudAgentCancel(created.runId); return; }
          agentRunId = created.runId;
          await this.step(runId, id, { agentRunId, detail: "Cloud DSH 正在优化提示词" });
        }
        while (!halted()) {
          assertAccount();
          const current = await api.cloudAgentGet(agentRunId);
          if (halted()) return;
          assertAccount();
          useStore.getState().openCloudAgentRun(current, { navigate: false });
          if (["failed", "cancelled"].includes(current.status)) { terminalFailure = true; throw new Error(current.snapshot.run.safe_message || "提示词优化未完成，请检查 Agent 任务记录"); }
          if (current.status.startsWith("awaiting_")) { terminalFailure = true; throw new Error("云端未按文本优化模式执行，请检查 Cloud DSH 服务版本"); }
          if (current.status === "succeeded") {
            terminalFailure = true;
            const payload = current.snapshot.events.find(event => event.type === "text.result")?.display_payload;
            if (payload?.schemaVersion !== 1 || typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 16000) throw new Error("Cloud DSH 未返回有效的优化提示词，请检查任务结果");
            const prompt = cleanH3OptimizedPrompt(payload.text);
            if (!prompt) throw new Error("Cloud DSH 未返回有效的优化提示词，请检查任务结果");
            snapshot = { ...snapshot, result: prompt };
            // Save the result before applying it so recovery never repeats the paid request.
            await this.step(runId, id, { comfyOptimization: snapshot });
            break;
          }
          this.progress(runId, id, current.status === "queued" ? "提示词优化排队中" : "Cloud DSH 正在优化提示词");
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (error) {
        if (halted()) return;
        if (terminalFailure || !this.run(runId).steps[id].agentRunId) throw error;
        await this.step(runId, id, { status: "waiting", error: `${String(error)}。可继续查询原优化任务，或停止此工作流。` });
        return;
      }
    }
    if (halted() || !snapshot.result) return;
    assertAccount();
    const run = this.run(runId);
    await this.saveRun({ ...run, steps: { ...run.steps, [id]: { ...run.steps[id], status: "done", error: undefined, detail: "提示词已替换" } } },
      this.document.nodes.map(item => item.id === id ? { ...item, prompt: cleanH3OptimizedPrompt(snapshot.result!) } : item));
  }

  private async runComfyVideo(runId: string, node: WorkflowNode, halted: () => boolean, input?: import("./comfyVideo").ComfyVideoInput) {
    const id = node.id, step = this.run(runId).steps[id], accountId = this.run(runId).accountId;
    let jobId = step.jobId;
    let result: ComfyVideoStatus;
    let terminalFailure = false;
    try {
      if (!jobId) {
        if (step.status !== "pending") throw new Error("上次提交状态未知，请核对本机 ComfyUI 队列");
        if (!input) throw new Error("缺少本地视频输入");
        this.progress(runId, id, "正在准备本机环境…");
        let environment = await comfyEnvironment("prepare", input.endpoint, undefined, undefined, comfyVideoMode(input));
        while (!halted()) {
          if (accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后重新运行");
          if (environment.phase === "ready") break;
          if (environment.phase !== "starting" && environment.phase !== "installing") throw new Error(environment.message);
          this.progress(runId, id, environment.message);
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (halted()) return;
          environment = await comfyEnvironment("status", input.endpoint, undefined, undefined, comfyVideoMode(input));
        }
        if (halted()) return;
        input = { ...input, endpoint: environment.endpoint };
        jobId = crypto.randomUUID();
        await this.step(runId, id, { status: "running", jobId, detail: "正在提交本机视频工作流" });
        if (halted()) return;
        result = await comfyVideo("start", this.projectId, jobId, input);
      } else {
        await this.step(runId, id, { status: "running", error: undefined });
        result = await comfyVideo("status", this.projectId, jobId);
      }
      while (!halted()) {
        if (accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) {
          await this.step(runId, id, { status: "waiting", error: "请登录原账号后继续取回视频" }); return;
        }
        if (result.status === "done" && result.asset) {
          await this.deliverMediaAsset(this.run(runId), node, result.asset, halted);
          if (halted()) return;
          await this.step(runId, id, { detail: comfyVideoElapsed(result.elapsedMs) ? `视频已生成 · 用时 ${comfyVideoElapsed(result.elapsedMs)}` : "视频已生成", error: undefined, comfyProgress: undefined });
          await this.finish(runId, node, { image: { type: "image", assetIds: [result.asset.id] } });
          await emit("creative://changed", { projectId: this.projectId }); return;
        }
        if (result.status === "failed") { terminalFailure = true; throw new Error(result.message); }
        if (result.status === "cancelled") {
          await this.step(runId, id, { comfyCancelled: true, comfyProgress: undefined });
          terminalFailure = true; throw new Error(result.message);
        }
        if (result.status === "unknown") { await this.step(runId, id, { status: "waiting", error: result.message }); return; }
        this.progress(runId, id, result.message, result.progress ?? undefined);
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (halted()) return;
        result = await comfyVideo("status", this.projectId, jobId);
      }
    } catch (error) {
      if (halted()) return;
      if (terminalFailure || !jobId) throw error;
      // Preserve the durable identity on all transport errors. Continue never submits anew.
      await this.step(runId, id, { status: "waiting", comfyProgress: undefined, error: `${String(error)}。可继续查询原任务，或点击停止取消本机生成。` });
    }
  }

  async recoverComfyVideo(runId: string, nodeId?: string) {
    const run = this.run(runId);
    if (!run || run.status !== "stopped" || this.executing.has(runId) || this.stopping.has(runId)) return;
    const node = this.document.nodes.find(node => node.id === (nodeId ?? run.startId));
    if (node?.kind !== "comfy-video" || !run.steps[node.id]?.jobId || run.steps[node.id].comfyCancelled || this.isLocked(node.id)) throw new Error("当前卡片无法取回旧任务");
    await this.saveRun({ ...run, status: "waiting", startId: node.id, order: [node.id], loop: undefined,
      lockedNodeIds: [node.id], writeNodeIds: [node.id], triggerQueue: [], completionRecoveryOnly: true,
      steps: { ...run.steps, [node.id]: { ...run.steps[node.id], status: "waiting", error: undefined } } });
    await this.continue(runId);
  }

  private async recoverVideoResult(runId: string, node: WorkflowNode, halted: () => boolean) {
    const step = this.run(runId).steps[node.id];
    if (!step.jobId || !step.turnKey) throw new Error("原视频任务缺少恢复标识，无法自动取回；可删除此卡片，不会重新提交生成");
    let result;
    try {
      // Query the durable job and turn directly. Recent-session lists omit active and older jobs.
      result = await api.agentDsWorkflowGenerationJob(step.jobId, step.turnKey);
    } catch (error) {
      if (!halted()) await this.step(runId, node.id, { status: "waiting", error: `查询原视频任务失败，请稍后继续取回：${String(error)}` });
      return;
    }
    if (halted()) return;
    if (!result) throw new Error("未找到原视频任务记录，无法自动取回；可删除此卡片，不会重新提交生成");
    if (["failed", "cancelled", "cancelled_local"].includes(result.status)) throw new Error(result.error || (result.status === "failed" ? "原视频任务已失败" : "原视频任务已停止"));
    if (result.status !== "done") {
      await this.step(runId, node.id, { status: "waiting", videoJobActive: true, error: "原视频仍在生成或恢复中，完成后可继续取回。" });
      return;
    }
    const assetIds = await Promise.all(result.images.map(path => api.localAgentFindAssetId(path)));
    if (halted()) return;
    if (!assetIds.length || assetIds.some(id => !id)) throw new Error("原视频任务已结束，但本地结果已缺失；请检查素材库或任务中心，可删除此卡片");
    await this.finish(runId, node, { image: { type: "image", assetIds: [...new Set(assetIds as string[])] } });
  }

  async continue(runId = this.document.run?.id) {
    if (!runId || this.executing.has(runId) || this.stopping.has(runId) || !this.run(runId) || !workflowRunActive(this.run(runId))) return;
    if (this.issue?.runId === runId) this.issue = null;
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
      const storedNode = this.document.nodes.find(node => node.id === id)!;
      const node = storedNode.kind === "trigger" ? { ...storedNode, inputs: {} } : storedNode.kind === "comfy-video" ? generationInputNode(storedNode) : storedNode;
      const step = this.run(runId).steps[id];
      if (step.status === "done" || halted()) return;
      if (node.kind === "voice" && step.voiceRequest) { await this.runVoice(runId, node, halted); return; }
      this.progress(runId, id, node.kind === "generation" ? `生成${node.generation?.media === "video" ? "视频" : "图片"}，等待会话结果` : node.kind === "skill" ? "执行技能，等待任务结果或审批" : node.kind === "visual-profile" ? "处理视觉规范" : node.kind === "trigger" ? "触发下游流程" : "读取输入素材");
      if (node.kind === "comfy-video" && step.jobId) { await this.runComfyVideo(runId, node, halted); return; }
      if (node.kind === "comfy-video" && step.comfyOptimization) { await this.runComfyPromptOptimization(runId, node, halted); return; }
      if (node.kind === "generation" && node.generation?.media === "video" && step.jobId) {
        await this.recoverVideoResult(runId, node, halted); return;
      }
      const frozenChat = node.kind === "agent" && step.chatInput ? step.agentInput : undefined;
      const hasCells = !frozenChat && Object.values(node.inputs).flat().some(input => input.canvasNodeId);
      const cellTexts = this.run(runId).cellTexts;
      let canvas = hasCells || node.kind === "loop" ? await api.projectCanvasGet(this.projectId) : null;
      let refreshedLatest = false;
      const readCell = (nodeId: string, cellId: string) => {
        const frozenSource = this.document.nodes.some(node => node.textSource === nodeId && this.run(runId).order.includes(node.id));
        const producedThisRun = !frozenSource && workflowInputProducers(this.document.nodes, { canvasNodeId: nodeId, cellId }).some(id => this.run(runId).order.includes(id));
        const frozen = this.run(runId).cellValues?.[JSON.stringify([nodeId, cellId])] ?? cellTexts?.[JSON.stringify([nodeId, cellId])];
        if (cellTexts && !producedThisRun && frozen !== undefined && !(refreshedLatest && ["*latest", "*latest-image"].includes(cellId))) return frozen;
        const source = canvas?.nodes.find(candidate => candidate.id === nodeId && candidate.hiddenAt == null);
        return source ? canvasInputValue(source, cellId, canvas!.nodes) : undefined;
      };
      // Latest-row sockets remain dynamic while waiting: a newly appended row
      // replaces the previous candidate for both text and image consumers.
      const connectedNode = generationInputNode(node, this.document.nodes);
      const latestInputs = Object.values(connectedNode.inputs).flat().filter(input => input.canvasNodeId && ["*latest", "*latest-image"].includes(input.cellId ?? ""));
      const latestWaitStarted = Date.now();
      while (!frozenChat && latestInputs.length && !(node.kind === "text" && node.textTarget?.image) && !(node.kind === "loop" && this.run(runId).loop?.items)) {
        const pending = latestInputs.flatMap(input => {
          const value: string | WorkflowValue | undefined = readCell(input.canvasNodeId!, input.cellId!);
          return value && typeof value !== "string" && value.nodeIds?.length ? [value] : [];
        });
        if (!pending.length) break;
        if (!await this.resolveInputGenerations(runId, node, pending, halted, latestWaitStarted, current => latestInputs.flatMap(input => {
          const source = current.find(card => card.id === input.canvasNodeId && card.hiddenAt == null);
          const value: WorkflowValue | undefined = source && canvasInputValue(source, input.cellId!, current);
          return value?.nodeIds?.length ? [value] : [];
        }))) return;
        if (accountId !== undefined && accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后继续，或停止此工作流");
        canvas = await api.projectCanvasGet(this.projectId);
        refreshedLatest = true;
      }
      if (node.kind === "loop") {
        const run = this.run(runId), loop = run.loop;
        if (!loop || loop.nodeId !== id) throw new WorkflowNodeError("请从循环卡片启动完整流程", node);
        let sourceItems = loop.items;
        if (!sourceItems && node.loopMode !== "rows" && node.loopMode !== "count") {
          const values = structuredClone(workflowInputValues(this.document.nodes, node, readCell));
          const pending = values.image.filter(value => value.nodeIds?.length);
          if (pending.length && !await this.resolveInputGenerations(runId, node, pending, halted)) return;
        if (pending.length && accountId !== undefined && accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后继续，或停止此工作流");
          await filterAutomaticMediaValues(node, values);
          await resolveVideoCardOutputs(node, values, canvas?.nodes ?? [], this.projectId, halted);
          if (halted()) return;
          sourceItems = validateLoopItems(values.image.flatMap(value => value.assetIds ?? []).map(assetId => ({ text: "", assetIds: [assetId] })), node);
        }
        const items = validateLoopStart(sourceItems ?? workflowLoopItems(node, this.document.nodes, canvas?.nodes ?? [], readCell), loop.index, node);
        const current = this.run(runId);
        await this.saveRun({ ...current, loop: { ...loop, items }, steps: { ...current.steps, [id]: { status: "done", detail: `第 ${loop.index + 1} / ${items.length} 项` } } },
          this.document.nodes.map(candidate => candidate.id === id ? { ...candidate, outputs: workflowLoopOutputs(items[loop.index], loop.index) } : candidate));
        return;
      }
      const directedValue = agentWriterValue(node, this.document.nodes);
      if (directedValue === null) {
        await this.step(runId, id, { detail: "本次未指定此输出位置，保留原内容" });
        await this.finish(runId, node, {});
        return;
      }
      const values: Record<string, WorkflowValue[]> = frozenChat ? {} : structuredClone(directedValue ? { [directedValue.type]: [directedValue] } : workflowInputValues(this.document.nodes, connectedNode, readCell));
      if (!(node.kind === "text" && node.textTarget?.image)) {
        const pending = Object.values(values).flat().filter(value => value.nodeIds?.length && value.type === "image");
        if (pending.length && !await this.resolveInputGenerations(runId, node, pending, halted)) return;
        if (pending.length && accountId !== undefined && accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后继续，或停止此工作流");
      }
      const inputNode: WorkflowNode = step.localAgentSkill === "hyperframes" ? { ...node, skill: "hyperframes", agentTransport: "codex-cli" } : node;
      await filterAutomaticMediaValues(inputNode, values, this.document.nodes);
      if (node.kind === "voice") { await this.runVoice(runId, node, halted, values); return; }
      if (node.kind === "instruction") {
        const count = (values.image ?? []).flatMap(value => value.assetIds ?? []).length;
        if (node.action === "describe" ? count < 1 : count !== 1) throw new Error("指令卡片的输入图片数量不符合要求");
      }
      await resolveVideoCardOutputs(inputNode, values, canvas?.nodes ?? [], this.projectId, halted, this.document.nodes);
      if (halted()) return;
      const generated = node.kind === "generation" ? compileGenerationPrompt(node, values, this.document.nodes) : null;
      const outputTargets = node.kind === "agent" ? step.agentOutputTargets ?? agentOutputTargets(node, this.document.nodes) : [];
      const agentInput = node.kind === "agent" ? frozenChat ?? compileAgentPrompt(node, values, outputTargets) : null;
      const assetIds = generated?.assetIds ?? step.agentInput?.assetIds ?? agentInput?.assetIds ?? [...new Set([...(values.image ?? []), ...(values.text ?? []), ...(values["first-frame"] ?? []), ...(values["last-frame"] ?? [])].flatMap(value => value.assetIds ?? []))];
      const assets = await api.getAssetsByIds(assetIds);
      const video = node.kind === "generation" && node.generation?.media === "video";
      const acceptsVideo = video || node.kind === "agent" && (node.skill === "hyperframes" || step.localAgentSkill === "hyperframes") || node.kind === "text" && node.textTarget?.image;
      if (assets.length !== assetIds.length || assets.some(asset => !asset.store_path || !acceptsVideo && (asset.duration || isVideoPath(asset.store_path)))) throw new Error("输入素材已丢失或当前卡片仅支持静态图片，请重新选择");
      const orderedAssets = assetIds.map(id => assets.find(asset => asset.id === id)!);
      const prompt = generated?.prompt ?? [...(values.text ?? []).map(value => value.text?.replace(/@图片\d+/g, token => {
        const ref = value.imageRefs?.find(ref => ref.token === token);
        const index = ref ? assetIds.indexOf(ref.asset_id) : -1;
        return index < 0 ? token : `@图片${index + 1}`;
      })), node.prompt].filter(Boolean).join("\n\n").trim();
      const visualProfileId = values["visual-profile"]?.[0]?.profileId ?? null;
      let agentVisualProfile = step.agentInput?.visualProfile ?? null;
      if (visualProfileId && !(node.kind === "agent" && step.agentInput)) {
        const profile = await api.visualProfileGet(visualProfileId);
        if (profile.status !== "confirmed" || profile.version !== values["visual-profile"][0].version) throw new Error("连接的视觉规范已删除或版本不匹配，请重新选择");
        if (node.kind === "agent") agentVisualProfile = profile;
      }
      if (node.kind === "trigger" || node.textSource) {
        await this.finish(runId, node, {});
      } else if (node.kind === "text") {
        const textValue = values.text?.[0];
        const value: WorkflowValue = textValue ?? { type: "image", assetIds, nodeIds: [...new Set((values.image ?? []).flatMap(value => value.nodeIds ?? []))] };
        await this.step(runId, id, { status: "running", detail: textValue ? "写入文本单元格" : "写入图片单元格" });
        // An explicitly empty classification clears that fixed destination, instead of
        // leaving a previous product/copy image visible as if it belonged to this run.
        if (!node.textTarget?.append && value.nodeIds?.length && value.nodeIds.length + (value.assetIds?.length ?? 0) > 1) throw new Error("多个生成结果请连接内容卡行或列图片输入，每个任务占一个单元格");
        const remaining = value.type === "image" ? { ...value, nodeIds: value.nodeIds?.filter(id => !step.agentSessionDeliveries?.[id]?.done) } : value;
        if (remaining.type !== "image" || remaining.assetIds?.length || remaining.nodeIds?.length || !value.nodeIds?.length) {
          await this.writeContentInput(runId, node, directedValue?.type === "image" && !directedValue.assetIds?.length && !directedValue.nodeIds?.length ? { type: "text", text: "" } : remaining, halted);
        }
        if (halted()) return;
        await this.finish(runId, node, { [value.type]: value });
        await emit("creative://changed", { projectId: this.projectId });
      } else if (node.kind === "visual-profile") {
        const inputKey = profileInputKey(assetIds, prompt);
        let profileId = node.profileId || step.profileId || (node.profileCache?.inputKey === inputKey ? node.profileCache.profileId : undefined);
        if (!profileId) {
          if (step.status !== "pending") throw new Error("上次提炼状态未知，请检查已有规范后选择版本，或停止后重新提炼");
          const issue = profileExtractionIssue(useStore.getState());
          if (issue) throw new WorkflowNodeError(issue.message, node);
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
        const instruction = workflowDescribeInstruction(node);
        const cached = assetIds.map(assetId => node.overwriteDescribe ? [] : existingWorkflowCaption(node, assetId, instruction));
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
            const analysisId = await api.describeAsset(assetId, instruction, provider!, jobs[index]!);
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
        // Keep this card's successful batch independently of image history and transient outputs.
        const describeCache = { instruction, results: assetIds.map((assetId, index) => {
          const result = results[index];
          if (result.status !== "fulfilled") throw result.reason;
          return { assetId, sections: result.value };
        }) };
        await this.save({ ...this.document, nodes: this.document.nodes.map(candidate => candidate.id === id ? { ...candidate, describeCache } : candidate) });
        if (halted()) return;
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
          const width = 640, height = 40 + 100 * cells.length;
          const { x, y } = placeWorkflowOutput(canvas, this.layoutNodes(), node, { width, height }, new Set([tableId]));
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
                const width = Math.max(440, minimum.width), height = Math.max(260, minimum.height);
                const { x, y } = placeWorkflowOutput(canvas, this.layoutNodes(), node, { width, height });
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
        const snapshot = step.agentInput ?? { ...agentInput!, visualProfile: agentVisualProfile };
        if (!step.agentInput) await this.step(runId, id, { agentInput: snapshot });
        if (!snapshot.prompt.trim()) throw new WorkflowNodeError("Agent 要求不能为空", node);
        if (outputTargets.length && !step.agentOutputTargets) await this.step(runId, id, { agentOutputTargets: outputTargets });
        let outputs: Record<string, WorkflowValue>;
        if (!step.localDsRequestId && !step.agentRunId) {
          const result = await this.chatResult(runId, node, step, halted);
          if (!result) return;
          outputs = result;
        } else if (step.localDsRequestId) {
          const result = await this.localDsResult(runId, node, step, orderedAssets.map(asset => asset.store_path!), halted);
          if (!result) return;
          outputs = result;
        } else {
        const agentRunId = step.agentRunId!; // Legacy accepted Cloud runs are read only; new turns use localChat.
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
        if (payload?.schemaVersion !== 1 || typeof payload.text !== "string" || !payload.text.trim()) throw new Error("Cloud DSH 未返回有效的改写文本，请检查任务结果或服务版本");
        outputs = { text: agentResultValue(payload.text) };
        }
        outputs = routeAgentOutputs(outputs, outputTargets, orderedAssets.map(asset => asset.id));
        const writers = agentTextWriters(node, this.document.nodes);
        if (!outputTargets.length) {
          // A wired content card is the result's home: write it now so an early stop still
          // leaves the text on the board, and never add a second "Agent 结果" card beside it.
          if (writers.length) await this.writeAgentText(runId, node, outputs.text ?? { type: "text", text: "" }, writers, halted);
          else await this.writeAgentResult(runId, node, outputs.text ?? { type: "text", text: "" }, false, halted);
        }
        if (halted()) return;
        await this.finish(runId, node, outputs);
        await emit("creative://changed", { projectId: this.projectId });
      } else if (node.kind === "comfy-video") {
        const account = useStore.getState();
        if (!canUseComfyVideo(account.cloudAuth, account.cloudEntitlement)) throw new Error("本地 H3 视频需要有效的 Pro／Studio 权益或测试账号资格");
        const first = (values["first-frame"] ?? []).flatMap(value => value.assetIds ?? []);
        const last = (values["last-frame"] ?? []).flatMap(value => value.assetIds ?? []);
        const options = node.comfyVideo ?? DEFAULT_COMFY_VIDEO;
        const mode = comfyVideoMode(options);
        if (mode === "frames" && (first.length !== 1 || last.length > 1)) throw new Error("请连接一张首帧，尾帧最多一张");
        if (mode === "reference" && first.length !== 1) throw new Error("单图模式需要连接一张参考图");
        if (!prompt || prompt.length > 16000) throw new Error("请填写 1–16000 字提示词");
        if (!Number.isFinite(options.seconds) || options.seconds < 1 || options.seconds > 15) throw new Error("视频时长需为 1–15 秒");
        await this.runComfyVideo(runId, node, halted, { ...options, firstFrame: mode === "text" ? "" : first[0], lastFrame: mode === "frames" ? last[0] : undefined, prompt });
      } else if (node.kind === "generation") {
        const generation = video ? { ...node.generation, media: "video" as const, videoOptions: resolveVideoOptions(node.generation?.videoOptions ?? DEFAULT_VIDEO_OPTIONS, orderedAssets) } : undefined;
        const provider = workflowGenerationProvider(node);
        if (!step.jobId) {
          const issue = workflowProviderIssue(node, useStore.getState());
          if (issue) throw new WorkflowNodeError(issue.message, node);
        }
        const ratio = generation ? generation.ratio ?? "16:9" : node.ratio;
        const sessionOutput = !video && (!step.jobId || !!step.generationSubmission);
        if (sessionOutput) {
          let jobId = step.jobId, turnKey = step.turnKey;
          if (!jobId) {
            if (step.status !== "pending") throw new Error("无法确认上次提交状态，请检查任务中心");
            jobId = crypto.randomUUID(); turnKey = crypto.randomUUID();
            const sessionNodeId = `gen-prompt:${jobId}:${turnKey}:0`;
            // Persist both recovery identity and ownership before calling the provider.
            const run = this.run(runId);
            await this.saveRun({ ...run, steps: { ...run.steps, [id]: { ...run.steps[id], status: "running", jobId, turnKey, generationSubmission: "pending" } } },
              this.document.nodes.map(candidate => candidate.id === id ? { ...candidate, activeSessionNodeId: sessionNodeId,
                sessionNodeIds: [...(candidate.sessionNodeIds ?? []), sessionNodeId] } : candidate));
            const result = await useStore.getState().startGeneration(prompt, orderedAssets, ratio, provider, prompt,
              undefined, undefined, undefined, visualProfileId, { projectId: this.projectId, threadId: this.run(runId).threadId }, true, undefined, { jobId, turnKey });
            if (!result.accepted) throw new Error(result.error || "生成任务未提交");
          } else if (step.generationSubmission !== "submitted") {
            if (!turnKey || !await api.agentDsWorkflowGenerationJob(jobId, turnKey)) {
              await this.step(runId, id, { status: "waiting", error: "无法确认原生成任务是否已提交，请检查任务中心后继续；不会重复提交" }); return;
            }
          }
          if (halted()) return;
          if (!turnKey) throw new Error("原生成任务缺少轮次身份，请检查原任务");
          await this.step(runId, id, { generationSubmission: "submitted", detail: "生成任务已提交，图片进度请查看会话" });
          if (!await this.deliverSubmittedSessions(runId, node, halted)) return;
          await this.finish(runId, node, { image: { type: "image", nodeIds: [`gen-prompt:${jobId}:${turnKey}:0`] } });
          return;
        }
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
          if (generation) {
            const error = videoInputError(generation.videoOptions, orderedAssets, ratio, provider);
            if (error) throw new Error(error);
          }
          const identity = { jobId: crypto.randomUUID(), turnKey: crypto.randomUUID() };
          const sessionNodeId = `gen-prompt:${identity.jobId}:${identity.turnKey}:0`;
          await this.save({ ...this.document, nodes: this.document.nodes.map(candidate => candidate.id === id
            ? { ...candidate, activeSessionNodeId: sessionNodeId, sessionNodeIds: [...(candidate.sessionNodeIds ?? []), sessionNodeId] } : candidate) });
          await this.step(runId, id, { status: "running", jobId: identity.jobId, turnKey: identity.turnKey });
          const result = await useStore.getState().startGeneration(prompt, orderedAssets, ratio, provider, prompt,
            undefined, undefined, undefined, visualProfileId, { projectId: this.projectId, threadId: this.run(runId).threadId }, false, generation, identity);
          if (!result.accepted) throw new Error(result.error || "生成未完成");
          const turns = useStore.getState().genJobs[identity.jobId]?.turns ?? [];
          paths = (turns.find(turn => turn.turnKey === identity.turnKey) ?? (turns.length === 1 && !turns[0].turnKey ? turns[0] : undefined))?.images ?? [];
        }
        if (this.stopped.has(runId)) return;
        const assetIds = await Promise.all(paths.map(path => api.localAgentFindAssetId(path)));
        if (!assetIds.length || assetIds.some(id => !id)) {
          await this.step(runId, id, { status: "waiting", error: "本次生成产物尚未入库，请稍后继续取回" }); return;
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
      while (!halted()) {
        const run = this.run(runId);
        const nodes = workflowExecutionNodes(this.document.nodes, run.startId);
        const dependencies = new Map(run.order.map(id => [id, Object.values(nodes.find(node => node.id === id)!.inputs).flat()
          .flatMap(input => workflowInputProducers(nodes, input)).filter(producer => run.order.includes(producer))]));
        const current = this.run(runId), loop = current.loop;
        if (loop?.items && (loop.startIndex ?? 0) + loop.completed.length === loop.index
          && loop.bodyIds.every(id => current.steps[id].status === "done" && !active.has(id))) {
          const completed = [...loop.completed, {
            outputs: Object.fromEntries(loop.bodyIds.map(id => [id, structuredClone(this.document.nodes.find(node => node.id === id)!.outputs)])),
            steps: Object.fromEntries(loop.bodyIds.map(id => [id, structuredClone(current.steps[id])])),
          }];
          const next = loop.index + 1 < loop.items.length;
          const index = next ? loop.index + 1 : loop.index;
          const steps = { ...current.steps, [loop.nodeId]: { status: "done" as const, detail: next ? `第 ${index + 1} / ${loop.items.length} 项` : `已完成 ${completed.length} / ${loop.items.length - (loop.startIndex ?? 0)} 项` } };
          if (next) for (const id of loop.bodyIds) steps[id] = { status: "pending" };
          // Persist the completed item and the next cursor together, before any new submission.
          await this.saveRun({ ...current, loop: { ...loop, index, completed }, steps }, this.document.nodes.map(node =>
            node.id === loop.nodeId ? { ...node, outputs: workflowLoopOutputs(loop.items![index], index) }
              : next && loop.bodyIds.includes(node.id) ? { ...node, outputs: {}, ...(node.kind === "generation" ? { activeSessionNodeId: null } : {}) } : node));
          if (next) for (const id of loop.bodyIds) attempted.delete(id);
          if (halted()) break;
        }
        for (const id of run.order) {
          if (attempted.has(id) || this.run(runId).steps[id].status === "done"
            || !dependencies.get(id)!.every(producer => this.run(runId).steps[producer].status === "done")) continue;
          attempted.add(id);
          const task = execute(id).catch(error => { failures.set(id, error); }).finally(() => { active.delete(id); });
          active.set(id, task);
        }
        if (!active.size) {
          const completed = this.run(runId);
          if (!completed.order.every(id => completed.steps[id].status === "done") || !completed.triggerQueue?.length) break;
          const [triggerId, ...triggerQueue] = completed.triggerQueue;
          const trigger = this.document.nodes.find(node => node.id === triggerId && node.kind === "trigger");
          if (!trigger || workflowTriggerMode(trigger) !== "completion" || !(trigger.triggerCount! > 0)) {
            await this.saveRun({ ...completed, triggerQueue });
            continue;
          }
          currentId = triggerId;
          const order = workflowOrder(this.document.nodes, triggerId);
          if (order.length < 2) throw new WorkflowNodeError("触发器还没有连接下游卡片，请从「触发」端口连接", trigger);
          const executionNodes = workflowExecutionNodes(this.document.nodes, triggerId);
          const loop = workflowLoopScope(executionNodes, order);
          // A receiver may have been connected or armed after the source started.
          // Reserve its current scope before changing order or consuming its budget.
          const scope = workflowTriggerScope(this.document.nodes, order);
          const lockedNodeIds = [...new Set([...(completed.lockedNodeIds ?? completed.order), ...workflowDependencies(executionNodes, scope)])];
          const writeNodeIds = [...new Set([...(completed.writeNodeIds ?? completed.order), ...workflowWriteNodes(executionNodes, scope)])];
          const conflicts = workflowRuns(this.document).filter(other => other.id !== runId && workflowRunActive(other)).some(other =>
            workflowAccessConflict(lockedNodeIds, writeNodeIds, other.lockedNodeIds ?? workflowDependencies(this.document.nodes, other.order),
              other.writeNodeIds ?? workflowWriteNodes(this.document.nodes, other.order)))
            || [...this.reservations.values()].some(other => workflowAccessConflict(lockedNodeIds, writeNodeIds, other.access, other.writes));
          if (conflicts) {
            await this.saveRun({ ...completed, status: "waiting" });
            this.showIssue(workflowDiagnostic(new WorkflowNodeError("触发器下游正在被其他工作流使用，请等待该流程结束后继续；本次触发尚未扣数。", trigger), trigger, "execution", runId));
            return;
          }
          // One save commits the event, decremented budget and fresh task steps before submission.
          await this.saveRun({ ...completed, startId: triggerId, order, loop, triggerQueue, lockedNodeIds, writeNodeIds,
            steps: { ...completed.steps, ...Object.fromEntries(order.map(id => [id, { status: "pending" as const }])) } },
            this.document.nodes.map(node => ({ ...node,
              ...(node.id === triggerId ? { triggerCount: trigger.triggerCount! - 1 } : {}),
              ...(order.includes(node.id) ? { outputs: {}, ...(node.kind === "generation" ? { activeSessionNodeId: null } : {}) } : {}),
            })));
          attempted.clear();
          continue;
        }
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
          steps[id] = { ...steps[id], status: "failed", error: String(reason), ...(run.loop ? { retrySafe: steps[id].status === "pending" || node?.kind === "text" || node?.kind === "loop" } : {}), ...(diagnostic ? { diagnostic } : {}) };
          if (run.loop && reason instanceof ConfirmedDshTurnFailure) steps[id].confirmedFailedChatTurnId = steps[id].chatTurnId;
        }
        this.stopped.add(runId);
        const deliveryFailure = failures.size > 0 && [...failures.keys()].every(id => this.document.nodes.some(node => node.id === id && node.textTarget));
        await this.saveRun({ ...run, status: run.loop || deliveryFailure ? "waiting" : "failed", triggerQueue: run.loop || deliveryFailure ? run.triggerQueue : [], steps }).catch(() => {});
      }
    } finally {
      await Promise.all(active.values());
      this.profileAbort.delete(runId); this.executing.delete(runId);
      this.executionDrains.delete(runId); drained(); this.emit();
    }
  }
}
