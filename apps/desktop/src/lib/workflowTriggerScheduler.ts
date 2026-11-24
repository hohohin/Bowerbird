import type { CanvasWorkflow } from "./canvasWorkflow";
import type { WorkflowDiagnostic } from "./workflowDiagnostics";
import { workflowDiagnostic } from "./workflowDiagnostics";
import { activeTriggerSchedule, advanceTriggerSchedule, triggerScheduleOccurrence, workflowTriggerMode } from "./workflowTriggerSchedule";
import { completedCanvasSessions, submittedTurnState } from "./canvasSessionOutputs";
import { api } from "./api";
import { useStore } from "../store";

interface ScheduleHost {
  readonly projectId: string;
  readonly document: CanvasWorkflow;
  readonly ready: boolean;
  readonly error: string;
  save(document: CanvasWorkflow): Promise<void>;
  showIssue(issue: WorkflowDiagnostic): void;
}

export class WorkflowTriggerScheduler {
  constructor(private host: ScheduleHost,
    private startRun: (nodeId: string, single: boolean, sessionId?: string, background?: boolean, scheduleId?: string) => Promise<void>,
    private isEncapsulating: () => boolean,
    private onIdle: () => void) {}

  private disposed = false;
  get active() {
    return !!this.triggerTimer || !!this.sessionCompletionTimer || this.dispatchingSchedule
      || this.checkingSessionCompletions || this.dispatchingSessionCompletions.size > 0;
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.triggerTimer);
    clearTimeout(this.sessionCompletionTimer);
  }
  private sessionCompletionTimer: ReturnType<typeof setTimeout> | undefined;
  private checkingSessionCompletions = false;
  private dispatchingSessionCompletions = new Set<string>();
  readonly sessionCompletionFailures = new Set<string>();
  historicalSessionCompletions = new Set<string>();
  private triggerTimer: ReturnType<typeof setTimeout> | undefined;
  triggerTimersEnabled = true;
  private dispatchingSchedule = false;
  setTriggerTimersEnabled(enabled: boolean) {
    this.triggerTimersEnabled = enabled;
    this.scheduleTriggers();
  }
  scheduleTriggers() {
    clearTimeout(this.triggerTimer);
    this.triggerTimer = undefined;
    if (this.disposed || !this.triggerTimersEnabled || !this.host.ready || this.host.error || this.dispatchingSchedule) return;
    const pending = this.host.document.nodes.flatMap(node => { const schedule = activeTriggerSchedule(node); return schedule?.status === "armed" ? [schedule.at] : []; });
    if (!pending.length) return;
    // Short bounded waits tolerate system-clock changes and resume from sleep.
    const remaining = Math.min(...pending) - Date.now();
    this.triggerTimer = setTimeout(() => {
      this.triggerTimer = undefined;
      void this.checkScheduledTriggers();
    }, remaining > 0 ? Math.min(1000, remaining) : 1000);
  }
  async checkScheduledTriggers() {
    if (!this.triggerTimersEnabled || !this.host.ready || this.host.error || this.dispatchingSchedule || this.isEncapsulating()) { this.scheduleTriggers(); return; }
    this.dispatchingSchedule = true;
    try {
      for (const node of this.host.document.nodes) {
        const schedule = activeTriggerSchedule(node);
        if (node.kind !== "trigger" || schedule?.status !== "armed" || schedule.at > Date.now()) continue;
        try { await this.startRun(node.id, false, undefined, true, triggerScheduleOccurrence(schedule)); }
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
    finally { this.dispatchingSchedule = false; this.scheduleTriggers(); this.onIdle(); }
  }
  scheduleSessionCompletions() {
    if (this.disposed || this.sessionCompletionTimer || !this.host.ready || this.host.error || !this.host.document.nodes.some(node =>
      node.kind === "trigger" && workflowTriggerMode(node) === "completion" && (node.triggerCount ?? 0) > 0 && node.inputs.completion?.some(input => input.canvasNodeId || input.pendingCompletionSession && !node.completionSeen?.includes(input.pendingCompletionSession)))) return;
    this.sessionCompletionTimer = setTimeout(() => {
      this.sessionCompletionTimer = undefined;
      void this.checkSessionCompletions();
    }, 1500);
  }
  async checkSessionCompletions() {
    if (!this.host.ready || this.host.error || this.checkingSessionCompletions || this.isEncapsulating()) return;
    this.checkingSessionCompletions = true;
    try {
      if (!this.host.document.nodes.some(node => node.kind === "trigger" && workflowTriggerMode(node) === "completion" && node.inputs.completion?.some(input => input.canvasNodeId || input.pendingCompletionSession))) return;
      const watchedTurns = this.host.document.nodes.flatMap(node => node.inputs.completion?.flatMap(input => input.pendingCompletionSession ?? []) ?? []);
      const canvas = await api.projectCanvasGet(this.host.projectId);
      if (this.disposed) return;
      const closed = new Set(watchedTurns.filter(id => this.historicalSessionCompletions.has(id) || submittedTurnState(id, canvas.nodes) === "closed"));
      if (closed.size) await this.host.save({ ...this.host.document, nodes: this.host.document.nodes.map(node => {
        if (!node.inputs.completion?.some(input => input.pendingCompletionSession && closed.has(input.pendingCompletionSession))) return node;
        return { ...node, inputs: { ...node.inputs, completion: node.inputs.completion.map(input =>
          input.pendingCompletionSession && closed.has(input.pendingCompletionSession) ? { ...input, pendingCompletionSession: undefined } : input) } };
      }) });
      for (const id of this.host.document.nodes.filter(node => node.kind === "trigger").map(node => node.id)) {
        const node = this.host.document.nodes.find(node => node.id === id);
        if (this.disposed) return;
        if (!node || workflowTriggerMode(node) !== "completion" || this.dispatchingSessionCompletions.has(id)) continue;
        const completed = completedCanvasSessions(node.inputs.completion ?? [], canvas.nodes, useStore.getState().genJobs);
        const unseen = completed.filter(id => !node.completionSeen?.includes(id) && !this.historicalSessionCompletions.has(id));
        if (!unseen.length) continue;
        if (!(node.triggerCount! > 0)) {
          await this.host.save({ ...this.host.document, nodes: this.host.document.nodes.map(current => current.id === id
            ? { ...current, completionSeen: [...(current.completionSeen ?? []), ...unseen] } : current) });
          continue;
        }
        const sessionId = unseen[0], key = `${id}:${sessionId}`;
        if (this.sessionCompletionFailures.has(key)) continue;
        this.dispatchingSessionCompletions.add(id);
        void this.startRun(id, false, sessionId).catch(error => {
          this.sessionCompletionFailures.add(key);
          this.host.showIssue(workflowDiagnostic(error, node, "validation"));
        }).finally(() => { this.dispatchingSessionCompletions.delete(id); this.scheduleSessionCompletions(); this.onIdle(); });
      }
    } catch (error) {
      // Canvas reads can fail transiently; a failed durable write already blocks execution.
      console.warn("读取绘画会话完成状态失败", error);
    } finally {
      this.checkingSessionCompletions = false;
      this.scheduleSessionCompletions();
      this.onIdle();
    }
  }
}
