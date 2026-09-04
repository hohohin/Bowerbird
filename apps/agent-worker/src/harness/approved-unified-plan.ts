import type { ClaimedAgentRun } from "../control-plane/agent-control-client.ts";
import { canonicalJson, sha256Hex } from "../kernel/tool-ledger.ts";
import { validateHarnessPlan, type HarnessPlan } from "./run-control-tools.ts";

type ApprovedPlanDownloader = {
  downloadVerifiedJson(url: string, expectedSha256: string, maxBytes?: number): Promise<unknown>;
};

const MAX_APPROVED_PLAN_BYTES = 64 * 1024;

/**
 * Loads only the exact approved proposal selected by the control plane.
 * The Worker never accepts a plan body from DSH after approval.
 */
export async function loadApprovedUnifiedPlan(
  claimed: ClaimedAgentRun & { run: NonNullable<ClaimedAgentRun["run"]> },
  downloader: ApprovedPlanDownloader,
): Promise<HarnessPlan> {
  const expectedHash = claimed.run.approvedPlanHash;
  const expectedCount = claimed.run.plannedToolCount;
  const reference = claimed.approvedPlan;
  if (!expectedHash || !/^[0-9a-f]{64}$/.test(expectedHash) ||
      !Number.isSafeInteger(expectedCount) || Number(expectedCount) < 1 ||
      !reference || reference.proposalHash !== expectedHash ||
      reference.plannedToolCount !== expectedCount ||
      typeof reference.url !== "string" || !reference.url.startsWith("https://")) {
    throw new Error("unified_agent_approved_plan_identity_invalid");
  }
  const value = await downloader.downloadVerifiedJson(reference.url, expectedHash, MAX_APPROVED_PLAN_BYTES);
  const plan = validateHarnessPlan(value);
  if (plan.steps.length !== expectedCount || sha256Hex(canonicalJson(plan)) !== expectedHash) {
    throw new Error("unified_agent_approved_plan_mismatch");
  }
  return plan;
}
