import { api } from "./api";
import { canvasSessionCompletionStatus, submittedTurnState } from "./canvasSessionOutputs";
import { workflowRuns, workflowRunActive, type CanvasWorkflow, type WorkflowNode } from "./canvasWorkflow";
import { activeTriggerSchedule, advanceTriggerSchedule, triggerScheduleOccurrence, workflowTriggerMode } from "./workflowTriggerSchedule";
import { workflowDiagnostic, type WorkflowDiagnostic } from "./workflowDiagnostics";
import type { CanvasNode, GenJob } from "./types";

interface WorkflowTriggerHost {
  readonly projectId: string;
  readonly document: CanvasWorkflow;
  readonly genJobs: Record<string, GenJob>;
  readonly ready: boolean;
  readonly discarded: boolean;
  readonly encapsulating: boolean;
  readonly executing: boolean;
  readonly error: string;
  save(document: CanvasWorkflow): Promise<void>;
  startRun(nodeId: string, single: boolean, completionSessionId?: string, background?: boolean, scheduleId?: string): Promise<void>;
  showIssue(issue: WorkflowDiagnostic): void;
}

const completionPollDelay = 1500;
const maximumTriggerDelay = 20_000;
const sessionCompletionTrigger = (node: WorkflowNode) => node.kind === "trigger" && workflowTriggerMode(node) === "completion"
  && node.inputs.completion?.some(input => input.canvasNodeId || input.pendingCompletionSession);
function sessionCompletionConfigChanged(before: CanvasWorkflow, after: CanvasWorkflow) {
  const previous = new Map(before.nodes.filter(sessionCompletionTrigger).map(node => [node.id, node]));
  const current = after.nodes.filter(sessionCompletionTrigger);
  return previous.size !== current.length || current.some(node => {
    const prior = previous.get(node.id);
    return !prior || prior.inputs.completion !== node.inputs.completion || prior.triggerCount !== node.triggerCount;
  });
}

export class WorkflowTriggerScheduler {
  private sessionCompletionTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionCompletionRequest?: { canvas?: readonly CanvasNode[] };
  private pendingSessionCompletion = false;
  private blockedSessionCompletion = false;
  private completionBackoff = completionPollDelay;
  private canvasActive = true;
  private checkingSessionCompletions = false;
  private dispatchingSessionCompletions = new Set<string>();
  private sessionCompletionFailures = new Set<string>();
  private historicalSessionCompletions = new Set<string>();
  private triggerTimer: ReturnType<typeof setTimeout> | undefined;
  private triggerTimersEnabled = true;
  private dispatchingSchedule = false;
  constructor(private readonly host: WorkflowTriggerHost) {}

  get enabled() { return this.triggerTimersEnabled; }
  initHistory(completed: Set<string>) { this.historicalSessionCompletions = completed; }
  clearFailures() { this.sessionCompletionFailures.clear(); }
  discard() { clearTimeout(this.triggerTimer); this.clearSessionCompletionTimer(); }

  documentSaved(previous: CanvasWorkflow, current: CanvasWorkflow) {
    const releasesBlockedRun = this.blockedSessionCompletion && workflowRuns(previous).some(run => workflowRunActive(run)
      && !workflowRuns(current).some(candidate => candidate.id === run.id && workflowRunActive(candidate)));
    if (this.hasSessionCompletionTargets() && (sessionCompletionConfigChanged(previous, current) || releasesBlockedRun)) this.notifySessionCompletionChange();
  }

