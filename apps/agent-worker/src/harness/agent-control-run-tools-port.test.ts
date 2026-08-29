import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";

import { canonicalJson, sha256Hex } from "../kernel/tool-ledger.ts";
import type { ClaimedAgentRun } from "../control-plane/agent-control-client.ts";
import {
  AgentControlRunToolsPort,
  runAssetManifestFromClaim,
  type UnifiedPlanApprovalClient,
} from "./agent-control-run-tools-port.ts";
import type { HarnessPlan, PlanApprovalRequest, RunAssetManifest } from "./run-control-tools.ts";

const assets: RunAssetManifest["assets"] = [{
  assetId: "asset-current",
  role: "input",
  mime: "image/png",
  width: 100,
  height: 100,
}];
const manifest: RunAssetManifest = {
  schemaVersion: 1,
  runId: "run-control-port",
  manifestHash: sha256Hex(canonicalJson({ schemaVersion: 1, assets })),
  assets,
};
const claimed: ClaimedAgentRun = {
  run: {
    id: manifest.runId,
    conversationId: "conversation-control-port",
    skillId: "unified-agent",
    skillVersion: "0.1.0",
    inputManifestHash: "b".repeat(64),
    approvedPlanHash: null,
    plannedToolCount: null,
    resultFeedbackAction: null,
    budgetCredits: 10,
    pricingVersion: 1,
    checkpointHash: null,
    snapshotSchemaVersion: null,
  },
  lease: { leaseId: "lease-control-port", leaseSeconds: 60 },
  artifactUrls: [{
    artifactId: "asset-current",
    conversationId: "conversation-control-port",
    runId: manifest.runId,
    role: "input",
    mime: "image/png",
    bytes: 24,
    sha256: "c".repeat(64),
    width: 100,
    height: 100,
    userVisible: true,
  }],
};
const plan: HarnessPlan = {
  schemaVersion: 1,
  title: "计划",
  summary: "安全提交计划",
  steps: [{
    id: "finalize",
    kind: "finalize_output",
    goal: "提交结果",
    inputAssetIds: ["asset-current"],
    dependsOn: [],
  }],
};
const request: PlanApprovalRequest = {
  runId: manifest.runId,
  leaseId: "lease-control-port",
  callId: "a".repeat(64),
  argsHash: sha256Hex(canonicalJson({ plan })),
  proposalHash: sha256Hex(canonicalJson(plan)),
  proposal: plan,
  plannedToolCount: 1,
};

class FakeApprovalClient implements UnifiedPlanApprovalClient {
  calls: Parameters<UnifiedPlanApprovalClient["requestUnifiedPlanApproval"]>[0][] = [];

  async requestUnifiedPlanApproval(args: Parameters<UnifiedPlanApprovalClient["requestUnifiedPlanApproval"]>[0]) {
    this.calls.push(args);
    return {
      status: "awaiting_approval" as const,
      proposalHash: args.proposalHash,
      estimatedAdditionalCredits: 2,
      reused: false,
    };
  }
}

test("control transport forwards stable identity and accepts only server-authoritative estimate", async () => {
  const client = new FakeApprovalClient();
  const port = new AgentControlRunToolsPort(claimed, client);
  deepEqual(await port.readRunAssets({ runId: manifest.runId, leaseId: request.leaseId }), manifest);
  const result = await port.requestPlanApproval(request);
  deepEqual(result, { reused: false, estimatedAdditionalCredits: 2 });
  equal(client.calls.length, 1);
  deepEqual(client.calls[0], {
    runId: request.runId,
    leaseId: request.leaseId,
    callId: request.callId,
    argsHash: request.argsHash,
    proposalHash: request.proposalHash,
    proposal: plan,
  });
  equal("estimatedAdditionalCredits" in client.calls[0]!, false);
});

test("control transport rejects manifest and approval identity mismatch", async () => {
  const client = new FakeApprovalClient();
  const port = new AgentControlRunToolsPort(claimed, client);
  await rejects(
    () => port.readRunAssets({ runId: "other-run", leaseId: request.leaseId }),
    /run_manifest_identity_mismatch/,
  );
  await rejects(
    () => port.requestPlanApproval({ ...request, runId: "other-run" }),
    /plan_run_identity_mismatch/,
  );
  equal(client.calls.length, 0);
});

test("claim adapter exposes only image metadata with stable role mapping and ordering", () => {
  const result = runAssetManifestFromClaim({
    ...claimed,
    artifactUrls: [
      { ...claimed.artifactUrls![0]!, artifactId: "z-generated", role: "final_result", width: 640, height: 480 },
      { ...claimed.artifactUrls![0]!, artifactId: "ignored-plan", role: "plan", mime: "application/json", width: null, height: null },
      { ...claimed.artifactUrls![0]!, artifactId: "a-reference", role: "control_reference", mime: "image/webp", width: 320, height: 200 },
    ],
  });
  deepEqual(result.assets, [
    { assetId: "a-reference", role: "reference", mime: "image/webp", width: 320, height: 200 },
    { assetId: "z-generated", role: "generated", mime: "image/png", width: 640, height: 480 },
  ]);
  equal(result.manifestHash, sha256Hex(canonicalJson({ schemaVersion: 1, assets: result.assets })));
});

test("claim adapter fails closed when verified image dimensions are unavailable", () => {
  const withoutDimensions: ClaimedAgentRun = {
    ...claimed,
    artifactUrls: [{ ...claimed.artifactUrls![0]!, width: null, height: null }],
  };
  rejects(async () => runAssetManifestFromClaim(withoutDimensions), /run_asset_dimensions_unavailable/);
});
