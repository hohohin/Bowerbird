import { createWorkflowStepExecutor } from "./executors/workflowStep";
import { WorkflowPersistenceQueue } from "./workflowPersistenceQueue";
import { WorkflowTriggerScheduler } from "./workflowTriggerScheduler";
import { migrateWorkflowDocument } from "./workflowMigrations";
import { assignCanvasCardNames } from "./canvasCardNames";
import { canvasNodePayload } from "./canvasNodePayload";
import { cloudChatEndedMessage, cloudTextRunError } from "./userError";
import { activeTriggerSchedule, advanceTriggerSchedule, triggerScheduleOccurrence, workflowTriggerMode } from "./workflowTriggerSchedule";
import { normalizeWorkflowLocalVideo, workflowNodeRequiresPro, workflowTitle, workflowCardWidth, workflowCompletionTriggers, h3CardDraft, h3DraftForResult, h3OriginalPrompt, h3PromptPatch } from "./canvasWorkflow";
import { isWorkflowProDenied, workflowDefinitionRequiresPro } from "./workflowEntitlement";
import { runWorkflowComfyVideo,
  type WorkflowCardExecution, type WorkflowCardStart as CardStart, type WorkflowImageSessionInput } from "./canvasWorkflowCardExecutors";
import { planAutomaticConnection, contentCardAcceptsMedia, type AutomaticOutput } from "./workflowAutoConnect";
import { isAudioPath } from "./audioMedia";
import { voiceApi } from "./voice";
import { defaultVoiceSample } from "./voiceCard";
import { api } from "./api";
import type { Asset, CanvasNode, GenJob, ProjectCanvasSnapshot } from "./types";
import { firstWorkflowVideoOutputPoint, placeWorkflowOutput } from "./canvasOutputPlacement";
import { assetPayloadJson, canvasAssetNodeSize, createCanvasAssetSnapshot } from "./creativeCanvas";
import { DEFAULT_VIDEO_OPTIONS, isVideoPath } from "./videoGeneration";
import { workflowGenerationProvider, workflowProviderIssue } from "./workflowProviderIssue";
import { selectedChatOptions, chatProviderAccessIssue } from "./chatCapabilities";
import { generationProviderIssue } from "./generationAvailability";
import { autoRatioFromReferences } from "../components/creation/ratios";
import { workflowLoopScope, workflowLoopRows, workflowLoopOutputs, workflowLoopItems, validateLoopStart } from "./workflowLoop";
import { WorkflowPlannerRuntime } from "./workflowPlannerRuntime";
import { emit } from "@tauri-apps/api/event";
import { getWorkflowHost, type WorkflowHostAdapter } from "./workflowHost";
import { canStartAnotherAgentRun, canUseAgentRun } from "./entitlement";
import { readCanvasNote, emptyCanvasCell, canvasGridWeights, canvasTextMinSize } from "./canvasNotes";
import { canvasInputValue, reconcileCanvasWorkflowReferences, resolveGenerationCells, latestWorkflowSessionImage, completedCanvasSessions, submittedTurnState, workflowGenerationActivity, workflowGenerationOrigins } from "./canvasSessionOutputs";
import { canvasConversationCards } from "./canvasConversationCards";
import { canvasContentInput, contentInputAxisIndex } from "./canvasContentInput";
import { agentResultValue } from "./workflowAgentResult";
import { agentChatOptions, localChat, localChatRunning, type ChatConversation, type ChatProvider } from "./localChat";
import { ensureLocalChatEvents, useLocalChatStore } from "./localChatStore";
import { createdChatTurnCards, terminalDshTurnFailure, workflowAgentMessage, workflowAgentProvider, workflowChatOutputs } from "./workflowAgentChat";
import { contentTableRows } from "./contentTable";
import { cloudAgentProfilePrompt } from "./workflowAgentProfile";

import { agentOutputTargets } from "./workflowAgentOutputs";
import { assertWorkflowAcyclic, normalizeWorkflowInputSlots, workflowBindingKey, workflowDisconnectId, workflowCompletionOutput, workflowCompletionTarget, workflowConnectionError } from "./canvasWorkflow";
import { readDismissedNotices, dismissNotices } from "./dismissedNotices";
import { ConfirmedDshTurnFailure, WorkflowNodeError, workflowDiagnostic, type WorkflowDiagnostic } from "./workflowDiagnostics";
import { canUseComfyVideo, comfyEnvironment, comfyEnvironmentReady, comfyVideo, comfyVideoMode, DEFAULT_COMFY_VIDEO, h3R2VInputError, type ComfyVideoInput } from "./comfyVideo";
import { H3_IMAGE, isCloudProvider } from "./genProviders";
import { imageOptimizationText, restoreImageOptimization, restoreH3VideoAudioReference, restoreH3R2VReferences, h3R2VPromptReferences, cleanH3OptimizedPrompt, h3OptimizationInstruction, type H3R2VPromptReferences } from "./h3PromptOptimization";
import { renderGenerationDraft, generationInputNode, emptyWorkflow, newWorkflowNode, invalidateWorkflow, workflowExecutionNodes, workflowExecutionInputs, workflowDependencies, workflowWriteNodes, workflowAccessConflict, workflowLockedNodes, workflowNodeRun, workflowRuns, workflowRunActive, workflowInputProducers, workflowOrder, H3_VIDEO_AUDIO_PORT, H3_R2V_INPUT_PORTS, type CanvasWorkflow, type H3ImageGenerationInput, type WorkflowInput, type WorkflowRun, type WorkflowNode, type WorkflowStep, type WorkflowValue } from "./canvasWorkflow";

export { filterAutomaticMediaValues } from "./canvasWorkflowMediaInputs";

const controllers = new Map<string, CanvasWorkflowController>();
const r2vPorts = Object.values(H3_R2V_INPUT_PORTS);

const scheduleSessionStartedAt = Date.now();
const workflowPollTimeout = 30 * 60_000;
let activeCanvasProject: string | null | undefined;
export function canvasWorkflowController(projectId: string) {
  let controller = controllers.get(projectId);
  if (!controller) {
    controller = new CanvasWorkflowController(projectId);
    if (activeCanvasProject !== undefined) controller.setCanvasActive(activeCanvasProject === projectId);
    controllers.set(projectId, controller);
  }
  return controller;
}

export function setActiveWorkflowCanvas(projectId: string | null) {
  activeCanvasProject = projectId;
  for (const controller of controllers.values()) controller.setCanvasActive(controller.projectId === projectId);
}

export function notifyWorkflowSessionCompletion(projectId: string) {
  controllers.get(projectId)?.notifySessionCompletionChange();
}

export function wakeWorkflowSchedules() {
  for (const controller of controllers.values()) controller.wakeSchedule();
}

