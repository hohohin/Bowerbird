import type { WorkflowNode } from "./canvasWorkflow";

type Schedule = NonNullable<WorkflowNode["triggerSchedule"]>;

/** Old documents infer their mode from the existing appointment or completion wire. */
export function workflowTriggerMode(node: WorkflowNode): NonNullable<WorkflowNode["triggerMode"]> {
  return node.triggerMode ?? (node.triggerSchedule ? node.triggerSchedule.dailyAt ? "daily" : "once"
    : node.inputs.completion?.length ? "completion" : "manual");
}

export function activeTriggerSchedule(node: WorkflowNode): Schedule | undefined {
  if (node.kind !== "trigger" || !node.triggerSchedule) return undefined;
  const mode = workflowTriggerMode(node);
  return (mode === "daily" && !!node.triggerSchedule.dailyAt || mode === "once" && !node.triggerSchedule.dailyAt) ? node.triggerSchedule : undefined;
}

/** Calendar days preserve the chosen local time across DST, unlike adding 24 hours. */
export function nextDailyTrigger(time: string, after: number): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
  const [hour, minute] = time.split(":").map(Number), date = new Date(after);
  const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute).getTime();
  return at > after ? at : new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, hour, minute).getTime();
}

export function triggerScheduleOccurrence(schedule: Schedule): string {
  return schedule.dailyAt ? `${schedule.id}@${schedule.at}` : schedule.id;
}

/** Consume one occurrence; a daily appointment remains armed for the next local day. */
export function advanceTriggerSchedule(schedule: Schedule, now = Date.now()): Schedule {
  return schedule.dailyAt ? { ...schedule, at: nextDailyTrigger(schedule.dailyAt, Math.max(schedule.at, now)), status: "armed" }
    : { ...schedule, status: "fired" };
}
