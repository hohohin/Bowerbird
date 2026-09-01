import { deepEqual, rejects, throws } from "node:assert/strict";
import { test } from "node:test";

import { createApprovedFinalizeOutputToolDefinition } from "./approved-finalize-output-tool.ts";
import { ScopedToolGateway } from "./scoped-tool-gateway.ts";

const approvedPlanHash = "a".repeat(64);

test("finalize_output accepts only empty model arguments and returns parent-owned artifacts", async () => {
  const gateway = new ScopedToolGateway([createApprovedFinalizeOutputToolDefinition({
    runId: "run-finalize",
    leaseId: "lease-finalize",
    approvedPlanHash,
    step: { id: "finalize", kind: "finalize_output", goal: "交付", inputAssetIds: [], dependsOn: ["render"] },
    output: { schemaVersion: 1, primaryArtifactId: "full-page", visibleArtifactIds: ["full-page", "slice-1"] },
  })]);
  const base = {
    runId: "run-finalize",
    leaseId: "lease-finalize",
    phase: "execute_approved_plan",
    toolName: "finalize_output",
    trustedSlot: { logicalSlot: 2, revisionIndex: 0 },
    allowedTools: new Set(["finalize_output"]),
    approvedPlanHash,
  };
  const result = await gateway.dispatch({ ...base, arguments: {} });
  deepEqual(result.value, { schemaVersion: 1, primaryArtifactId: "full-page", visibleArtifactIds: ["full-page", "slice-1"] });
  await rejects(() => gateway.dispatch({ ...base, arguments: { primaryArtifactId: "foreign" } }), /tool_arguments_invalid/);
  await rejects(() => gateway.dispatch({ ...base, approvedPlanHash: "b".repeat(64), arguments: {} }), /tool_approval_required/);
});

test("finalize_output definition rejects a primary artifact outside the visible parent set", () => {
  throws(() => createApprovedFinalizeOutputToolDefinition({
    runId: "run-finalize",
    leaseId: "lease-finalize",
    approvedPlanHash,
    step: { id: "finalize", kind: "finalize_output", goal: "交付", inputAssetIds: [], dependsOn: ["render"] },
    output: { schemaVersion: 1, primaryArtifactId: "foreign", visibleArtifactIds: ["full-page"] },
  }), /approved_finalize_output_invalid/);
});