/** Includes background projects and image jobs already handed off by their workflow step. */
export function hasRunningLocalGeneration(queuedJobs: Pick<GenJob, "provider" | "running">[] = []) {
  const jobs = [...queuedJobs, ...Object.values(getWorkflowHost().getState().genJobs)];
  if (jobs.some(job => job.running && !isCloudProvider(job.provider))) return true;
  for (const controller of controllers.values()) {
    if (controller.hasRunningGenerationCard(node => node.kind === "comfy-video" || node.kind === "voice"
      || node.kind === "generation" && !isCloudProvider(workflowGenerationProvider(node)))) return true;
  }
  return false;
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
    this.persistence.releaseDraft();
    for (const start of this.startingCards.values()) { start.cancel(); start.release(); }
    for (const run of workflowRuns(this.document)) this.stopped.add(run.id);
    for (const abort of this.executionAborts.values()) abort.abort();
    this.triggerScheduler.discard();
    this.ready = false;
    this.emit();
  }
  readonly planner = new WorkflowPlannerRuntime(this);
  document = emptyWorkflow();
  ready = false;
  private runtimeError = "";
  get error() { return this.persistence.error || this.runtimeError; }
  issue: WorkflowDiagnostic | null = null;
  cardFailure(nodeId: string, run = workflowNodeRun(this.document, nodeId)) {
    const step = run?.steps[nodeId];
    const diagnostic = this.issue?.nodeId === nodeId ? this.issue : step?.status === "failed" ? step.diagnostic : undefined;
    const key = diagnostic?.id ?? (step?.status === "failed" && run ? JSON.stringify([run.id, nodeId]) : undefined);
    return key ? { key, diagnostic, dismissed: readDismissedNotices(`workflow:${this.projectId}`).has(key) } : null;
  }
  dismissCardFailure(key: string) {
    if (this.issue?.id === key) this.issue = null;
    dismissNotices(`workflow:${this.projectId}`, [key]);
    this.emit();
  }
  dismissIssue() { if (this.issue) this.dismissCardFailure(this.issue.id); }
  showIssue(issue: WorkflowDiagnostic) { this.issue = issue; this.emit(); }
  revision = 0;
  private listeners = new Set<(urgent?: boolean, promptEditor?: string) => void>();
  private loading: Promise<void> | null = null;
  private loadAttempt = 0;
  private startingCards = new Map<string, CardStart>();
  private generationHandoffs = new Map<string, { runId: string; jobId: string; turnKey: string }>();
  private liveGenerationCheckpoint = (nodeId: string, run: WorkflowRun) => {
    const step = run.steps[nodeId], handoff = this.generationHandoffs.get(nodeId);
    if (!step) return false;
    if (workflowRunActive(run) && (step.status === "running"
      || run.status === "running" && step.status === "pending" && (run.startId === nodeId || !!step.detail))) return true;
    if (handoff?.runId === run.id && handoff.jobId === step.jobId && handoff.turnKey === step.turnKey) return true;
    if (step.generationSubmission !== "submitted" || !step.jobId || !step.turnKey) return false;
    const job = this.host.getState().genJobs[step.jobId];
    return !!job?.running && job.turns[job.turns.length - 1]?.turnKey === step.turnKey;
  };
  startingAction(nodeId: string) { return this.startingCards.get(nodeId)?.kind; }
  hasRunningGenerationCard(matches: (node: WorkflowNode) => boolean) {
    const runs = workflowRuns(this.document).filter(run => run.status === "running");
    if (!runs.length && !this.startingCards.size) return false;
    return this.document.nodes.some(node => matches(node) && (this.startingAction(node.id) === "run" || runs.some(run => {
      const step = run.steps[node.id];
      if (!step || !run.order.includes(node.id) || (step.comfyOptimization && !step.comfyAutoGeneration)) return false;
      return step.status === "running" || (step.status === "pending" && (run.startId === node.id || !!step.detail));
    })));
  }
  cancelStarting(nodeId: string) { this.startingCards.get(nodeId)?.cancel(); }
  private beginStart(nodeId: string, kind: CardStart["kind"], background = false): CardStart {
    const origin = this.host.getState();
    let cancelled = false;
    let unsubscribe: (() => void) | undefined = this.host.subscribe?.(state => {
      if (origin.cloudAuth?.user_id !== state.cloudAuth?.user_id) cancelled = true;
    });
    const start = { kind, cancel: () => { cancelled = true; }, current: () => {
      const now = this.host.getState();
      return !this.discarded && !cancelled && origin.cloudAuth?.user_id === now.cloudAuth?.user_id
        && (background || origin.activeProjectId === now.activeProjectId && origin.projectRouteRevision === now.projectRouteRevision && !now.projectRoutePending);
    }, release: () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (this.startingCards.get(nodeId) === start) { this.startingCards.delete(nodeId); this.emit(); }
    } };
    this.startingCards.set(nodeId, start); this.emit(true);
    return start;
  }
  private async stopBeforeDispatch(runId: string) {
    this.stopped.add(runId);
    const run = this.run(runId), step = run.steps[run.startId];
    await this.saveRun({ ...run, status: "stopped", triggerQueue: [], steps: { ...run.steps, [run.startId]: {
      ...step, status: "pending", jobId: undefined, generationRunInput: undefined,
      comfyOptimization: step.comfyOptimization && { ...step.comfyOptimization, submissionStarted: false },
    } } });
  }
  private measuredSizes = new Map<string, { width: number; height: number }>();
  measureCard(id: string, width: number, height: number) {
    if (width > 0 && height > 0 && Number.isFinite(width + height)) this.measuredSizes.set(id, { width, height });
  }
  private layoutNodes() {
    return this.document.nodes.map(node => this.measuredSizes.has(node.id) ? { ...node, layoutSize: this.measuredSizes.get(node.id) } : node);
  }
  private encapsulating = false;
  private executing = new Map<string, symbol>();
  private reservations = new Map<string, { access: string[]; writes: string[] }>();
  private stopped = new Set<string>();
  private stopping = new Set<string>();
  private retryingLoops = new Set<string>();
  private executionAborts = new Map<string, AbortController>();
  private executionDrains = new Map<string, Promise<void>>();
  private resources = new Map<string, Promise<unknown>>();
  private async withResource<T>(key: string, work: () => Promise<T>): Promise<T> {
    const task = (this.resources.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    this.resources.set(key, task);
    try { return await task; }
    finally { if (this.resources.get(key) === task) this.resources.delete(key); }
  }
  isLocked(id: string) {
    return !this.document.nodes.some(node => node.id === id && node.kind === "trigger")
      && (workflowLockedNodes(this.document).has(id) || [...this.reservations.values()].some(item => item.access.includes(id)));
  }
  isWriteLocked(id: string) {
    return workflowRuns(this.document).some(run => workflowRunActive(run)
      && (run.writeNodeIds ?? workflowWriteNodes(this.document.nodes, run.order)).includes(id))
      || [...this.reservations.values()].some(item => item.writes.includes(id));
  }
  canEditCompletionSources(id: string) {
    return this.document.nodes.some(node => node.id === id && node.kind === "trigger" && workflowTriggerMode(node) === "completion");
  }
  private run(id: string) { return workflowRuns(this.document).find(run => run.id === id)!; }
  private executionStopped(runId: string, owner: symbol | undefined) {
    return this.discarded || this.stopped.has(runId) || this.executing.get(runId) !== owner;
  }
  private releaseExecution(runId: string, owner: symbol) {
    if (this.executing.get(runId) !== owner) return;
    this.executionAborts.get(runId)?.abort();
    this.executionAborts.delete(runId);
    this.executing.delete(runId);
    this.executionDrains.delete(runId);
  }
  private saveRun(run: WorkflowRun, nodes = this.document.nodes) {
    const runs = workflowRuns(this.document);
    const existing = runs.some(item => item.id === run.id);
    const updated = existing ? runs.map(item => item.id === run.id ? run : item) : [...runs, run];
    // An unaccepted run must not enter another snapshot and be saved by a later edit.
    return this.save({ ...this.document, nodes, runs: updated, run: updated[updated.length - 1] ?? null }, { deferPublication: !existing });
  }
  private readonly triggerScheduler: WorkflowTriggerScheduler;
  private readonly persistence: WorkflowPersistenceQueue;
  constructor(readonly projectId: string, private readonly host: WorkflowHostAdapter = getWorkflowHost()) {
    const controller = this;
    this.triggerScheduler = new WorkflowTriggerScheduler({
      projectId,
      get document() { return controller.document; },
      get genJobs() { return controller.host.getState().genJobs; },
      get ready() { return controller.ready; },
      get discarded() { return controller.discarded; },
      get encapsulating() { return controller.encapsulating; },
      get executing() { return controller.executing.size > 0; },
      get error() { return controller.error; },
      save: document => this.save(document),
      startRun: (...args) => this.startRun(...args),
      showIssue: issue => this.showIssue(issue),
    });
    this.persistence = new WorkflowPersistenceQueue({
      projectId,
      get document() { return controller.document; },
      set document(value) { controller.document = value; },
      get revision() { return controller.revision; },
      set revision(value) { controller.revision = value; },
      get discarded() { return controller.discarded; },
      get error() { return controller.error; },
      liveGenerationCheckpoint: this.liveGenerationCheckpoint,
      changed: promptEditor => this.emit(false, promptEditor),
      saved: (previous, next) => {
        this.runtimeError = "";
        this.triggerScheduler.documentSaved(previous, next);
      },
      writeSettled: promptEditor => {
        this.emit(false, promptEditor);
        this.triggerScheduler.scheduleSessionCompletions();
        this.triggerScheduler.scheduleTriggers();
      },
      refreshed: (previous, next) => this.triggerScheduler.documentRefreshed(previous, next),
      refreshSettled: () => { this.emit(); this.triggerScheduler.scheduleTriggers(); },
    });
  }
  setTriggerTimersEnabled(enabled: boolean) { this.triggerScheduler.setTriggerTimersEnabled(enabled); }
  setCanvasActive(active: boolean) { this.triggerScheduler.setCanvasActive(active); }
  wakeSchedule() { this.triggerScheduler.wakeSchedule(); }
  notifySessionCompletionChange(canvas?: readonly CanvasNode[]) { this.triggerScheduler.notifySessionCompletionChange(canvas); }
  subscribe = (listener: (urgent?: boolean, promptEditor?: string) => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(urgent = false, promptEditor?: string) { for (const listener of this.listeners) listener(urgent, promptEditor); }
  load(provisional = false, canvasRead?: Promise<ProjectCanvasSnapshot>) {
    // Untouched canvases have no database row. Their first edit materializes
    // the project before saving this empty, revision-zero workflow.
    if (provisional && !this.loading) {
      this.loading = Promise.resolve();
      this.ready = true;
      this.runtimeError = "";
      this.emit();
    }
    // A new visit supplies its own canvas read. An older visit's reply must
    // never install its revision after a later visit has started editing.
    if (this.loading && (!canvasRead || this.ready)) return this.loading;
    const attempt = ++this.loadAttempt;
    const stale = () => this.discarded || this.loadAttempt !== attempt;
    this.runtimeError = "";
    this.loading = (async () => {
      try {
        const [snapshot, canvas] = await Promise.all([api.canvasWorkflowGet(this.projectId), canvasRead ?? api.projectCanvasGet(this.projectId)]);
        if (stale()) return;
        if (canvasRead && canvas.canvas.projectId !== this.projectId) throw new Error("画板与当前项目不匹配，请重新加载工作流。");
        this.document = snapshot.document; this.revision = snapshot.revision;
        this.persistence.reset(snapshot.document);
        const migrated = migrateWorkflowDocument(snapshot.document, canvas.nodes, this.host.getState().genJobs);
        this.document = migrated.document;
        this.triggerScheduler.initHistory(migrated.historicalSessionCompletions);
        const { latestIssue } = migrated;
        this.issue = latestIssue && !readDismissedNotices(`workflow:${this.projectId}`).has(latestIssue.id) ? latestIssue : null;
        const runs = workflowRuns(this.document);
        // Older H3 cards kept completed videos inside the card. Project the existing asset without generating again.
        for (const node of this.document.nodes.filter(node => node.kind === "comfy-video" && !node.activeSessionNodeId && !node.resultNodeIds?.length && node.outputs.image?.assetIds?.length === 1)) {
          const run = [...runs].reverse().find(run => run.steps[node.id]?.status === "done" && run.steps[node.id]?.jobId);
          if (!run) continue;
          const [asset] = await api.getAssetsByIds(node.outputs.image!.assetIds!);
          if (stale()) return;
          if (asset) await this.deliverMediaAsset(run, node, asset, stale);
        }
        if (stale()) return;
        this.ready = true;
        this.runtimeError = "";
        const scheduledNodes = this.document.nodes.map<WorkflowNode>(node => activeTriggerSchedule(node)?.status === "armed" && node.triggerSchedule!.at <= scheduleSessionStartedAt
          ? { ...node, triggerSchedule: node.triggerSchedule!.dailyAt ? advanceTriggerSchedule(node.triggerSchedule!) : { ...node.triggerSchedule!, status: "missed" } } : node);
        if (scheduledNodes.some((node, index) => node !== this.document.nodes[index])) {
          // Persist skipped occurrences before the next daily claim is compared with SQLite.
          await this.save({ ...this.document, nodes: scheduledNodes });
        }
        this.triggerScheduler.scheduleTriggers();
        this.notifySessionCompletionChange(canvas.nodes);
      } catch (error) { if (!stale()) this.runtimeError = String(error); }
      this.emit();
    })();
    this.emit();
    return this.loading;
  }
  async save(document = this.document, { authorizeEdit = false, draftNodeId, editorOnly, deferPublication }:
    { authorizeEdit?: boolean; draftNodeId?: string; editorOnly?: boolean; deferPublication?: boolean } = {}) {
    if (this.discarded) return;
    document = { ...document, nodes: document.nodes.map(node => {
      const size = this.measuredSizes.get(node.id);
      return size && (node.layoutSize?.width !== size.width || node.layoutSize.height !== size.height) ? { ...node, layoutSize: size } : node;
    }) };
    document = { ...document, cardNames: assignCanvasCardNames(document.cardNames, document.nodes.filter(node => !node.textTarget && !node.textSource).map(node => ({ id: node.id, title: workflowTitle(node) }))) };
    return this.persistence.save(document, authorizeEdit, draftNodeId, editorOnly, deferPublication);
  }
  async flush() {
    await this.load();
    await this.waitForWrites();
  }
  private async waitForWrites() {
    await this.persistence.settle();
    if (this.error) throw new Error(this.error);
  }
  async refreshExternalCards() {
    await this.load();
    if (!this.ready && this.error) throw new Error(this.error);
    await this.persistence.refresh();
  }
  retryLoad() {
    if (!this.ready && this.error) this.loading = null;
    return this.load();
  }
  async retrySave() {
    if (!this.ready) { await this.retryLoad(); return; }
    this.persistence.releaseDraft();
    await this.persistence.settle();
    await this.save(this.document);
  }
  async edit(nodes: WorkflowNode[], history?: { removedRuns: WorkflowRun[]; runOrder: string[] }, draftNodeId?: string, editorOnly = false) {
    if (this.encapsulating) throw new Error("正在封装卡片，请稍后再编辑");
    if (!this.ready) throw new Error("工作流尚未载入");
    if (editorOnly && draftNodeId) {
      const edited = nodes.find(node => node.id === draftNodeId);
      const current = this.document.nodes.find(node => node.id === draftNodeId);
      if (current?.kind === "comfy-video" && edited) {
        if (this.isLocked(draftNodeId)) throw new Error("此卡片关联的工作流正在运行，请先停止对应流程");
        // Only the prompt can change here. Structural validation and trigger
        // reconciliation belong to edits that can actually change those fields.
        const updated = this.document.nodes.map(node => node === current ? { ...node, prompt: edited.prompt } : node);
        await this.save({ ...this.document, nodes: updated }, { authorizeEdit: true, draftNodeId, editorOnly: true });
        return;
      }
    }
    const authorizeEdit = workflowDefinitionRequiresPro(this.document.nodes, nodes);
    const previousById = new Map(this.document.nodes.map(node => [node.id, node]));
    const nodeIds = new Set(nodes.map(node => node.id));
    const locked = workflowLockedNodes(this.document);
    for (const reservation of this.reservations.values()) for (const id of reservation.access) locked.add(id);
    const previousH3 = new Map(this.document.nodes.filter(node => node.kind === "comfy-video").map(node => [node.id, comfyVideoMode(node.comfyVideo)]));
    nodes = nodes.map(node => {
      if (previousById.get(node.id)?.kind !== "trigger" && locked.has(node.id)) return node;
      if (!authorizeEdit && workflowNodeRequiresPro(node)) {
        // References keep their existing selectors. Input positions may close
        // up after detaching a wire; no prompt or model fields need rewriting.
        return { ...node, inputs: normalizeWorkflowInputSlots(node).inputs };
      }
      const normalized = normalizeWorkflowLocalVideo(normalizeWorkflowInputSlots(node));
      if (normalized.kind !== "comfy-video" || previousH3.get(node.id) === comfyVideoMode(normalized.comfyVideo)) return normalized;
      const active = workflowExecutionInputs(normalized);
      const ports = comfyVideoMode(normalized.comfyVideo) === "r2v" ? r2vPorts : [H3_VIDEO_AUDIO_PORT, "first-frame", "last-frame"];
      // A parked connection's source may have been removed since it was last active.
      return { ...normalized, inputs: { ...normalized.inputs, ...Object.fromEntries(ports.flatMap(port => active[port]
        ? [[port, active[port].filter(binding => !binding.nodeId || nodeIds.has(binding.nodeId))]] : [])) } };
    });
    for (const node of nodes) {
      if (node.kind !== "comfy-video" || previousH3.get(node.id) === comfyVideoMode(node.comfyVideo)
        || !Object.values(workflowExecutionInputs(node)).some(bindings => bindings.some(input => input.nodeId || input.canvasNodeId))) continue;
      // A parked wire can become cyclic while the card uses a different provider.
      try { assertWorkflowAcyclic(nodes, node.id, true); }
      catch { throw new WorkflowNodeError("参考素材连线会形成循环，请断开回路上的连线后再切换 H3 模式", node); }
    }
    const nextById = new Map(nodes.map(node => [node.id, node]));
    for (const node of this.document.nodes) if (node.kind !== "trigger" && locked.has(node.id)) {
      const next = nextById.get(node.id);
      if (node === next || JSON.stringify(node) === JSON.stringify(next)) continue;
      if (next) {
        // The signal socket and winding key control future starts only.
        const definition = (card: WorkflowNode) => ({ ...card, trigger: undefined, inputs: { ...card.inputs, signal: undefined } });
        if (JSON.stringify(definition(node)) === JSON.stringify(definition(next))) continue;
      }
      throw new Error("此卡片关联的工作流正在运行，请先停止对应流程");
    }
    const currentRuns = workflowRuns(this.document);
    this.triggerScheduler.clearFailures();
    // Undoing a configuration edit must not replay an already consumed session.
    nodes = nodes.map(node => {
      const previous = previousById.get(node.id);
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
    const deletedTriggers = new Set(this.document.nodes.filter(node => node.kind === "trigger" && !nodeIds.has(node.id)).map(node => node.id));
    const runs = [...runOrder].flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
      .map(run => {
        if (!run.order.some(id => deletedTriggers.has(id)) && !deletedTriggers.has(run.startId)) return run;
        const order = run.order.filter(id => !deletedTriggers.has(id));
        const startId = deletedTriggers.has(run.startId) ? order[0] ?? run.startId : run.startId;
        return { ...run, startId, order, scheduleId: startId === run.startId && !deletedTriggers.has(startId) ? run.scheduleId : undefined,
          lockedNodeIds: run.lockedNodeIds?.filter(id => !deletedTriggers.has(id)), writeNodeIds: run.writeNodeIds?.filter(id => !deletedTriggers.has(id)) };
      })
      .filter(run => workflowRunActive(run) || run.order.every(id => nodeIds.has(id)))
      .flatMap(run => {
        if (!run.triggerQueue?.length) return [run];
        const triggerQueue = run.triggerQueue.filter(id => nodeIds.has(id));
        if (triggerQueue.length === run.triggerQueue.length) return [run];
        if (run.order.length) return [{ ...run, triggerQueue }];
        if (triggerQueue.length) return [{ ...run, triggerQueue, startId: triggerQueue[0] }];
        return run.scheduleId && !nodeIds.has(run.startId) ? []
          : [{ ...run, triggerQueue, status: "stopped" as const }];
      });
    await this.save({ ...this.document, nodes, runs, run: runs[runs.length - 1] ?? null }, { authorizeEdit, draftNodeId, editorOnly });
  }
  async encapsulate(name: string, members: string[], bounds: Parameters<typeof api.workflowEncapsulate>[4], template: Parameters<typeof api.workflowEncapsulate>[5]) {
    if (this.encapsulating || !this.ready || this.error) throw new Error("请先完成当前工作流保存");
    if (this.reservations.size || this.executing.size || workflowRuns(this.document).some(workflowRunActive)) throw new Error("请先停止当前运行的工作流再封装");
    this.encapsulating = true;
    try {
      await this.waitForWrites();
      const result = await api.workflowEncapsulate(this.projectId, this.revision, name, members, bounds, template);
      this.document = result.document; this.revision = result.revision; this.emit();
      this.persistence.reset(structuredClone(result.document));
      await emit("creative://changed", { projectId: this.projectId }).catch(() => {});
      return result;
    } finally { this.encapsulating = false; this.triggerScheduler.scheduleSessionCompletions(); }
  }
  async syncCanvasReferences(canvas: Parameters<typeof reconcileCanvasWorkflowReferences>[1]) {
    if (this.generationHandoffs.size) for (const [id, handoff] of this.generationHandoffs) {
      const node = this.document.nodes.find(item => item.id === id), run = this.run(handoff.runId);
      const step = run?.steps[id];
      const activity = node && step?.jobId === handoff.jobId && step.turnKey === handoff.turnKey
        && workflowGenerationActivity(node, run, canvas, this.host.getState().genJobs);
      if (!activity || !activity.running && !activity.awaitingOutput) this.generationHandoffs.delete(id);
    }
    if (!this.ready) return;
    const nodes = reconcileCanvasWorkflowReferences(this.document.nodes, canvas).map(node => this.isLocked(node.id) ? this.document.nodes.find(current => current.id === node.id)! : node);
    if (JSON.stringify(nodes) !== JSON.stringify(this.document.nodes)) await this.edit(nodes);
    this.notifySessionCompletionChange(canvas);
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
    const writerId = await this.withResource("canvas", async () => {
      await this.flush();
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
      const checkWiring = () => {
        const nodes = [...this.document.nodes.filter(node => node.id !== writer.id).map(node => ({ ...node,
          ...(node.resultNodeIds?.includes(nodeId) ? { resultNodeIds: node.resultNodeIds.filter(id => id !== nodeId) } : {}),
          ...(cellId && node.textTarget?.nodeId === nodeId && node.textTarget.cellIds?.includes(cellId)
            ? { textTarget: { ...node.textTarget, cellIds: node.textTarget.cellIds.filter(id => id !== cellId) } } : {}),
        })), writer];
        assertWorkflowAcyclic(nodes, writer.id); // Check wiring without validating or running downstream prompts.
        return nodes;
      };
      const planned = checkWiring();
      if (workflowDefinitionRequiresPro(this.document.nodes, planned)
        || this.document.nodes.some(node => workflowNodeRequiresPro(node) && node.resultNodeIds?.includes(nodeId))) await api.canvasWorkflowAuthorize();
      if (!appendAxis) {
        const row = note.cells[0].map((_, column) => ({ ...emptyCanvasCell(), id: column === 0 ? targetCellId : crypto.randomUUID(), content_type: column === 0 ? type : "text" as const }));
        const cells = cellId || reuseEmptyCard ? note.cells.map(row => row.map(cell => cell.id === targetCellId ? { ...cell, content_type: type, generation_ref: undefined } : cell)) : [...note.cells, row];
        await api.projectCanvasNoteUpdate(nodeId, JSON.stringify({ ...note, note_type: "text", cells, row_heights: cellId || reuseEmptyCard ? note.row_heights : [...canvasGridWeights(note.row_heights, note.cells.length), 1], text: cells.map(row => row.map(cell => cell.text).join("\t")).join("\n") }));
        if (type === "image" || !cellId) {
          const minimum = canvasTextMinSize(cells);
          await api.projectCanvasNodeUpdate(nodeId, { x: target.x, y: target.y, width: Math.max(target.width, minimum.width), height: Math.max(target.height, minimum.height), zIndex: target.zIndex, positionLocked: target.positionLocked });
        }
      }
      await this.edit(invalidateWorkflow(checkWiring(), writer.id));
      if (!appendAxis) await emit("creative://changed", { projectId: this.projectId });
      return writer.id;
    });
    // Binding an available value fills the cell immediately, without running model cards.
    if (!source.nodeId || this.document.nodes.find(node => node.id === source.nodeId)?.outputs[source.portId ?? ""]) await this.start(writerId, true);
  }

  private observePendingCompletion(binding: WorkflowInput, source: WorkflowNode | undefined, canvasNodes: CanvasNode[]) {
    // The workflow step may have already handed off the image render.
    const pending = source?.kind === "generation" && source.outputs.image?.nodeIds?.[0];
    if (pending && submittedTurnState(pending, canvasNodes) === "pending") binding.pendingCompletionSession = pending;
  }

  /** A winding drag creates an independent trigger and both control wires together. */
  async connectCompletionTrigger(sourceId: string, targetId: string, point: { x: number; y: number },
    onEdited?: (before: CanvasWorkflow, after: CanvasWorkflow) => void) {
    return this.withResource("canvas", async () => {
      await this.flush();
      if (sourceId === targetId) throw new Error("不能连接卡片自身");
      const sourceBeforeRead = this.document.nodes.find(node => node.id === sourceId);
      if (!sourceBeforeRead || !workflowCompletionOutput(sourceBeforeRead)) throw new Error("请选择能完成运行的来源卡片");
      const knownTarget = this.document.nodes.find(node => node.id === targetId);
      const needsSessions = sourceBeforeRead.kind === "generation"
        && (sourceBeforeRead.outputs.image?.nodeIds?.length || sourceBeforeRead.activeSessionNodeId);
      let canvasNodes = needsSessions ? (await api.projectCanvasGet(this.projectId)).nodes
        : knownTarget ? [] : await api.projectCanvasVisibleNodes(this.projectId, [targetId]);
      let source = this.document.nodes.find(node => node.id === sourceId);
      const turn = source?.kind === "generation" && source.outputs.image?.nodeIds?.[0];
      // A source can hand off a render while the target or previous turn is read.
      if (turn && turn !== sourceBeforeRead.outputs.image?.nodeIds?.[0] && !canvasNodes.some(node => node.id === turn)) {
        canvasNodes = (await api.projectCanvasGet(this.projectId)).nodes;
        source = this.document.nodes.find(node => node.id === sourceId);
      }
      const output = source && workflowCompletionOutput(source);
      if (!source || !output) throw new Error("请选择能完成运行的来源卡片");
      const nativeTarget = canvasNodes.find(node => node.id === targetId && node.kind === "note" && node.hiddenAt == null
        && ["text", "images"].includes(readCanvasNote(node).note_type));
      const nodes = this.document.nodes;
      const existing = nodes.find(node => node.id === targetId || nativeTarget && node.textSource === targetId);
      const target = existing ?? (nativeTarget && { ...newWorkflowNode("text", nativeTarget.x, nativeTarget.y, ""), textSource: targetId });
      if (!target || !workflowCompletionTarget(target)) throw new Error("请选择能运行的接收卡片");
      const binding: WorkflowInput = { nodeId: source.id, portId: output.id, autoConnect: crypto.randomUUID() };
      this.observePendingCompletion(binding, source, canvasNodes);
      const trigger: WorkflowNode = { ...newWorkflowNode("trigger", point.x, point.y, ""), triggerMode: "completion",
        inputs: { completion: [binding] } };
      const candidates = [...nodes, ...(!existing ? [target] : []), trigger];
      const error = workflowConnectionError(candidates, trigger.id, "signal", target.id, "signal");
      if (error) throw new Error(error);
      const previous = this.document;
      const before = structuredClone(previous);
      const write = this.edit(candidates.map(node => node.id === target.id ? { ...node,
        inputs: { ...node.inputs, signal: [...(node.inputs.signal ?? []), { nodeId: trigger.id, portId: "signal", autoConnect: crypto.randomUUID() }] } } : node));
      const after = this.document;
      await write;
      if (after !== previous) onEdited?.(before, after);
      return { before, after, createdNodeIds: [trigger.id] };
    });
  }

  /** A single gesture produces one durable edit, even when it carries several content types. */
  async connectAutomatic(outputs: AutomaticOutput[], target: { nodeId?: string; canvasNodeId?: string; cellId?: string; collapsedAnchorId?: string },
    options: { createNodes?: WorkflowNode[]; connectionId?: string; onEdited?: (before: CanvasWorkflow, after: CanvasWorkflow) => void } = {}) {
    return this.withResource("canvas", async () => {
      await this.flush();
      const nativeIds = new Set(outputs.map(({ binding }) => binding.assetNodeId ?? binding.canvasNodeId).filter((id): id is string => !!id));
      if (target.canvasNodeId) nativeIds.add(target.canvasNodeId);
      const trigger = this.document.nodes.find(node => node.id === target.nodeId) ?? options.createNodes?.find(node => node.id === target.nodeId);
      // Completion and a collapsed receiver need the exact provenance of earlier turns.
      const needsSessions = trigger?.kind === "trigger" && (nativeIds.size > 0 || outputs.some(({ binding }) =>
        this.document.nodes.some(node => node.id === binding.nodeId && (node.outputs.image?.nodeIds?.length || node.activeSessionNodeId))));
      const snapshot = needsSessions || target.collapsedAnchorId ? await api.projectCanvasGet(this.projectId) : undefined;
      const canvasNodes = snapshot ? snapshot.nodes
        : nativeIds.size ? await api.projectCanvasVisibleNodes(this.projectId, [...nativeIds]) : [];
      const generationOrigins = target.collapsedAnchorId ? workflowGenerationOrigins(this.document, canvasNodes) : undefined;
      if (target.collapsedAnchorId) {
        const anchor = canvasNodes.find(node => node.id === target.collapsedAnchorId);
        if (!target.nodeId || !anchor || anchor.hiddenAt != null || generationOrigins?.get(anchor.id)?.id !== target.nodeId
          || snapshot?.threads.some(thread => thread.id === anchor.threadId && thread.archivedAt != null)) {
          throw new Error("接收卡片已变化，请重新连接");
        }
      }
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
        // A new reader leaves existing source definitions intact. Writes still
        // block data connections, and extracting a frame requires an idle source.
        if (trigger?.kind !== "trigger" && output.type !== "signal" && [sourceId, input.nodeId, ...workflowInputProducers(nodes, input)]
          .some(id => id && (input.videoFrame || input.videoAudio && !input.nodeId ? this.isLocked(id) : this.isWriteLocked(id)))) throw new Error("来源卡片正在使用");
      }
      const signalOnly = outputs.length > 0 && outputs.every(output => output.type === "signal");
      const connectionId = options.connectionId ?? crypto.randomUUID();
      const changedIds: string[] = [];
      if (target.nodeId) {
        const receiver = nodes.find(node => node.id === target.nodeId);
        if (!receiver) throw new Error("接收卡片已不存在");
        if (target.collapsedAnchorId) {
          const run = workflowNodeRun(this.document, receiver.id);
          const activity = workflowGenerationActivity(receiver, run, canvasNodes, this.host.getState().genJobs);
          if (this.startingAction(receiver.id) || activity.running
            || activity.awaitingOutput && run && this.liveGenerationCheckpoint(receiver.id, run)) throw new Error("这张卡片正在运行");
        }
        if (this.isLocked(receiver.id) && !signalOnly) throw new Error("关联工作流正在运行，请先停止");
        if (!signalOnly && receiver.kind === "visual-profile" && receiver.profileId) throw new Error("请先切换到从输入提炼");
        const plan = planAutomaticConnection(nodes, outputs, receiver.id, generationOrigins);
        if (plan.error) throw new Error(plan.error);
        if (receiver.kind === "trigger" && plan.bindings.some(({ binding }) => binding.canvasNodeId
          && !canvasNodes.some(node => node.id === binding.canvasNodeId && node.kind === "prompt"))) throw new Error("请选择执行卡片或生成会话");
        const inputs = { ...receiver.inputs };
        const addedCompletions: WorkflowInput[] = [];
        // Older connections can point at a later turn of the same visible conversation.
        const sessionAliases = receiver.kind === "trigger" && inputs.completion?.some(input => input.canvasNodeId)
          && plan.bindings.some(item => item.binding.canvasNodeId)
          ? canvasConversationCards(canvasNodes, this.host.getState().genJobs).aliases : undefined;
        for (const item of plan.bindings) {
          const binding: WorkflowInput = { ...item.binding, autoConnect: item.binding.autoConnect ?? connectionId };
          const current = inputs[item.inputId] ?? [];
          if (current.some(input => workflowBindingKey(input) === workflowBindingKey(binding))) continue;
          const session = binding.canvasNodeId && sessionAliases?.get(binding.canvasNodeId);
          if (session && current.some(input => input.canvasNodeId && sessionAliases?.get(input.canvasNodeId) === session)) continue;
          if (receiver.kind === "trigger") {
            const source = nodes.find(node => node.id === binding.nodeId);
            this.observePendingCompletion(binding, source, canvasNodes);
            addedCompletions.push(binding);
          }
          inputs[item.inputId] = [...current, binding];
          changedIds.push(receiver.id);
        }
        if (receiver.kind === "trigger" && workflowTriggerMode(receiver) !== "completion") changedIds.push(receiver.id);
        nodes = nodes.map(node => node.id === receiver.id ? { ...node, inputs,
          ...(receiver.kind === "trigger" ? { triggerMode: "completion" as const, triggerSchedule: undefined,
            completionSeen: [...new Set([...(node.completionSeen ?? []), ...completedCanvasSessions(addedCompletions, canvasNodes, this.host.getState().genJobs)])] } : {}) } : node);
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
          && contentCardAcceptsMedia(output));
        if (outputs.some(output => output.selectionWireId) && compatible.length !== outputs.length) throw new Error("此位置无法接收全部选中的素材");
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
            inputs: { [output.type]: [{ ...output.binding, autoConnect: output.selectionWireId ?? connectionId, mediaFilter: ["image", "video"] }] } };
          nodes = nodes.map(node => node.resultNodeIds?.includes(card.id) ? { ...node, resultNodeIds: node.resultNodeIds.filter(id => id !== card.id) } : node);
          nodes.push(writer); changedIds.push(writer.id);
        }
      } else throw new Error("请选择接收卡片");
      if (!changedIds.length && !createdNodeIds.length) return { before, after: before, createdNodeIds };
      for (const id of changedIds) assertWorkflowAcyclic(nodes, id);
      if (!signalOnly && trigger?.kind !== "trigger") for (const id of new Set(changedIds)) nodes = invalidateWorkflow(nodes, id);
      const previous = this.document;
      const write = this.edit(nodes);
      const after = this.document;
      try { await write; }
      catch (error) {
        if (!isWorkflowProDenied(error) && after !== previous) options.onEdited?.(before, after);
        throw error;
      }
      if (after !== previous) options.onEdited?.(before, after);
      return { before, after, createdNodeIds };
    });
  }

  async disconnectAutomatic(connectionId: string) {
    return this.withResource("canvas", async () => {
      await this.flush();
      const before = structuredClone(this.document);
      const changed = before.nodes.filter(node => Object.values(node.inputs).flat().some(input => workflowDisconnectId(input) === connectionId));
      const dataChanges = changed.filter(node => node.kind !== "trigger" && Object.entries(node.inputs).some(([port, inputs]) => port !== "signal" && inputs.some(input => workflowDisconnectId(input) === connectionId)));
      if (dataChanges.some(node => this.isLocked(node.id))) throw new Error("关联工作流正在运行，请先停止");
      let nodes = before.nodes.map(node => ({ ...node, inputs: Object.fromEntries(Object.entries(node.inputs).map(([port, inputs]) =>
        [port, inputs.filter(input => workflowDisconnectId(input) !== connectionId)])) }));
      for (const node of dataChanges) nodes = invalidateWorkflow(nodes, node.id);
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
    if (halted()) return;
    const minimum = canvasTextMinSize(result.note.cells);
    if (table.height < minimum.height || table.width < minimum.width) await api.projectCanvasNodeUpdate(table.id, {
      x: table.x, y: table.y, width: Math.max(table.width, minimum.width), height: Math.max(table.height, minimum.height), zIndex: table.zIndex, positionLocked: table.positionLocked,
    });
    if (sessionId && !halted()) await this.step(runId, writer.id, { agentSessionDeliveries: {
      ...this.run(runId).steps[writer.id].agentSessionDeliveries, [sessionId]: { target: contentTarget, done: true },
    } });
  }

  async start(startId: string, single = false, background = false, optimizeOnce?: boolean) {
    if (this.startingCards.has(startId)) return;
    this.issue = null;
    const start = this.beginStart(startId, "run", background);
    try { await this.startRun(startId, single, undefined, background, undefined, start, optimizeOnce); }
    catch (error) {
      const node = this.document.nodes.find(node => node.id === startId);
      if (node) { this.issue = workflowDiagnostic(error, node, "validation"); this.emit(); }
      throw error;
    }
    finally { start.release(); }
  }
  private async checkNewSubmission(node: WorkflowNode, chatProvider?: ChatProvider) {
    if (node.kind === "agent" && !chatProvider) {
      const chats = useLocalChatStore.getState().summaries;
      const chat = node.chatConversationId ? chats[node.chatConversationId]
        : Object.values(chats).find(chat => chat.projectId === this.projectId && chat.nodeId === node.id);
      chatProvider = chat?.provider;
    }
    const issue = workflowProviderIssue(node, this.host.getState(), chatProvider);
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
  private async repairStartReferences(startId: string, single: boolean, snapshot: Awaited<ReturnType<typeof api.projectCanvasGet>>) {
    // A deleted result table may still be used as a relay by downstream cards.
    // Recover whole-output references before removing its writer/provenance.
    await this.syncCanvasReferences(snapshot.nodes);
    const liveTables = new Set(snapshot.nodes.filter(node => node.kind === "note" && node.hiddenAt == null).map(node => node.id));
    const recoveryScope = new Set(workflowOrder(this.document.nodes, startId, single));
    const forwardResult = (input: WorkflowInput): WorkflowInput => {
      if (!input.canvasNodeId || liveTables.has(input.canvasNodeId)) return input;
      const automatic = this.document.nodes.find(node => recoveryScope.has(node.id) && node.kind === "instruction" && node.action === "layers"
        && (node.resultNodeIds?.includes(input.canvasNodeId!) || input.canvasNodeId!.startsWith("workflow-layers:") && input.canvasNodeId!.endsWith(`:${node.id}`)));
      const metadata = { slot: input.slot, ...(input.autoConnect ? { autoConnect: input.autoConnect } : {}), ...(input.mediaFilter ? { mediaFilter: input.mediaFilter } : {}),
        ...(input.referenceRanks ? { referenceRanks: input.referenceRanks } : {}), ...(input.excludedAssetIds ? { excludedAssetIds: input.excludedAssetIds } : {}) };
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
  }
  private async preparePhase(order: string[], executionNodes: WorkflowNode[], writeNodeIds: string[],
    loop: WorkflowRun["loop"], readCanvas: () => Promise<ProjectCanvasSnapshot>, inputNodes = this.document.nodes, authorized = false) {
    if (!authorized && executionNodes.some(node => writeNodeIds.includes(node.id) && workflowNodeRequiresPro(node))) await api.canvasWorkflowAuthorize();
    const textSources = this.document.nodes.filter(node => node.textSource && order.includes(node.id)).map(node => node.textSource!);
    // Validate configuration and snapshot fixed inputs; cell values are checked by their consumers.
    for (const textSource of textSources) {
      const canvas = await readCanvas();
      if (!canvas.nodes.some(node => node.id === textSource && node.kind === "note" && node.hiddenAt == null && ["text", "images"].includes(readCanvasNote(node).note_type))) throw new Error("起点内容卡片已删除");
    }
    const textTargets = this.document.nodes.filter(node => writeNodeIds.includes(node.id) && node.textTarget);
    if (textTargets.length) {
      const canvas = await readCanvas();
      for (const writer of textTargets) {
        const table = canvas.nodes.find(node => node.id === writer.textTarget?.nodeId && node.kind === "note" && node.hiddenAt == null);
        if (!table || (writer.textTarget?.appendAxis ? contentInputAxisIndex(readCanvasNote(table), writer.textTarget) < 0 : !writer.textTarget?.append && !readCanvasNote(table).cells.flat().some(cell => cell.id === writer.textTarget?.cellId))) throw new Error("接收产物的内容卡片或单元格已删除，请重新连接输出");
      }
    }
    for (const id of order) {
      const node = inputNodes.find(node => node.id === id)!;
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
      if (node.kind === "director3d") {
        if (!node.directorVideoId) throw new WorkflowNodeError("3D 导演台已下架，此卡片没有已导出的视频，请改用视频素材", node);
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
    const scopeBindings = inputNodes.filter(node => order.includes(node.id)).flatMap(node =>
      Object.values(generationInputNode(node, inputNodes).inputs).flat());
    const instanceBindings = scopeBindings.filter(input => input.assetNodeId);
    if (instanceBindings.length) {
      const canvas = await readCanvas();
      if (instanceBindings.some(input => !canvas.nodes.some(node => node.id === input.assetNodeId && node.kind === "asset" && node.assetId === input.assetId && node.hiddenAt == null))) {
        throw new Error("连接的画板素材实例已移除，请重新连接");
      }
    }
    const cellBindings = scopeBindings.filter(input => input.canvasNodeId);
    const groupBindings = scopeBindings.filter(input => input.groupId);
    const groupIds = [...new Set(groupBindings.map(input => input.groupId!))];
    const groupAssets = new Map<string, { image: string[]; media: string[] }>();
    if (groupIds.length) {
      const canvas = await readCanvas();
      for (const groupId of groupIds) {
        if (!canvas.groups.some(group => group.id === groupId)) throw new Error("连接的文件夹已删除，请重新连接");
        const ids = [...new Set(canvas.groupItems.filter(item => item.groupId === groupId).sort((a, b) => a.ordinal - b.ordinal).flatMap(item => {
          const member = canvas.nodes.find(node => node.id === item.nodeId && node.kind === "asset" && node.hiddenAt == null);
          return member?.assetId ? [member.assetId] : [];
        }))];
        const assets = await api.getAssetsByIds(ids);
        const images = ids.filter(id => assets.some(asset => asset.id === id && !asset.duration && asset.store_path));
        const media = ids.filter(id => assets.some(asset => asset.id === id && asset.store_path));
        if (!media.length || !images.length && groupBindings.some(input => input.groupId === groupId && !input.autoConnect && !input.mediaFilter?.includes("audio"))) throw new Error("文件夹中没有可用素材，请检查来源连接");
        groupAssets.set(groupId, { image: images, media });
      }
    }
    const cellTexts: Record<string, string> = {};
    const cellValues: Record<string, WorkflowValue> = {};
    if (cellBindings.length) {
      const canvas = await readCanvas();
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
        loop.items = validateLoopStart(workflowLoopRows(owner, this.document.nodes, (await readCanvas()).nodes), loop.index, owner);
      }
    }
    const freezeInputs = (node: WorkflowNode): WorkflowNode["inputs"] => Object.fromEntries(Object.entries(node.inputs).map(([port, bindings]) => [port, bindings.map(input => input.groupId && groupAssets.has(input.groupId) ? { ...input, assetIds: groupAssets.get(input.groupId)![input.autoConnect || port === H3_VIDEO_AUDIO_PORT || r2vPorts.some(id => id === port) ? "media" : "image"] } : input)]));
    return { cellTexts, cellValues, freezeInputs };
  }
  private async startRun(startId: string, single = false, completionSessionId?: string, background = false, scheduleId?: string, start?: CardStart, optimizeOnce?: boolean) {
    if (this.discarded) return;
    const { cloudAuth, settings } = this.host.getState();
    const accountId = cloudAuth?.user_id ?? null;
    const optimizeOnManualRun = !background && (optimizeOnce ?? settings?.h3_auto_optimize_prompt === true);
    if (start && !start.current()) return;
    if (this.encapsulating) throw new Error("正在封装卡片，请稍后再运行");
    if (!this.ready) throw new Error("工作流尚未载入");
    if (this.document.nodes.find(node => node.id === startId)?.kind === "loop") single = false;
    if (this.document.nodes.find(node => node.id === startId)?.kind === "planner") throw new Error("请使用助手的编排按钮；助手不参与工作流执行");
    const source = this.document.nodes.find(node => node.id === startId);
    // A single card using its own prompt / direct assets has no cell references
    // to repair. Attached content writers still need the legacy relay checks.
    const standalone = single && source && !source.textTarget && !source.textSource && !source.promptReferences?.length
      && Object.values(source.inputs).flat().every(input => !input.canvasNodeId && !input.nodeId)
      && !this.document.nodes.some(node => node.textTarget && Object.values(node.inputs).flat().some(input => input.nodeId === startId));
    const previous = standalone ? null : await api.projectCanvasGet(this.projectId);
    if (previous) await this.repairStartReferences(startId, single, previous);
    // Freeze related groups, instances and cells from one post-repair snapshot.
    let validationCanvas: ReturnType<typeof api.projectCanvasGet> | undefined;
    const readCanvas = () => validationCanvas ??= api.projectCanvasGet(this.projectId);
    // Output writers can survive deletion of a table or an individual cell.
    // Include sibling writers covered by the table's write lock, not just direct image wires.
    const plannedNodes = this.document.nodes;
    const forDispatch = (nodes: WorkflowNode[]) => single && optimizeOnManualRun && source?.h3Prompt
      ? nodes.map(node => node.id === startId ? { ...node, prompt: h3OriginalPrompt(node) } : node) : nodes;
    const plannedInputs = forDispatch(plannedNodes);
    const plannedOrder = workflowOrder(plannedInputs, startId, single);
    const plannedExecution = workflowExecutionNodes(plannedInputs, startId);
    const plannedWrites = new Set(workflowWriteNodes(plannedExecution, plannedOrder));
    const writers = this.document.nodes.filter(node => node.id !== startId && plannedWrites.has(node.id) && node.textTarget);
    if (writers.length) {
      const canvas = await readCanvas();
      const deleted = new Set(writers.filter(writer => {
        const table = canvas.nodes.find(node => node.id === writer.textTarget!.nodeId && node.kind === "note" && node.hiddenAt == null);
        return !table || (writer.textTarget!.appendAxis ? contentInputAxisIndex(readCanvasNote(table), writer.textTarget!) < 0 : !writer.textTarget!.append && !readCanvasNote(table).cells.flat().some(cell => cell.id === writer.textTarget!.cellId));
      }).map(writer => writer.id));
      if (deleted.size) await this.edit(this.document.nodes.filter(node => !deleted.has(node.id)));
    }
    const inputs = this.document.nodes === plannedNodes ? plannedInputs : forDispatch(this.document.nodes);
    const order = inputs === plannedInputs ? plannedOrder : workflowOrder(inputs, startId, single);
    const startNode = this.document.nodes.find(node => node.id === startId);
    if (!startNode) throw new Error("卡片不存在");
    const autoOptimize = single && optimizeOnManualRun
      && (startNode.kind === "comfy-video" || startNode.kind === "generation" && workflowGenerationProvider(startNode) === H3_IMAGE);
    const executionNodes = inputs === plannedInputs ? plannedExecution : workflowExecutionNodes(inputs, startId);
    const loop = workflowLoopScope(executionNodes, order);
    const lockedNodeIds = workflowDependencies(executionNodes, order);
    const writeNodeIds = workflowWriteNodes(executionNodes, order);
    const accesses = [
      ...workflowRuns(this.document).filter(workflowRunActive).map(run => ({
        access: run.lockedNodeIds ?? workflowDependencies(this.document.nodes, run.order),
        writes: run.writeNodeIds ?? workflowWriteNodes(this.document.nodes, run.order),
      })), ...this.reservations.values(),
    ];
    if (accesses.some(item => workflowAccessConflict(this.document.nodes, lockedNodeIds, writeNodeIds, item.access, item.writes))) {
      if (completionSessionId || scheduleId) return; // Leave the event unconsumed until the downstream cards are free.
      throw new Error("此运行会修改其他工作流正在使用的卡片，请等待对应流程完成");
    }
    const runId = crypto.randomUUID(), threadId = crypto.randomUUID();
    this.reservations.set(runId, { access: lockedNodeIds, writes: writeNodeIds }); this.emit();
    try {
    await this.waitForWrites();
    if (scheduleId) {
      const owner = this.document.nodes.find(node => node.id === startId);
      const schedule = owner && activeTriggerSchedule(owner);
      if (!this.triggerScheduler.enabled || !schedule || triggerScheduleOccurrence(schedule) !== scheduleId || schedule.status !== "armed" || schedule.at > Date.now()) return;
    }
    if (completionSessionId) {
      const trigger = this.document.nodes.find(node => node.id === startId)!;
      if (!trigger || workflowTriggerMode(trigger) !== "completion" || !(trigger.triggerCount! > 0) || trigger.completionSeen?.includes(completionSessionId)
        || !completedCanvasSessions(trigger.inputs.completion ?? [], (await readCanvas()).nodes, this.host.getState().genJobs).includes(completionSessionId)) return;
    }
    const { cellTexts, cellValues, freezeInputs } = await this.preparePhase(order, executionNodes, writeNodeIds, loop, readCanvas, inputs);
    if (start && !start.current()) return;
    await api.projectThreadCreate({ id: threadId, projectId: this.projectId, title: "工作流", origin: "direct" });
    if (start && !start.current()) return;
    if (startNode.kind === "trigger") {
      const owner = this.document.nodes.find(node => node.id === startId);
      if (!owner || workflowTriggerMode(owner) !== workflowTriggerMode(startNode)) return;
      const schedule = activeTriggerSchedule(owner);
      if (scheduleId && (!schedule || schedule.status !== "armed" || triggerScheduleOccurrence(schedule) !== scheduleId)) return;
      if (completionSessionId && (!(owner.triggerCount! > 0) || owner.completionSeen?.includes(completionSessionId)
        || JSON.stringify(owner.inputs.completion) !== JSON.stringify(startNode.inputs.completion))) return;
    }
    const invalidated = new Set(invalidateWorkflow(executionNodes, startId).filter(node => !Object.keys(node.outputs).length).map(node => node.id));
    const nodes = this.document.nodes.map(node => invalidated.has(node.id) ? { ...node, outputs: {} } : node).map(node => this.isLocked(node.id) && !writeNodeIds.includes(node.id) ? this.document.nodes.find(item => item.id === node.id)! : order.includes(node.id) ? {
      ...node, outputs: {}, ...(node.kind === "generation" ? { activeSessionNodeId: null } : {}), inputs: freezeInputs(node),
    } : node).map(node => node.id === startId && completionSessionId ? { ...node, triggerCount: (node.triggerCount ?? 0) - 1,
      completionSeen: [...(node.completionSeen ?? []), completionSessionId] } : node)
      .map(node => node.id === startId && scheduleId ? { ...node, triggerSchedule: advanceTriggerSchedule(node.triggerSchedule!) } : node);
    await this.saveRun({ id: runId, startId, threadId, order, lockedNodeIds, writeNodeIds, cellTexts, cellValues, status: "running",
      ...(single && !background && startNode.kind === "agent" ? { manualCardRun: true as const } : {}),
      ...(scheduleId ? { scheduleId } : {}),
      ...(loop ? { loop } : {}),
      accountId,
      steps: Object.fromEntries(order.map(id => [id, { status: "pending" as const,
        ...(id === startId && autoOptimize ? { comfyAutoGeneration: {} } : {}) }])) }, nodes);
    } finally { this.reservations.delete(runId); this.emit(); }
    if (start && !start.current()) { await this.stopBeforeDispatch(runId); return; }
    const h3Start = (single && source?.kind === "comfy-video" || autoOptimize) ? start : undefined;
    if (!h3Start) start?.release();
    const execution = this.continue(runId, h3Start);
    if (background) void execution.catch(error => { this.runtimeError = String(error); this.emit(); });
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
    const owner = this.executing.get(runId), drain = this.executionDrains.get(runId);
    const localIds = this.document.nodes.filter(node => node.kind === "comfy-video" && ["pending", "running", "waiting"].includes(this.run(runId)?.steps[node.id]?.status)).map(node => node.id);
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutError: Error | undefined;
    const deadline = localIds.length ? new Promise<never>((_, reject) => {
      stopTimer = setTimeout(() => {
        timeoutError = new Error("等待本机停止响应超时。可重试停止或继续查询原任务。");
        reject(timeoutError);
      }, 20000);
    }) : undefined;
    const waitForStop = <T>(operation: Promise<T>) => deadline ? Promise.race([operation, deadline]) : operation;
    try {
    if (localIds.length) {
      const run = this.run(runId), steps = { ...run.steps };
      for (const id of localIds) {
        const step = steps[id];
        steps[id] = { ...step, comfyStopping: true, comfyProgress: undefined,
          detail: step.comfyOptimization && !step.comfyOptimization.result ? "正在停止提示词优化…" : "正在中断本机生成…" };
      }
      const runs = workflowRuns(this.document).map(item => item.id === runId ? { ...run, steps } : item);
      this.document = { ...this.document, runs, run: runs[runs.length - 1] ?? null };
    }
    this.stopped.add(runId);
    this.executionAborts.get(runId)?.abort();
    this.emit();
    const run = this.run(runId);
    if (!run) return;
    const videoStops = new Map(localIds.flatMap(id => {
      const step = run.steps[id];
      if (!step.jobId) return [];
      // Native cancellation owns the original request, including a start still crossing IPC.
      return [[id, comfyVideo("cancel", this.projectId, step.jobId)
        .then(result => ({ result, error: undefined }), error => ({ result: undefined, error }))] as const];
    }));
    const active = Object.values(run.steps).filter(step => step.status === "running" || step.status === "waiting");
    // Keep the definition locked until cancellation requests have completed.
    await waitForStop(Promise.all(active.map(async step => {
      if (step.voiceRequest?.jobId) await voiceApi.cancel(step.voiceRequest.jobId);
      if (step.jobId && step.generationSubmission !== "submitted" && !this.document.nodes.some(node => node.kind === "comfy-video" && run.steps[node.id] === step)) await api.cancelCodexCreate(step.jobId, step.turnKey);
      for (const generation of Object.values(step.localDsGenerations ?? {})) {
        if (!generation.response) await api.cancelCodexCreate(generation.jobId, generation.turnKey);
      }
      if (step.localDsRequestId && step.localAgentTransport === "codex-cli") await api.agentDsWorkflowCancel(step.localDsRequestId);
      if (step.agentRunId && !step.comfyOptimization?.result) await api.cloudAgentCancel(step.agentRunId);
      if (step.chatInput) {
        if (step.chatConversationId && step.chatTurnId) {
          await useLocalChatStore.getState().stop(step.chatConversationId, step.chatTurnId);
        } else {
          const original = await localChat.getByRequest(step.chatInput.requestId);
          if (original?.submittedTurnId && localChatRunning(original)) await useLocalChatStore.getState().stop(original.id, original.submittedTurnId);
        }
      }
      if (step.describeJobIds) await Promise.all(step.describeJobIds.map(jobId => api.cancelCodexDescribe(jobId)));
      if (step.assetId && !step.agentRunId && !step.jobId) {
        const node = this.document.nodes.find(node => run.steps[node.id] === step);
        if (node?.action === "describe" && !step.describeJobIds) await this.host.getState().cancelDescribe(step.assetId);
      }
    })));
    if (run.order.some(id => {
      const optimization = run.steps[id]?.comfyOptimization;
      return !localIds.includes(id) || optimization && !optimization.result;
    })) {
      await waitForStop(Promise.resolve(drain));
    }
    const cancellationErrors: string[] = [];
    for (const id of localIds) {
      const current = this.run(runId), step = current.steps[id];
      try {
        if (timeoutError) throw timeoutError;
        const pending = videoStops.get(id);
        const settled = pending && await waitForStop(pending);
        if (settled && !settled.result) throw settled.error;
        const result = settled?.result ?? { status: "cancelled", message: "已取消，未提交生成" };
        if (result.status !== "cancelled" && result.status !== "done") throw new Error(result.message);
        await this.saveRun({ ...current, steps: { ...current.steps, [id]: { ...step, comfyCancelled: result.status === "cancelled", comfyStopping: false, comfyProgress: undefined, error: undefined, detail: result.message } } });
      } catch (error) {
        await this.saveRun({ ...this.run(runId), status: "waiting", steps: { ...this.run(runId).steps, [id]: { ...step, status: "waiting", comfyStopping: false, comfyProgress: undefined, detail: "尚未确认本机生成已停止", error: `尚未确认停止：${String(error)}` } } });
        cancellationErrors.push(String(error));
      }
    }
    if (cancellationErrors.length) {
      throw new Error(cancellationErrors.join("\n"));
    }
    await this.saveRun({ ...this.run(runId), status: "stopped", triggerQueue: [] });
    } catch (error) {
      const run = this.run(runId);
      const unfinished = run && localIds.filter(id => run.steps[id]?.comfyStopping);
      if (run && unfinished?.length) {
        const steps = { ...run.steps };
        for (const id of unfinished) steps[id] = { ...steps[id], status: "waiting", comfyStopping: false, comfyProgress: undefined, detail: "尚未确认本机生成已停止", error: `尚未确认停止：${String(error)}` };
        await this.saveRun({ ...run, status: "waiting", steps });
      }
      throw error;
    } finally {
      clearTimeout(stopTimer);
      if (timeoutError && owner && this.executing.get(runId) === owner) {
        this.reservations.delete(runId);
        this.releaseExecution(runId, owner);
      }
      this.stopping.delete(runId);
      this.emit();
    }
  }
  async restartLoop(runId: string) {
    await this.waitForWrites();
    const run = this.run(runId), loop = run?.loop;
    if (!loop || run.status !== "stopped" || this.stopping.has(runId) || this.executing.has(runId)) return;
    if (loop.items && (loop.startIndex ?? 0) + loop.completed.length === loop.items.length) return;
    const nodes = workflowExecutionNodes(this.document.nodes, run.startId);
    const order = workflowOrder(this.document.nodes, run.startId);
    const scope = workflowLoopScope(nodes, order);
    if (JSON.stringify(order) !== JSON.stringify(run.order) || JSON.stringify(scope?.bodyIds) !== JSON.stringify(loop.bodyIds)) {
      throw new Error("循环连接已变化，请选择起始项后开始新循环");
    }
    await api.canvasWorkflowAuthorize();
    for (const id of loop.bodyIds) await this.checkNewSubmission(this.document.nodes.find(node => node.id === id)!);
    if (this.run(runId) !== run || this.stopping.has(runId) || this.executing.has(runId)) return;
    const access = workflowDependencies(nodes, order), writes = workflowWriteNodes(nodes, order);
    if (workflowRuns(this.document).filter(workflowRunActive).some(other => workflowAccessConflict(this.document.nodes, access, writes,
      other.lockedNodeIds ?? workflowDependencies(this.document.nodes, other.order), other.writeNodeIds ?? workflowWriteNodes(this.document.nodes, other.order)))
      || [...this.reservations.values()].some(other => workflowAccessConflict(this.document.nodes, access, writes, other.access, other.writes))) {
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
    const owner = this.executing.get(runId);
    if (this.executionStopped(runId, owner)) throw new Error("工作流已停止");
    const run = this.run(runId);
    const previous = run.steps[id];
    const agentProgress = this.document.nodes.some(node => node.id === id && node.kind === "agent") && patch.detail && patch.detail !== previous.detail
      ? [...(previous.agentProgress ?? []), { text: patch.detail, at: Date.now() }].slice(-100) : previous.agentProgress;
    await this.saveRun({ ...run, steps: { ...run.steps, [id]: { ...previous, ...patch, ...(agentProgress ? { agentProgress } : {}) } } });
    if (this.executionStopped(runId, owner)) throw new Error("工作流已停止");
  }
  async retryLoop(runId: string, confirmedRequestIds?: string[]) {
    if (this.retryingLoops.has(runId)) return;
    this.retryingLoops.add(runId);
    try {
    await this.waitForWrites();
    const run = this.run(runId);
    if (!run?.loop || run.status !== "waiting" || this.executing.has(runId) || this.stopping.has(runId)) return;
    const steps = { ...run.steps };
    if (confirmedRequestIds?.some(key => !Object.values(steps).some(step => step.status === "failed" && step.chatInput?.requestId === key))) return;
    const requestIds: string[] = [], cardNames: string[] = [];
    let retriesPaidStep = false;
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
          const created = createdChatTurnCards(chat, turnId);
          if (created.length) {
            requestIds.push(input.requestId); cardNames.push(...created.map(card => card.title));
            if (!confirmedRequestIds?.includes(input.requestId)) continue;
          }
          retriesPaidStep = true;
          steps[id] = { ...step, status: "waiting", error: undefined, diagnostic: undefined, chatTurnId: undefined,
            confirmedFailedChatTurnId: undefined, chatConversationId: undefined, chatInput: { ...input, conversationId: chat.id, requestId: crypto.randomUUID() } };
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
      if (retry) {
        const node = this.document.nodes.find(node => node.id === id)!;
        retriesPaidStep ||= workflowNodeRequiresPro(node);
        await this.checkNewSubmission(node);
      }
      steps[id] = retry ? { status: "pending", ...(step.contentTarget ? { contentTarget: step.contentTarget } : {}) } : { ...step, status: "waiting", error: undefined, diagnostic: undefined };
    }
    if (this.run(runId) !== run || this.discarded || this.stopping.has(runId) || this.executing.has(runId)) return;
    if (requestIds.some(key => !confirmedRequestIds?.includes(key))) return { requestIds, cardNames };
    if (retriesPaidStep) {
      await api.canvasWorkflowAuthorize();
      if (this.run(runId) !== run || this.discarded || this.stopping.has(runId) || this.executing.has(runId)) return;
    }
    this.issue = null;
    await this.saveRun({ ...run, steps });
    await this.continue(runId);
    } finally { this.retryingLoops.delete(runId); }
  }
  private progress(runId: string, id: string, detail: string, comfyProgress?: import("./comfyVideo").ComfyVideoProgress) {
    if (this.discarded || this.stopped.has(runId)) return;
    const run = this.run(runId);
    const updated = { ...run, steps: { ...run.steps, [id]: { ...run.steps[id], detail, comfyProgress } } };
    const runs = workflowRuns(this.document).map(item => item.id === runId ? updated : item);
    this.document = { ...this.document, runs, run: runs[runs.length - 1] ?? null }; this.emit();
  }
  private async finish(runId: string, node: WorkflowNode, outputs: Record<string, WorkflowValue>, ports = node.outputPorts) {
    const owner = this.executing.get(runId);
    const halted = () => this.executionStopped(runId, owner);
    if (halted()) return;
    const triggers = () => this.run(runId).completionRecoveryOnly ? [] : workflowCompletionTriggers(this.document.nodes, node.id);
    // A submitted image session is not a completed task. Event receivers wait for its actual result.
    const sessions = Object.values(outputs).filter(value => value.nodeIds?.length);
    if (sessions.length && triggers().length && !await this.resolveInputGenerations(runId, node, structuredClone(sessions), halted)) return;
    if (halted()) return;
    const run = this.run(runId);
    if (run.steps[node.id].status === "done") return;
    await this.saveRun({ ...run, triggerQueue: [...(run.triggerQueue ?? []), ...triggers().map(trigger => trigger.id)], steps: { ...run.steps, [node.id]: { ...run.steps[node.id], ...(node.kind === "agent" ? { agentOutputs: outputs } : {}), status: "done", error: undefined, diagnostic: undefined } } },
      this.document.nodes.map(candidate => candidate.id === node.id ? { ...candidate, outputs, outputPorts: ports } : candidate));
  }

  private async waitForPoll(runId: string, nodeId: string, started: number, interval: number, halted: () => boolean, status: "waiting" | "pending" = "waiting") {
    if (halted()) return false;
    const remaining = workflowPollTimeout - (Date.now() - started);
    const signal = this.executionAborts.get(runId)?.signal;
    if (remaining > 0 && !signal?.aborted) await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.min(remaining, interval));
      signal?.addEventListener("abort", finish, { once: true });
    });
    if (halted()) return false;
    if (Date.now() - started < workflowPollTimeout) return true;
    await this.step(runId, nodeId, { status, error: "等待结果超时，请稍后继续查询原任务。" });
    return false;
  }

  /** Image consumers wait for the exact submitted turns; cell writers store them immediately. */
  private async resolveInputGenerations(runId: string, node: WorkflowNode, values: WorkflowValue[], halted: () => boolean, started = Date.now(), readLatest?: (canvas: CanvasNode[]) => WorkflowValue[]) {
    if (halted()) return false;
    await this.step(runId, node.id, { detail: "等待上游生成图片" });
    while (!halted()) {
      const canvas = await api.projectCanvasGet(this.projectId);
      if (halted()) return false;
      const current = readLatest ? readLatest(canvas.nodes) : values;
      let pending = false;
      const resolved = new Map<string, string[]>();
      for (const id of new Set(current.flatMap(value => value.nodeIds ?? []))) {
        const session = canvas.nodes.find(item => item.id === id && item.kind === "prompt" && item.hiddenAt == null);
        if (!session) throw new Error("上游生成会话已不存在，请检查原任务");
        const status = canvasNodePayload(session).status;
        if (status && ["failed", "cancelled", "canceled"].includes(status)) throw new Error("上游生成任务未成功，请在原生成会话中查看原因");
        if (status !== "done") { pending = true; continue; }
        const latest = latestWorkflowSessionImage(session, canvas.nodes);
        if (!latest?.assetId) throw new Error("上游生成会话未返回可用图片");
        resolved.set(id, [latest.assetId]);
      }
      if (!pending) {
        for (const value of current) value.assetIds = [...new Set([...(value.assetIds ?? []), ...(value.nodeIds ?? []).flatMap(id => resolved.get(id) ?? [])])];
        return true;
      }
      if (!await this.waitForPoll(runId, node.id, started, 1500, halted, "pending")) return false;
    }
    return false;
  }

  private async waitForChatTurn(initial: ChatConversation, turnId: string, halted: () => boolean, signal?: AbortSignal): Promise<ChatConversation | null> {
    await ensureLocalChatEvents();
    // Reconcile once after five quiet seconds. This covers a lost final event.
    // While revisions are arriving, no database polling is needed.
    let latest = initial;
    let timer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    let finished = false, checking = false;
    let unsubscribeChat = () => {}, unsubscribeRun = () => {}, unsubscribeAbort = () => {};
    try {
      return await new Promise<ChatConversation | null>((resolve, reject) => {
        function observe() {
          if (finished) return;
          if (halted()) { finished = true; resolve(null); return; }
          const cached = useLocalChatStore.getState().conversations[initial.id];
          if (cached && cached.revision > latest.revision) latest = cached;
          if (!localChatRunning(latest) || latest.messages[latest.messages.length - 1]?.turnId !== turnId) {
            finished = true; resolve(latest);
          }
        }
        function schedule() { clearTimeout(timer); timer = setTimeout(reconcile, 5000); }
        async function reconcile() {
          if (finished) return;
          checking = true;
          try {
            const revision = await localChat.revision(initial.id);
            if (finished) return;
            if (revision == null) throw new Error("原对话已不存在");
            if (revision > latest.revision) {
              const snapshot = await useLocalChatStore.getState().loadConversation(initial.id);
              if (!snapshot) throw new Error("原对话已不存在");
              if (snapshot.revision > latest.revision) latest = snapshot;
            }
            observe();
            if (!finished) schedule();
          } catch (error) { finished = true; reject(error); }
          finally { checking = false; }
        }
        unsubscribeChat = useLocalChatStore.subscribe((state, previous) => {
          if (state.conversations[initial.id] === previous.conversations[initial.id]) return;
          observe();
          if (!finished && !checking) schedule();
        });
        unsubscribeRun = this.subscribe(observe);
        signal?.addEventListener("abort", observe, { once: true });
        unsubscribeAbort = () => signal?.removeEventListener("abort", observe);
        observe();
        if (!finished) {
          schedule();
          deadline = setTimeout(() => { finished = true; reject(new Error("等待原回复超时，请稍后继续取回。")); }, workflowPollTimeout);
        }
      });
    } finally {
      finished = true; clearTimeout(timer); clearTimeout(deadline);
      unsubscribeChat(); unsubscribeRun(); unsubscribeAbort();
    }
  }

  private async chatResult(runId: string, node: WorkflowNode, step: WorkflowStep, assets: Asset[], halted: () => boolean): Promise<Record<string, WorkflowValue> | null> {
    const store = useLocalChatStore.getState();
    let input = step.chatInput;
    if (!input) {
      if (step.status !== "pending") throw new Error("原 Agent 提交状态未知，请先核对原任务，不能重新提交");
      await store.loadProject(this.projectId);
      const summaries = useLocalChatStore.getState().summaries;
      const existing = node.chatConversationId ? summaries[node.chatConversationId]
        : Object.values(summaries).find(chat => chat.projectId === this.projectId && chat.nodeId === node.id);
      const provider = existing?.provider ?? workflowAgentProvider(node);
      const issue = chatProviderAccessIssue(provider, this.host.getState());
      if (issue) throw new WorkflowNodeError(issue.message, node);
      const run = this.run(runId), snapshot = run.steps[node.id].agentInput!;
      input = { requestId: crypto.randomUUID(), projectId: this.projectId, agentNodeId: node.id,
        ...(run.manualCardRun && run.startId === node.id ? { manualCardRun: true } : {}),
        conversationId: existing?.id ?? node.chatConversationId, provider,
        codexOptions: selectedChatOptions(provider, agentChatOptions(provider, existing ? useLocalChatStore.getState().drafts[existing.id]?.codexOptions ?? existing.codexOptions ?? node.chatCodexOptions : node.chatCodexOptions)),
        text: workflowAgentMessage(cloudAgentProfilePrompt(snapshot.prompt, snapshot.visualProfile), snapshot.source, provider, assets.map(asset => isVideoPath(asset.store_path!) ? "视频" : "图片")),
        referenceAssetIds: snapshot.assetIds,
        cardDefaults: { provider: this.host.getState().defaultProvider, videoChannel: "jimeng", videoOptions: { ...DEFAULT_VIDEO_OPTIONS } },
        placement: { x: node.x, y: node.y, width: workflowCardWidth(node), height: node.layoutSize?.height ?? 330, zIndex: Date.now() % 1000000 } };
      await this.step(runId, node.id, { status: "running", chatInput: input, detail: "正在发送" });
    }
    let chat: ChatConversation | null;
    try {
      chat = await localChat.getByRequest(input.requestId);
      if (halted()) return null;
      // Only a recorded turn identifies a prior submission. Older retry snapshots also
      // stored the conversation ID before their new request was ever sent.
      if (!chat && step.chatTurnId) throw new Error("原 Agent 轮次记录已不存在，无法取回");
      if (!chat) chat = await store.send(input); // The persisted native request key makes an uncertain IPC replay safe.
    } catch (error) {
      if (!halted()) await this.step(runId, node.id, { status: "waiting", error: String(error), detail: "等待核对原回复" });
      return null;
    }
    if (chat.projectId !== this.projectId || chat.nodeId !== node.id || !chat.submittedTurnId || (input.conversationId && chat.id !== input.conversationId)
      || (step.chatTurnId && step.chatTurnId !== chat.submittedTurnId) || (step.chatConversationId && step.chatConversationId !== chat.id)) throw new Error("Agent 回复与原卡片或轮次不匹配");
    const turnId = chat.submittedTurnId;
    if (halted()) { if (localChatRunning(chat)) await store.stop(chat.id, turnId); return null; }
    await this.refreshExternalCards();
    if (halted()) return null;
    await this.step(runId, node.id, { status: "running", chatConversationId: chat.id, chatTurnId: turnId, detail: "正在回复" });
    if (halted()) return null;
    store.applyConversation(chat);
    if (localChatRunning(chat) && chat.messages[chat.messages.length - 1]?.turnId === turnId) {
      try { chat = await this.waitForChatTurn(chat, turnId, halted, this.executionAborts.get(runId)?.signal); }
      catch (error) {
        if (!halted()) await this.step(runId, node.id, { status: "waiting", error: String(error), detail: "等待取回原回复" });
        return null;
      }
      if (!chat || halted()) return null;
    }
    const messages = chat.messages.filter(message => message.turnId === turnId && message.role === "assistant");
    if (messages.some(message => ["failed", "interrupted", "stopped"].includes(message.status))) {
      if (chat.messages[chat.messages.length - 1]?.turnId === turnId && cloudChatEndedMessage(chat.error)) throw new Error(chat.error!);
      // A host-confirmed failure is terminal: waiting and re-querying the same turn would keep
      // showing "take back the original reply" for a reply that can never exist.
      const terminal = terminalDshTurnFailure(chat, turnId, step.confirmedFailedChatTurnId);
      if (terminal) throw new ConfirmedDshTurnFailure(terminal.message, node, terminal.code);
      await this.step(runId, node.id, { status: "waiting", error: (chat.messages[chat.messages.length - 1]?.turnId === turnId && chat.error) || "回复未完成，请打开对话详情取回原回复后继续" });
      return null;
    }
    return workflowChatOutputs(chat, turnId);
  }

  private async localDsResult(runId: string, node: WorkflowNode, step: WorkflowStep, images: string[], halted: () => boolean): Promise<Record<string, WorkflowValue> | null> {
    const requestId = step.localDsRequestId!;
    const transport = step.localAgentTransport ?? "local-ds";
    const agentName = transport === "codex-cli" ? "Codex CLI" : "Agent DS";
    const videoTask = step.localAgentSkill === "hyperframes";
    const pollStarted = Date.now();
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
      if (!await this.waitForPoll(runId, node.id, pollStarted, 1500, halted)) return null;
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
      const issue = generationProviderIssue(step.localDsImageProvider, this.host.getState());
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
      if (halted()) return false;
      try {
        if (step.localDsGenerationMode === "session") {
          const result = await this.host.getState().startGeneration(request.prompt, references as NonNullable<typeof references[number]>[], request.ratio,
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
      if (halted()) return;
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
        if (halted()) return;
        if (table.width < minimum.width || table.height < minimum.height) await api.projectCanvasNodeUpdate(table.id, {
          x: table.x, y: table.y, width: Math.max(table.width, minimum.width), height: Math.max(table.height, minimum.height), zIndex: table.zIndex, positionLocked: table.positionLocked,
        });
      } else {
        const { x, y } = placeWorkflowOutput(canvas, this.layoutNodes(), node, minimum);
        await api.projectCanvasNodeCreate({ id, projectId: this.projectId, threadId: this.run(runId).threadId, kind: "note", assetId: null, role: null,
          payloadJson: JSON.stringify(payload), x, y, ...minimum, zIndex: Math.max(0, ...canvas.nodes.map(item => item.zIndex)) + 1, positionLocked: true });
      }
      if (!halted()) await emit("creative://changed", { projectId: this.projectId });
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
        const layout = this.layoutNodes();
        const position = firstWorkflowVideoOutputPoint(canvas, { ...this.document, nodes: layout }, current)
          ?? placeWorkflowOutput(canvas, layout, current, { width, height });
        await api.projectCanvasNodeCreate({ id: resultId, projectId: this.projectId, threadId: run.threadId,
          kind: "asset", assetId: asset.id, role: "output", payloadJson: JSON.stringify({ ...JSON.parse(assetPayloadJson(snapshot)), workflow_source: node.id }),
          ...position, width, height, zIndex: Math.max(0, ...canvas.nodes.map(item => item.zIndex)) + 1, positionLocked: false });
      }
      if (halted()) return;
      await this.save({ ...this.document, nodes: this.document.nodes.map(item => item.id === node.id
        ? { ...item, ...(node.kind === "comfy-video" ? { activeSessionNodeId: null } : {}), resultNodeIds: [resultId] } : item) });
      if (!halted()) await emit("creative://changed", { projectId: this.projectId });
    });
  }

  async restoreComfyPrompt(nodeId: string, runId: string, source: "original" | "result") {
    const node = this.document.nodes.find(node => node.id === nodeId);
    const step = workflowRuns(this.document).find(run => run.id === runId)?.steps[nodeId];
    const snapshot = step?.comfyOptimization;
    if (step?.comfyAutoGeneration && !snapshot?.inputBindings) return;
    if (!node || !snapshot) return;
    if (this.isLocked(nodeId) || this.startingCards.has(nodeId)) throw new Error("卡片正在使用，请等待当前任务结束");
    const text = source === "original" ? snapshot.input.prompt : snapshot.result;
    if (text === undefined) return;
    const references: NonNullable<WorkflowNode["promptReferences"]> = snapshot.inputBindings
      ? JSON.parse(snapshot.inputBindings)[1] ?? [] : node.promptReferences ?? [];
    const restored: NonNullable<WorkflowNode["promptReferences"]> = [];
    const rebind = (value: string) => value.replace(/@\[([^\]]+)\]/g, (_, id: string) => {
      const ref = references.find(ref => ref.id === id);
      if (!ref) return id;
      const input = node.inputs[ref.type]?.find(input => workflowBindingKey(input) === workflowBindingKey(ref.input));
      if (!input || ref.direction === "output") return ref.label;
      if (!restored.some(reference => reference.id === id)) restored.push({ ...ref, input, slot: input.slot });
      return "@[" + id + "]";
    });
    const original = rebind(snapshot.input.prompt);
    const draft = h3CardDraft(node);
    const changes = source === "result" && snapshot.result
      ? h3PromptPatch({ ...h3DraftForResult({ ...snapshot.input, prompt: original }, rebind(snapshot.result), h3OriginalPrompt(node)), expanded: true })
      : draft ? h3PromptPatch({ ...draft, original, paused: true, expanded: false }) : { prompt: original, h3Prompt: undefined };
    // Either retained draft may contain a live image/text chip.
    for (const ref of node.promptReferences ?? []) if (!restored.some(item => item.id === ref.id)) restored.push(ref);
    await this.edit(this.document.nodes.map(current => current.id === nodeId
      ? { ...current, ...changes, promptReferences: restored } : current));
  }

  async retryComfyPrompt(nodeId: string) {
    const previous = [...workflowRuns(this.document)].reverse().find(run => run.steps[nodeId]?.comfyOptimization && !run.steps[nodeId]?.comfyAutoGeneration);
    const step = previous?.steps[nodeId], snapshot = step?.comfyOptimization;
    if (!previous || !snapshot) return;
    const node = this.document.nodes.find(node => node.id === nodeId);
    if (!node) return;
    if (snapshot.inputBindings && snapshot.inputBindings !== JSON.stringify([Object.fromEntries(Object.entries(node.inputs).filter(([port]) => port !== "signal" && port !== "completion")), node.promptReferences])) {
      throw new Error("素材引用已改变，请用当前提示词重新优化。历史记录仍可查看。");
    }
    if (previous.status === "running") return;
    if (previous.status === "waiting") return this.continue(previous.id);
    if (!snapshot.result && snapshot.submissionStarted) {
      if (!step.agentRunId) throw new Error("上次优化的提交状态尚未确认，请先查看 Agent 任务记录。");
      const original = await api.cloudAgentGet(step.agentRunId);
      if (!["succeeded", "failed", "cancelled"].includes(original.status)) throw new Error("上次优化任务仍在处理中，请先等待结果。");
      if (original.status === "succeeded") {
        if (this.isLocked(nodeId)) throw new Error("卡片正在使用，请等待当前任务结束");
        await this.saveRun({ ...previous, status: "waiting" });
        return this.continue(previous.id);
      }
    }
    return this.optimizeComfyPrompt(nodeId, undefined, snapshot.input);
  }

  /** Explicit paid text action. It never invalidates outputs or executes connected cards. */
  async optimizeComfyPrompt(nodeId: string, references?: number | H3R2VPromptReferences, retryInput?: NonNullable<WorkflowStep["comfyOptimization"]>["input"]) {
    if (!this.ready) throw new Error("工作流尚未载入");
    if (this.startingCards.has(nodeId)) return;
    const node = this.document.nodes.find(node => node.id === nodeId);
    const image = node?.kind === "generation" && node.provider === H3_IMAGE && node.generation?.media !== "video";
    if (!node || (!image && node.kind !== "comfy-video")) throw new Error("请选择本地 H3 生成卡片");
    if (this.encapsulating || this.isLocked(nodeId)) throw new Error("卡片正在使用，请等待当前任务结束");
    if (retryInput && image !== ("referenceCount" in retryInput)) throw new Error("卡片类型已改变，请使用当前提示词重新优化。");
    const prompt = retryInput?.prompt ?? h3OriginalPrompt(node).trim(), options = node.comfyVideo ?? DEFAULT_COMFY_VIDEO, mode = comfyVideoMode(options);
    if (retryInput && "mode" in retryInput && retryInput.mode !== mode) throw new Error("H3 工作流已切换，请使用当前提示词重新优化。");
    if (!prompt || prompt.length > 16000) throw new Error("请在卡片中填写 1–16000 字提示词后再优化");
    const r2vCounts = mode === "r2v" ? typeof references === "object" ? references : {
      referenceImageCount: node.inputs[H3_R2V_INPUT_PORTS.image]?.length ?? 0,
      referenceVideoCount: node.inputs[H3_R2V_INPUT_PORTS.video]?.length ?? 0,
      referenceAudioCount: node.inputs[H3_R2V_INPUT_PORTS.audio]?.length ?? 0,
    } : undefined;
    const inputError = r2vCounts && h3R2VInputError(r2vCounts.referenceImageCount, r2vCounts.referenceVideoCount, r2vCounts.referenceAudioCount, false);
    if (!retryInput && inputError) throw new WorkflowNodeError(inputError, node);
    const input = retryInput ?? (image ? { prompt, referenceCount: (typeof references === "number" ? references : node.inputs.image?.length) ?? 0, ratio: node.ratio ?? "auto" } : { prompt, mode, seconds: options.seconds, ratio: options.ratio,
      firstFrameCount: (mode === "frames" || mode === "reference") && node.inputs["first-frame"]?.length ? 1 : 0,
      lastFrameCount: mode === "frames" && node.inputs["last-frame"]?.length ? 1 : 0,
      ...(r2vCounts ?? { audioReference: node.inputs[H3_VIDEO_AUDIO_PORT]?.length === 1 || undefined }) });
    const runId = crypto.randomUUID(), threadId = crypto.randomUUID(), accountId = this.host.getState().cloudAuth?.user_id ?? null;
    this.reservations.set(runId, { access: [nodeId], writes: [nodeId] });
    const start = this.beginStart(nodeId, "optimize");
    try {
      await Promise.all([api.canvasWorkflowAuthorize(), this.waitForWrites()]);
      if (!start.current()) return;
      await api.projectThreadCreate({ id: threadId, projectId: this.projectId, title: "H3 提示词优化", origin: "direct" });
      if (!start.current()) return;
      await this.saveRun({ id: runId, startId: nodeId, threadId, order: [nodeId], lockedNodeIds: [nodeId], writeNodeIds: [nodeId], accountId, status: "running",
        steps: { [nodeId]: { status: "pending", comfyOptimization: { input, instruction: h3OptimizationInstruction(input), inputBindings: JSON.stringify([Object.fromEntries(Object.entries(node.inputs).filter(([port]) => port !== "signal" && port !== "completion")), node.promptReferences]), createdAt: Date.now() } } } });
      if (!start.current()) { await this.stopBeforeDispatch(runId); return; }
      this.reservations.delete(runId);
      await this.continue(runId, start);
    } finally { this.reservations.delete(runId); start.release(); }
    return runId;
  }

  private async resolveComfyPromptOptimization(runId: string, node: WorkflowNode, halted: () => boolean, start?: CardStart) {
    const id = node.id, originalStep = this.run(runId).steps[id];
    const owner = this.executing.get(runId);
    const composedImage = !!originalStep.comfyAutoGeneration?.imageInput;
    const assertAccount = () => {
      const account = this.host.getState();
      if (this.run(runId).accountId !== (account.cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后继续，或停止此工作流");
      if (!canUseComfyVideo(account.cloudAuth, account.cloudEntitlement)) throw new Error("本地 H3 需要有效的 Pro／Studio 权益或测试账号资格");
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
          const source = "referenceCount" in snapshot.input ? imageOptimizationText(snapshot.input.prompt, composedImage) : snapshot.input.prompt;
          if (composedImage && source.length > 16000) throw new Error("包含引用标记的提示词超出自动优化的长度限制，请删减后重试");
          snapshot = { ...snapshot, instruction: h3OptimizationInstruction(snapshot.input), submissionStarted: true };
          await this.step(runId, id, { status: "running", comfyOptimization: snapshot, error: undefined, detail: "提交 H3 提示词优化" });
          if (halted()) return;
          if (start && !start.current()) { await this.stopBeforeDispatch(runId); return; }
          start?.release();
          const created = await api.cloudAgentStart({ intentPrompt: snapshot.instruction, textRewrite: { source }, references: [],
            projectId: this.projectId, threadId: this.run(runId).threadId, imageProvider: "cloud", skillId: "bowerbird-unified-agent", agentRuntime: "dsh" });
          if (halted()) { if (this.executionStopped(runId, owner)) await api.cloudAgentCancel(created.runId); return; }
          agentRunId = created.runId;
          await this.step(runId, id, { agentRunId, detail: "Cloud DSH 正在优化提示词" });
        }
        const pollStarted = Date.now();
        while (!halted()) {
          assertAccount();
          const current = await api.cloudAgentGet(agentRunId);
          if (halted()) return;
          assertAccount();
          this.host.getState().openCloudAgentRun(current, { navigate: false });
          if (["failed", "cancelled"].includes(current.status)) { terminalFailure = true; throw cloudTextRunError(current.snapshot.run, "提示词优化未完成，请检查 Agent 任务记录"); }
          if (current.status.startsWith("awaiting_")) { terminalFailure = true; throw new Error("云端未按文本优化模式执行，请检查 Cloud DSH 服务版本"); }
          if (current.status === "succeeded") {
            terminalFailure = true;
            const payload = current.snapshot.events.find(event => event.type === "text.result")?.display_payload;
            if (payload?.schemaVersion !== 1 || typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 16000) throw new Error("Cloud DSH 未返回有效的优化提示词，请检查任务结果");
            const restored = "referenceCount" in snapshot.input ? restoreImageOptimization(snapshot.input.prompt, payload.text, composedImage) : null;
            const cleaned = restored?.text ?? cleanH3OptimizedPrompt(payload.text);
            const autoInput = originalStep.comfyAutoGeneration?.input;
            const hasAudio = autoInput ? !!autoInput.audioAssetId : !!node.inputs[H3_VIDEO_AUDIO_PORT]?.length;
            const prompt = "mode" in snapshot.input && snapshot.input.mode === "r2v"
              ? restoreH3R2VReferences(snapshot.input.prompt, cleaned, snapshot.input)
              : hasAudio && "mode" in snapshot.input && snapshot.input.mode === "reference"
                ? restoreH3VideoAudioReference(snapshot.input.prompt, cleaned) : cleaned;
            if (!prompt) throw new Error("Cloud DSH 未返回有效的优化提示词，请检查任务结果");
            snapshot = { ...snapshot, result: prompt, keptOriginal: restored?.keptOriginal ?? (prompt !== cleaned ? true : undefined),
              ...(payload.dshContinuation === true ? { dshContinuation: true } : {}) };
            // Save the result before applying it so recovery never repeats the paid request.
            await this.step(runId, id, { comfyOptimization: snapshot });
            break;
          }
          this.progress(runId, id, current.status === "queued" ? "提示词优化排队中" : "Cloud DSH 正在优化提示词");
          if (!await this.waitForPoll(runId, id, pollStarted, 2000, halted)) return;
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
    if ("referenceCount" in snapshot.input && snapshot.result.trim() === snapshot.input.prompt.trim()) {
      const reason = snapshot.keptOriginal ? "优化结果未保留完整的素材引用，已保留原提示词。" : "本次优化返回了相同的提示词，已保留原文。";
      throw new Error(reason + (composedImage ? "可重新运行，或关闭自动优化后使用原提示词生成。" : "可点击重试优化。"));
    }
    return { ...snapshot, result: snapshot.result };
  }

  private async runComfyPromptOptimization(runId: string, node: WorkflowNode, halted: () => boolean, start?: CardStart) {
    const snapshot = await this.resolveComfyPromptOptimization(runId, node, halted, start);
    if (!snapshot || halted()) return;
    const id = node.id;
    const run = this.run(runId);
    await this.saveRun({ ...run, steps: { ...run.steps, [id]: { ...run.steps[id], status: "done", error: undefined, detail: snapshot.keptOriginal ? "优化结果的卡片引用不完整，已保留原提示词" : "提示词已替换" } } },
      this.document.nodes.map(item => item.id === id ? { ...item, ...h3PromptPatch(h3DraftForResult(snapshot.input, snapshot.result, h3OriginalPrompt(item))) } : item));
  }

  private async applyAutoOptimizedDraft(runId: string, id: string, result: string) {
    const run = this.run(runId);
    const step = run.steps[id];
    const snapshot = step.comfyOptimization;
    if (!snapshot?.inputBindings) return;
    const current = this.document.nodes.find(node => node.id === id);
    if (!current) return;
    const original = h3OriginalPrompt(current);
    // A text port can provide the entire optimizer input. Keep the card's own source empty in that case.
    const changes = h3PromptPatch(h3DraftForResult(original.trim() ? snapshot.input : { ...snapshot.input, prompt: original }, result, original));
    const input = step.generationRunInput;
    if (current.prompt === result && input?.prompt === result && JSON.stringify(current.h3Prompt) === JSON.stringify(changes.h3Prompt)) return;
    await this.saveRun(input ? { ...run, steps: { ...run.steps, [id]: { ...step, generationRunInput: { ...input, prompt: result } } } } : run,
      this.document.nodes.map(node => node.id === id ? { ...node, ...changes } : node));
  }

  private async runComfyAutoGeneration(runId: string, node: WorkflowNode, halted: () => boolean, video: ComfyVideoInput, start?: CardStart, linkedText = "", generationRunInput?: WorkflowStep["generationRunInput"]) {
    if (!this.run(runId).steps[node.id].comfyOptimization) {
      const mode = comfyVideoMode(video);
      const draft = node.prompt.trim();
      const input = { prompt: draft || linkedText || video.prompt, mode, seconds: video.seconds, ratio: video.ratio,
        firstFrameCount: video.firstFrame ? 1 : 0, lastFrameCount: video.lastFrame ? 1 : 0,
        ...(mode === "r2v" ? h3R2VPromptReferences(video) : { audioReference: video.audioAssetId ? true as const : undefined }) };
      await this.step(runId, node.id, { generationRunInput, comfyAutoGeneration: { input: video, videoText: draft ? linkedText : "" },
        comfyOptimization: { input, instruction: h3OptimizationInstruction(input), createdAt: Date.now(),
          inputBindings: JSON.stringify([node.inputs, node.promptReferences]) } });
    }
    if (halted()) return;
    const optimized = await this.resolveComfyPromptOptimization(runId, node, halted, start);
    if (!optimized || halted()) return;
    await this.applyAutoOptimizedDraft(runId, node.id, optimized.result);
    if (halted()) return;
    const text = this.run(runId).steps[node.id].comfyAutoGeneration?.videoText;
    let prompt = text ? `${text}\n\n${optimized.result}` : optimized.result;
    if (video.audioAssetId && comfyVideoMode(video) === "reference" && !prompt.includes("<Audio 1>")) prompt += "\n<Audio 1>";
    await this.runComfyVideo(runId, node, halted, { ...video, prompt });
  }

  private async runComfyAutoImage(runId: string, node: WorkflowNode, halted: () => boolean, image: H3ImageGenerationInput, start?: CardStart) {
    if (this.run(runId).steps[node.id].jobId) {
      await this.runWorkflowImageSession(runId, node, halted);
      return;
    }
    const optimized = await this.resolveComfyPromptOptimization(runId, node, halted, start);
    if (!optimized || halted()) return;
    await this.applyAutoOptimizedDraft(runId, node.id, optimized.result);
    if (halted()) return;
    const assets = image.assetIds.length ? await api.getAssetsByIds(image.assetIds) : [];
    const references = image.assetIds.map(id => {
      const asset = assets.find(asset => asset.id === id);
      if (!asset?.store_path || asset.duration || isVideoPath(asset.store_path) || isAudioPath(asset.store_path)) {
        throw new Error("参考图已缺失，请检查素材后重新运行");
      }
      return asset;
    });
    if (halted()) return;
    await this.runWorkflowImageSession(runId, node, halted, {
      ...image, references, prompt: image.promptParts ? renderGenerationDraft(optimized.result, image.promptParts) : optimized.result,
      rawPrompt: image.promptParts ? renderGenerationDraft(optimized.input.prompt, image.promptParts) : optimized.input.prompt,
    });
  }

  private async runWorkflowImageSession(runId: string, node: WorkflowNode, halted: () => boolean, input?: WorkflowImageSessionInput) {
    const id = node.id, step = this.run(runId).steps[id];
    let { jobId, turnKey } = step;
    if (!jobId) {
      const optimizedForThisRun = !!(step.comfyAutoGeneration?.imageInput && step.comfyOptimization?.result);
      if (!input || step.status !== "pending" && !optimizedForThisRun) throw new Error("无法确认上次提交状态，请检查任务中心");
      jobId = crypto.randomUUID(); turnKey = crypto.randomUUID();
      const sessionNodeId = `gen-prompt:${jobId}:${turnKey}:0`;
      // Persist both recovery identity and ownership before calling the provider.
      const run = this.run(runId);
      await this.saveRun({ ...run, steps: { ...run.steps, [id]: { ...run.steps[id], status: "running", jobId, turnKey, generationSubmission: "pending",
        generationRunInput: input.generationRunInput ?? run.steps[id].generationRunInput } } },
        this.document.nodes.map(candidate => candidate.id === id ? { ...candidate, activeSessionNodeId: sessionNodeId,
          sessionNodeIds: [...(candidate.sessionNodeIds ?? []), sessionNodeId] } : candidate));
      if (halted()) return;
      if (optimizedForThisRun && run.accountId !== (this.host.getState().cloudAuth?.user_id ?? null)) {
        throw new Error("账号已切换，请登录原账号后重新运行");
      }
      const result = await this.host.getState().startGeneration(input.prompt, input.references, input.ratio, workflowGenerationProvider(node),
        input.rawPrompt, undefined, undefined, undefined, input.visualProfileId,
        { projectId: this.projectId, threadId: run.threadId, referenceNodeIds: input.referenceNodeIds }, true, undefined, { jobId, turnKey });
      if (!result.accepted) throw new Error(result.error || "生成任务未提交");
    } else if (step.generationSubmission !== "submitted") {
      const submitted = turnKey && await api.agentDsWorkflowGenerationJob(jobId, turnKey);
      if (halted()) return;
      if (!submitted) {
        await this.step(runId, id, { status: "waiting", error: "无法确认原生成任务是否已提交，请检查任务中心后继续；不会重复提交" }); return;
      }
    }
    if (halted()) return;
    if (!turnKey) throw new Error("原生成任务缺少轮次身份，请检查原任务");
    this.generationHandoffs.set(id, { runId, jobId, turnKey });
    await this.step(runId, id, { generationSubmission: "submitted", detail: "生成任务已提交" });
    if (!await this.deliverSubmittedSessions(runId, node, halted)) return;
    await this.finish(runId, node, { image: { type: "image", nodeIds: [`gen-prompt:${jobId}:${turnKey}:0`] } });
  }

  private cardExecution(runId: string, halted: () => boolean): WorkflowCardExecution {
    const controller = this, owner = this.executing.get(runId);
    const isStopped = (id: string) => halted() || this.executionStopped(id, owner);
    return {
      projectId: this.projectId,
      desktop: this.host,
      get document() { return controller.document; },
      run: id => this.run(id),
      save: async document => { if (!isStopped(runId)) await this.save(document); },
      saveRun: async (run, nodes) => { if (!isStopped(run.id)) await this.saveRun(run, nodes); },
      step: async (run, node, patch) => { if (!isStopped(run)) await this.step(run, node, patch); },
      progress: (run, node, detail, videoProgress) => { if (!isStopped(run)) this.progress(run, node, detail, videoProgress); },
      finish: async (run, node, outputs, ports) => { if (!isStopped(run)) await this.finish(run, node, outputs, ports); },
      isStopped,
      stopBeforeDispatch: async run => { if (!isStopped(run)) await this.stopBeforeDispatch(run); },
      waitForPoll: (...args) => this.waitForPoll(...args),
      resolveInputGenerations: (...args) => this.resolveInputGenerations(...args),
      deliverMediaAsset: (run, node, asset, halted, resultId) => this.deliverMediaAsset(run, node, asset, halted, resultId),
      chatResult: (run, node, step, assets, halted) => this.chatResult(run, node, step, assets, halted),
      localDsResult: (run, node, step, paths, halted) => this.localDsResult(run, node, step, paths, halted),
      writeAgentText: (run, node, value, writers, halted) => this.writeAgentText(run, node, value, writers, halted),
      writeAgentResult: (run, node, value, hasWriters, halted) => this.writeAgentResult(run, node, value, hasWriters, halted),
      runComfyAutoGeneration: (run, node, halted, input, start, text, preview) => this.runComfyAutoGeneration(run, node, halted, input, start, text, preview),
      runComfyAutoImage: (run, node, halted, input, start) => this.runComfyAutoImage(run, node, halted, input, start),
      runWorkflowImageSession: (run, node, halted, input) => this.runWorkflowImageSession(run, node, halted, input),
    };
  }

  private async runComfyVideo(runId: string, node: WorkflowNode, halted: () => boolean, input?: ComfyVideoInput, start?: CardStart, generationRunInput?: WorkflowStep["generationRunInput"]) {
    return runWorkflowComfyVideo(this.cardExecution(runId, halted), runId, node, halted, input, start, generationRunInput);
  }

  async recoverComfyVideo(runId: string, nodeId?: string) {
    if (this.run(runId)?.status !== "stopped" || this.stopping.has(runId)) return;
    // The card is stopped before the old poll returns. Preserve an immediate
    // click on Take back and resume only after that poll has released the run.
    await this.executionDrains.get(runId);
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

  async continue(runId = this.document.run?.id, start?: CardStart) {
    if (!runId || this.executing.has(runId) || this.stopping.has(runId) || !this.run(runId) || !workflowRunActive(this.run(runId))) return;
    if (this.issue?.runId === runId) this.issue = null;
    const owner = Symbol(runId), abort = new AbortController();
    this.executing.set(runId, owner); this.executionAborts.set(runId, abort); this.stopped.delete(runId);
    let currentId = "";
    let drained!: () => void;
    this.executionDrains.set(runId, new Promise<void>(resolve => { drained = resolve; }));
    const failures = new Map<string, unknown>();
    const executionStopped = () => this.executionStopped(runId, owner);
    const halted = () => executionStopped() || failures.size > 0;
    const active = new Map<string, Promise<void>>();
    const attempted = new Set<string>();
    const controller = this;
    const execute = createWorkflowStepExecutor({
      ...this.cardExecution(runId, halted),
      get document() { return controller.document; },
      layoutNodes: () => this.layoutNodes(),
      writeContentInput: (...args) => this.writeContentInput(...args),
      withResource: (key, work) => this.withResource(key, work),
      recoverVideoResult: (...args) => this.recoverVideoResult(...args),
      runComfyPromptOptimization: (...args) => this.runComfyPromptOptimization(...args),
      runComfyVideo: (...args) => this.runComfyVideo(...args),
    }, { runId, start, halted, executionStopped, signal: abort.signal });
    try {
      await this.waitForWrites();
      if (halted()) return;
      if (this.run(runId).status !== "running") await this.saveRun({ ...this.run(runId), status: "running" });
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
          const triggers = () => next || current.completionRecoveryOnly ? [] : workflowCompletionTriggers(this.document.nodes, loop.nodeId);
          if (triggers().length) {
            // Image steps can finish submitting before the images themselves are ready.
            const sessions = completed.flatMap(item => Object.values(item.outputs).flatMap(Object.values)).filter(value => value.nodeIds?.length);
            const owner = nodes.find(node => node.id === loop.nodeId)!;
            currentId = loop.nodeId;
            if (sessions.length && !await this.resolveInputGenerations(runId, owner, structuredClone(sessions), halted)) break;
            currentId = "";
          }
          const latest = this.run(runId);
          const steps = { ...latest.steps, [loop.nodeId]: { status: "done" as const, detail: next ? `第 ${index + 1} / ${loop.items.length} 项` : `已完成 ${completed.length} / ${loop.items.length - (loop.startIndex ?? 0)} 项` } };
          if (next) for (const id of loop.bodyIds) steps[id] = { status: "pending" };
          const completedTriggers = triggers();
          // Persist the completed item and the next cursor together, before any new submission.
          await this.saveRun({ ...latest, loop: { ...loop, index, completed }, steps,
            ...(completedTriggers.length ? { triggerQueue: [...(latest.triggerQueue ?? []), ...completedTriggers.map(trigger => trigger.id)] } : {}) }, this.document.nodes.map(node =>
            node.id === loop.nodeId ? { ...node, outputs: workflowLoopOutputs(loop.items![index], index) }
              : next && loop.bodyIds.includes(node.id) ? { ...node, outputs: {}, ...(node.kind === "generation" ? { activeSessionNodeId: null } : {}) } : node));
          if (next) for (const id of loop.bodyIds) attempted.delete(id);
          if (halted()) break;
        }
        for (const id of run.order) {
          if (attempted.has(id) || this.run(runId).steps[id].status === "done"
            || !dependencies.get(id)!.every(producer => this.run(runId).steps[producer].status === "done")) continue;
          attempted.add(id);
          const task = execute(id).catch(error => {
            if (executionStopped()) return;
            failures.set(id, error); abort.abort(); this.emit();
          }).finally(() => { active.delete(id); });
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
          try {
            let next;
            try {
              const order = workflowOrder(this.document.nodes, triggerId);
              if (order.length < 2) throw new WorkflowNodeError("触发器还没有连接下游卡片，请从「触发」端口连接", trigger);
              const executionNodes = workflowExecutionNodes(this.document.nodes, triggerId);
              const loop = workflowLoopScope(executionNodes, order);
              // A receiver may have been connected or armed after the source started.
              // Reserve its current scope before changing order or consuming its budget.
              const lockedNodeIds = workflowDependencies(executionNodes, order);
              const writeNodeIds = workflowWriteNodes(executionNodes, order);
              const conflicts = workflowRuns(this.document).filter(other => other.id !== runId && workflowRunActive(other)).some(other =>
                workflowAccessConflict(this.document.nodes, lockedNodeIds, writeNodeIds, other.lockedNodeIds ?? workflowDependencies(this.document.nodes, other.order),
                  other.writeNodeIds ?? workflowWriteNodes(this.document.nodes, other.order)))
                || [...this.reservations.values()].some(other => workflowAccessConflict(this.document.nodes, lockedNodeIds, writeNodeIds, other.access, other.writes));
              if (conflicts) throw new WorkflowNodeError("触发器下游正在被其他工作流使用，请等待该流程结束后继续；本次触发尚未扣数。", trigger);
              this.reservations.set(runId, { access: lockedNodeIds, writes: writeNodeIds });
              this.emit();
              let snapshot: Promise<ProjectCanvasSnapshot> | undefined;
              const authorized = this.document.nodes.some(node => workflowNodeRequiresPro(node) && completed.steps[node.id]?.status === "done");
              const phase = await this.preparePhase(order, executionNodes, writeNodeIds, loop,
                () => snapshot ??= api.projectCanvasGet(this.projectId), this.document.nodes, authorized);
              next = { order, loop, lockedNodeIds, writeNodeIds, ...phase };
            } catch (error) {
              if (halted()) return;
              if (!this.document.nodes.some(node => node.id === triggerId) || this.run(runId).triggerQueue?.[0] !== triggerId) continue;
              // Only the event is pending. Neither the finished source nor the busy target belongs to this run.
              await this.saveRun({ ...this.run(runId), startId: triggerId, order: [], loop: undefined, lockedNodeIds: [], writeNodeIds: [], status: "waiting" });
              this.showIssue(workflowDiagnostic(error, trigger, "execution", runId));
              return;
            }
            const { order, loop, lockedNodeIds, writeNodeIds, cellTexts, cellValues, freezeInputs } = next;
            if (halted()) return;
            const currentTrigger = this.document.nodes.find(node => node.id === triggerId);
            if (!currentTrigger || this.run(runId).triggerQueue?.[0] !== triggerId || workflowTriggerMode(currentTrigger) !== "completion"
              || !(currentTrigger.triggerCount! > 0)) continue;
            // One save commits the event, decremented budget and fresh task steps before submission.
            await this.saveRun({ ...this.run(runId), startId: triggerId, order, loop, triggerQueue: this.run(runId).triggerQueue?.slice(1), lockedNodeIds, writeNodeIds, cellTexts, cellValues,
              steps: { ...completed.steps, ...Object.fromEntries(order.map(id => [id, { status: "pending" as const }])) } },
              this.document.nodes.map(node => ({ ...node,
                ...(node.id === triggerId ? { triggerCount: Math.max(0, (node.triggerCount ?? 0) - 1) } : {}),
                ...(order.includes(node.id) ? { inputs: freezeInputs(node), outputs: {}, ...(node.kind === "generation" ? { activeSessionNodeId: null } : {}) } : {}),
              })));
          } finally {
            if (this.executing.get(runId) === owner) this.reservations.delete(runId);
            this.emit();
          }
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

      if (!executionStopped()) {
        const run = this.run(runId);
        await this.saveRun({ ...run, status: run.order.every(id => run.steps[id].status === "done") ? "done" : "waiting" });
      }
    } catch (error) {
      if (!executionStopped() && this.run(runId)) {
        const run = this.run(runId);
        // Preserve identity for read-only recovery; never automatically resubmit after an error.
        const steps = { ...run.steps };
        if (currentId && !failures.size) failures.set(currentId, error);
        for (const [id, reason] of failures) {
          const node = this.document.nodes.find(node => node.id === id);
          const diagnostic = node && workflowDiagnostic(reason, node, "execution", runId, run.order.indexOf(id) + 1);
          if (id === currentId && diagnostic) this.issue = diagnostic;
          steps[id] = { ...steps[id], status: "failed", error: String(reason), ...(run.loop ? { retrySafe: steps[id].status === "pending" || node?.kind === "text" || node?.kind === "loop" } : {}), ...(diagnostic ? { diagnostic } : {}) };
          if (run.loop && reason instanceof ConfirmedDshTurnFailure) steps[id].confirmedFailedChatTurnId = steps[id].chatTurnId;
        }
        this.stopped.add(runId);
        const deliveryFailure = failures.size > 0 && [...failures.keys()].every(id => this.document.nodes.some(node => node.id === id && node.textTarget));
        await this.saveRun({ ...run, status: run.loop || deliveryFailure ? "waiting" : "failed", triggerQueue: run.loop || deliveryFailure ? run.triggerQueue : [], steps }).catch(() => {});
      }
    } finally {
      await Promise.all(active.values());
      this.releaseExecution(runId, owner);
      drained(); this.emit();
    }
  }
}
