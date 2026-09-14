import { enqueueCloudAgentRunOperation } from "./cloudAgentRuntime.ts";
import { selectCloudAgentResultArtifacts } from "./cloudAgentResult.ts";
import type { CloudAgentRunRecord } from "./types";

export type AgentApprovalMode = "request" | "auto";
export type AgentApprovalModes = Record<string, "auto">;
const STORAGE_KEY = "bowerbird.agentApprovalModes.v1";

export function agentApprovalScope(run: Pick<CloudAgentRunRecord, "projectId" | "threadId">): string | null {
  return run.projectId && run.threadId ? JSON.stringify([run.projectId, run.threadId]) : null;
}

export function agentApprovalMode(run: Pick<CloudAgentRunRecord, "projectId" | "threadId">, modes: AgentApprovalModes): AgentApprovalMode {
  const scope = agentApprovalScope(run);
  return scope && modes[scope] === "auto" ? "auto" : "request";
}

export function loadAgentApprovalModes(): AgentApprovalModes {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, mode]) => mode === "auto"));
  } catch {
    return {};
  }
}

export function saveAgentApprovalModes(modes: AgentApprovalModes): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(modes));
}

export function currentAgentSkillVersion(skillId: string): string | null {
  if (skillId === "bowerbird-controlled-image-edit") return "0.1.2";
  if (skillId === "bowerbird-html-layout-render" || skillId === "bowerbird-unified-agent") return "0.1.0";
  return null;
}

export function automaticAgentApproval(run: CloudAgentRunRecord, modes: AgentApprovalModes, now = Date.now()) {
  if (agentApprovalMode(run, modes) !== "auto" || run.status !== "awaiting_approval"
    || run.snapshot.run.skill_version !== currentAgentSkillVersion(run.skillId)) return null;
  return run.snapshot.approvals.find((approval) => approval.status === "pending"
    && approval.proposal && Date.parse(approval.expires_at) > now) ?? null;
}

export function automaticAgentResultAcceptance(run: CloudAgentRunRecord, modes: AgentApprovalModes): boolean {
  return agentApprovalMode(run, modes) === "auto"
    && run.status === "awaiting_result_feedback"
    && selectCloudAgentResultArtifacts(run.snapshot.artifacts, run.snapshot.renderManifest, run.snapshot.events).length > 0;
}

/** Re-read authorization inside the same lane used by polls and manual decisions. */
export function autoApproveAgentRun(runId: string, dependencies: {
  getRun: () => CloudAgentRunRecord | undefined;
  getModes: () => AgentApprovalModes;
  isActive: () => boolean;
  approve: (runId: string, approvalId: string) => Promise<CloudAgentRunRecord>;
  accept: (runId: string) => Promise<CloudAgentRunRecord>;
  updateRun: (run: CloudAgentRunRecord) => void;
}): Promise<void> {
  return enqueueCloudAgentRunOperation(runId, async () => {
    if (!dependencies.isActive()) return;
    const run = dependencies.getRun();
    if (!run) return;
    const modes = dependencies.getModes();
    if (automaticAgentResultAcceptance(run, modes)) {
      dependencies.updateRun(await dependencies.accept(runId));
      return;
    }
    const approval = automaticAgentApproval(run, modes);
    if (!approval) return;
    const next = await dependencies.approve(runId, approval.id);
    dependencies.updateRun(next);
  });
}
