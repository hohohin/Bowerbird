import type { CloudAgentRunRecord, GenJob, JimengOrphanTask } from "./types";
import type { VisualProfileTask } from "./visualProfileTasks";

export function visualProfileReminderKey(task: VisualProfileTask): string | null {
  return task.status === "succeeded" || task.status === "failed" ? JSON.stringify(["visual-profile", task.id, task.status]) : null;
}

export const waitingReminderStatuses = new Set([
  "awaiting_clarification", "awaiting_approval", "awaiting_result_feedback",
]);

// Receipt identities use persisted event data, never poll timestamps or local turn ids.
export function generationReminderKey(job: GenJob): string | null {
  if (job.running || !job.turns.some((turn) => turn.error)) return null;
  return JSON.stringify(["generation", job.id, job.turns.map((turn, index) => [
    turn.turnKey ?? index, turn.error ?? null,
  ])]);
}

export function agentReminderKey(run: CloudAgentRunRecord): string | null {
  if (!waitingReminderStatuses.has(run.status) && run.status !== "failed" && run.status !== "succeeded") return null;
  const snapshot = run.snapshot;
  const approvals = (snapshot.approvals ?? []).filter((item) => item.status === "pending").map((item) => item.id).sort();
  const clarifications = (snapshot.clarifications ?? []).filter((item) => item.status === "pending").map((item) => item.id).sort();
  const artifacts = (snapshot.artifacts ?? []).map((item) => `${item.id}:${item.sha256}`).sort();
  return JSON.stringify(["agent", run.runId, run.status,
    run.status === "awaiting_approval" ? approvals : [],
    run.status === "awaiting_clarification" ? clarifications : [],
    run.status === "awaiting_result_feedback" || run.status === "succeeded" ? artifacts : [],
    run.status === "failed" ? [snapshot.run.error_code ?? null, snapshot.run.safe_message ?? null] : [],
  ]);
}

export function describeReminderKey(failure: { assetId: string; failedAt: number; reason: string }): string {
  return JSON.stringify(["describe", failure.assetId, failure.failedAt, failure.reason]);
}

export function orphanReminderKey(task: JimengOrphanTask): string {
  return JSON.stringify(["orphan", task.submit_id, task.gen_status]);
}

export function reminderStorageKey(libraryRoot: string | null | undefined, userId: string | null | undefined): string {
  return `bowerbird:task-reminder-receipts:v1:${JSON.stringify([libraryRoot ?? "", userId ?? ""])}`;
}

export function readReminderReceipts(storage: Pick<Storage, "getItem">, scope: string): Set<string> {
  const raw = storage.getItem(scope);
  if (!raw) return new Set();
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error("提醒清除记录格式无效");
  return new Set(parsed);
}

export function saveReminderReceipts(storage: Pick<Storage, "getItem" | "setItem">, scope: string, keys: readonly string[]): void {
  const next = readReminderReceipts(storage, scope);
  keys.forEach((key) => next.add(key));
  storage.setItem(scope, JSON.stringify([...next]));
}
