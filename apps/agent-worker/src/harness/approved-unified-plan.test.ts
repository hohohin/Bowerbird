import { deepEqual, rejects } from "node:assert/strict";
import { test } from "node:test";
import type { ClaimedAgentRun } from "../control-plane/agent-control-client.ts";
import { canonicalJson, sha256Hex } from "../kernel/tool-ledger.ts";
import { loadApprovedUnifiedPlan } from "./approved-unified-plan.ts";
import type { HarnessPlan } from "./run-control-tools.ts";

const plan: HarnessPlan = {
  schemaVersion: 1,
  title: "生成海报",
  summary: "使用当前产品图生成并交付海报",
  steps: [
    { id: "generate", kind: "generate_image", goal: "生成海报", inputAssetIds: ["asset-1"], dependsOn: [] },
    { id: "finalize", kind: "finalize_output", goal: "交付生成结果", inputAssetIds: [], dependsOn: ["generate"] },
  ],
};
const planHash = sha256Hex(canonicalJson(plan));

function claim(): ClaimedAgentRun & { run: NonNullable<ClaimedAgentRun["run"]> } {
  return {
    run: {
      id: "run-1",
      conversationId: "conversation-1",
      skillId: "bowerbird-unified-agent",
      skillVersion: "0.1.0",
      inputManifestHash: "b".repeat(64),
      approvedPlanHash: planHash,
      plannedToolCount: plan.steps.length,
      resultFeedbackAction: null,
      budgetCredits: 20,
      pricingVersion: 1,
      checkpointHash: "c".repeat(64),
      snapshotSchemaVersion: 1,
    },
    lease: { leaseId: "lease-1", leaseSeconds: 60 },
    approvedPlan: {
      proposalHash: planHash,
      plannedToolCount: plan.steps.length,
      url: "https://storage/approved-plan",
    },
  };
}

test("approved unified plan is downloaded by hash and revalidated before execution", async () => {
  const calls: unknown[][] = [];
  const loaded = await loadApprovedUnifiedPlan(claim(), {
    async downloadVerifiedJson(...args) {
      calls.push(args);
      return plan;
    },
  });
  deepEqual(loaded, plan);
  deepEqual(calls, [["https://storage/approved-plan", planHash, 64 * 1024]]);
});

test("approved unified plan rejects missing references, identity drift and body drift", async () => {
  const downloader = { async downloadVerifiedJson() { return plan; } };
  await rejects(
    () => loadApprovedUnifiedPlan({ ...claim(), approvedPlan: null }, downloader),
    /unified_agent_approved_plan_identity_invalid/,
  );
  await rejects(
    () => loadApprovedUnifiedPlan({
      ...claim(),
      approvedPlan: { proposalHash: "d".repeat(64), plannedToolCount: 2, url: "https://storage/approved-plan" },
    }, downloader),
    /unified_agent_approved_plan_identity_invalid/,
  );
  await rejects(
    () => loadApprovedUnifiedPlan(claim(), { async downloadVerifiedJson() { return { ...plan, title: "漂移" }; } }),
    /unified_agent_approved_plan_mismatch/,
  );
});