  documentRefreshed(previous: CanvasWorkflow, current: CanvasWorkflow) {
    if (sessionCompletionConfigChanged(previous, current)) this.notifySessionCompletionChange();
  }
  setTriggerTimersEnabled(enabled: boolean) {
    this.triggerTimersEnabled = enabled;
    this.scheduleTriggers();
  }
  setCanvasActive(active: boolean) {
    if (active === this.canvasActive) return;
    this.canvasActive = active;
    if (active) this.notifySessionCompletionChange();
    else if (!this.pendingSessionCompletion && !this.host.executing) this.clearSessionCompletionTimer();
  }
  wakeSchedule() {
    this.scheduleTriggers();
    if (this.canvasActive || this.pendingSessionCompletion || this.host.executing) this.notifySessionCompletionChange();
  }
  scheduleTriggers() {
    clearTimeout(this.triggerTimer);
    this.triggerTimer = undefined;
    if (this.host.discarded || !this.triggerTimersEnabled || !this.host.ready || this.host.error || this.dispatchingSchedule) return;
    const pending = this.host.document.nodes.flatMap(node => { const schedule = activeTriggerSchedule(node); return schedule?.status === "armed" ? [schedule.at] : []; });
    if (!pending.length) return;
    // Short bounded waits tolerate system-clock changes and resume from sleep.
    const remaining = Math.min(...pending) - Date.now();
    this.triggerTimer = setTimeout(() => {
      this.triggerTimer = undefined;
      void this.checkScheduledTriggers();
    }, remaining > 0 ? Math.min(maximumTriggerDelay, remaining) : 1000);
  }
  async checkScheduledTriggers() {
    if (!this.triggerTimersEnabled || !this.host.ready || this.host.error || this.dispatchingSchedule || this.host.encapsulating) { this.scheduleTriggers(); return; }
    this.dispatchingSchedule = true;
    try {
      for (const node of this.host.document.nodes) {
        const schedule = activeTriggerSchedule(node);
        if (node.kind !== "trigger" || schedule?.status !== "armed" || schedule.at > Date.now()) continue;
        try { await this.host.startRun(node.id, false, undefined, true, triggerScheduleOccurrence(schedule)); }
        catch (error) {
          this.host.showIssue(workflowDiagnostic(error, node, "validation"));
          // Never retry the same occurrence after validation failure. Daily schedules keep tomorrow.
          if (!this.host.error && this.host.document.nodes.find(current => current.id === node.id)?.triggerSchedule?.id === schedule.id) {
            await this.host.save({ ...this.host.document, nodes: this.host.document.nodes.map(current => current.id === node.id && current.triggerSchedule?.status === "armed"
              ? { ...current, triggerSchedule: schedule.dailyAt ? advanceTriggerSchedule(schedule) : { ...schedule, status: "failed" } } : current) });
          }
        }
      }
    } catch (error) { console.warn("保存定时触发状态失败", error); }
    finally { this.dispatchingSchedule = false; this.scheduleTriggers(); }
  }
  private hasSessionCompletionTargets() {
    return this.host.document.nodes.some(sessionCompletionTrigger);
  }
  private clearSessionCompletionTimer() {
    clearTimeout(this.sessionCompletionTimer);
    this.sessionCompletionTimer = undefined;
  }
  notifySessionCompletionChange(canvas?: readonly CanvasNode[]) {
    if (this.host.discarded || !this.host.ready || !this.hasSessionCompletionTargets()) return;
    // An event may be newer than the projected canvas still mounted in React.
    if (!canvas || !this.sessionCompletionRequest || this.sessionCompletionRequest.canvas) this.sessionCompletionRequest = { canvas };
    this.completionBackoff = completionPollDelay;
    this.clearSessionCompletionTimer();
    this.scheduleSessionCompletions();
  }
  scheduleSessionCompletions() {
    if (this.host.discarded || !this.host.ready || this.host.error || !this.hasSessionCompletionTargets()) {
      this.clearSessionCompletionTimer();
      return;
    }
    if (this.sessionCompletionTimer !== undefined || this.checkingSessionCompletions || this.host.encapsulating) return;
    if (!this.sessionCompletionRequest && !this.pendingSessionCompletion) return;
    const delay = this.sessionCompletionRequest ? 0 : this.completionBackoff;
    if (delay) this.completionBackoff = Math.min(maximumTriggerDelay, delay * 2);
    this.sessionCompletionTimer = setTimeout(() => {
      this.sessionCompletionTimer = undefined;
      const request = this.sessionCompletionRequest;
      this.sessionCompletionRequest = undefined;
      void this.checkSessionCompletions(request?.canvas);
    }, delay);
  }
  private async checkSessionCompletions(knownCanvas?: readonly CanvasNode[]) {
    if (this.host.discarded || !this.host.ready || this.host.error || this.checkingSessionCompletions || this.host.encapsulating || !this.hasSessionCompletionTargets()) return;
    this.checkingSessionCompletions = true;
    try {
      const watchedTurns = this.host.document.nodes.flatMap(node => node.inputs.completion?.flatMap(input => input.pendingCompletionSession ?? []) ?? []);
      const knownTurns = knownCanvas && watchedTurns.length ? new Set(knownCanvas.filter(node => node.kind === "prompt").map(node => node.id)) : undefined;
      const canvas = knownCanvas && (!knownTurns || watchedTurns.every(id => knownTurns.has(id)))
        ? knownCanvas : (await api.projectCanvasGet(this.host.projectId)).nodes;
      if (this.host.discarded) return;
      const closed = new Set(watchedTurns.filter(id => this.historicalSessionCompletions.has(id) || submittedTurnState(id, canvas) === "closed"));
      if (closed.size) await this.host.save({ ...this.host.document, nodes: this.host.document.nodes.map(node => {
        if (!node.inputs.completion?.some(input => input.pendingCompletionSession && closed.has(input.pendingCompletionSession))) return node;
        return { ...node, inputs: { ...node.inputs, completion: node.inputs.completion.map(input =>
          input.pendingCompletionSession && closed.has(input.pendingCompletionSession) ? { ...input, pendingCompletionSession: undefined } : input) } };
      }) });
      const status = canvasSessionCompletionStatus(canvas, this.host.genJobs);
      this.pendingSessionCompletion = false;
      this.blockedSessionCompletion = false;
      for (const id of this.host.document.nodes.filter(sessionCompletionTrigger).map(node => node.id)) {
        const node = this.host.document.nodes.find(node => node.id === id);
        if (!node || workflowTriggerMode(node) !== "completion") continue;
        const { completed, pending } = status(node.inputs.completion ?? []);
        this.pendingSessionCompletion ||= pending && (node.triggerCount ?? 0) > 0;
        if (this.dispatchingSessionCompletions.has(id)) continue;
        const unseen = completed.filter(id => !node.completionSeen?.includes(id) && !this.historicalSessionCompletions.has(id));
        if (!unseen.length) continue;
        if (!(node.triggerCount! > 0)) {
          await this.host.save({ ...this.host.document, nodes: this.host.document.nodes.map(current => current.id === id
            ? { ...current, completionSeen: [...(current.completionSeen ?? []), ...unseen] } : current) });
          continue;
        }
        const sessionId = unseen[0], key = `${id}:${sessionId}`;
        if (this.sessionCompletionFailures.has(key)) continue;
        this.blockedSessionCompletion = true;
        this.dispatchingSessionCompletions.add(id);
        void this.host.startRun(id, false, sessionId).catch(error => {
          this.sessionCompletionFailures.add(key);
          this.host.showIssue(workflowDiagnostic(error, node, "validation"));
        }).finally(() => {
          this.dispatchingSessionCompletions.delete(id);
          if (this.host.document.nodes.some(node => node.id === id && node.completionSeen?.includes(sessionId))) this.notifySessionCompletionChange();
          else if (!this.sessionCompletionFailures.has(key)) this.blockedSessionCompletion = true;
        });
      }
    } catch (error) {
      // Canvas reads can fail transiently; a failed durable write already blocks execution.
      console.warn("读取绘画会话完成状态失败", error);
    } finally {
      this.checkingSessionCompletions = false;
      this.scheduleSessionCompletions();
    }
  }
}
