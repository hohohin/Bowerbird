import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";

import { canonicalJson, sha256Hex } from "../kernel/tool-ledger.ts";
import {
  createRunControlToolDefinitions,
  type HarnessPlan,
  type PlanApprovalRequest,
  type RunAssetManifest,
  type RunControlToolsPort,
} from "./run-control-tools.ts";
import { ScopedToolGateway } from "./scoped-tool-gateway.ts";

const RUN_ID = "run-u2-control";
const LEASE_ID = "lease-u2-control";

function manifest(runId = RUN_ID): RunAssetManifest {
  const assets: RunAssetManifest["assets"] = [{
    assetId: "asset-product",
    role: "input",
    mime: "image/png",
    width: 1200,
    height: 1200,
    caption: "untrusted product caption",
  }];
  return {
    schemaVersion: 1,
    runId,
    manifestHash: sha256Hex(canonicalJson({ schemaVersion: 1, assets })),
    assets,
  };
}

function plan(goal = "生成一张信息图"): HarnessPlan {
  return {
    schemaVersion: 1,
    title: "产品长图计划",
    summary: "先生成辅助图，再合成 HTML。",
    steps: [
      {
        id: "generate_support",
        kind: "generate_image",
        goal,
        inputAssetIds: ["asset-product"],
        dependsOn: [],
      },
      {
        id: "compose_page",
        kind: "compose_html",
        goal: "合成长图",
        inputAssetIds: ["asset-product"],
        dependsOn: ["generate_support"],
      },
      {
        id: "finalize",
        kind: "finalize_output",
        goal: "提交长图结果",
        inputAssetIds: [],
        dependsOn: ["compose_page"],
      },
    ],
  };
}

class MemoryControlPort implements RunControlToolsPort {
  readonly approvals = new Map<string, PlanApprovalRequest>();
  readonly currentManifest: RunAssetManifest;
  readonly authoritativeEstimate: number;
  readonly availableBudget: number;

  constructor(currentManifest = manifest(), authoritativeEstimate = 9, availableBudget = 20) {
    this.currentManifest = currentManifest;
    this.authoritativeEstimate = authoritativeEstimate;
    this.availableBudget = availableBudget;
  }

  async readRunAssets() {
    return this.currentManifest;
  }

  async requestPlanApproval(request: PlanApprovalRequest) {
    if (this.authoritativeEstimate > this.availableBudget) throw new Error("plan_budget_exceeded");
    const existing = this.approvals.get(request.callId);
    if (existing) {
      if (existing.argsHash !== request.argsHash) throw new Error("call_id_args_hash_conflict");
      return { reused: true, estimatedAdditionalCredits: this.authoritativeEstimate };
    }
    this.approvals.set(request.callId, request);
    return { reused: false, estimatedAdditionalCredits: this.authoritativeEstimate };
  }
}

function request(toolName: string, phase: string, argumentsValue: unknown, allowedTools = new Set([toolName])) {
  return {
    runId: RUN_ID,
    leaseId: LEASE_ID,
    phase,
    toolName,
    arguments: argumentsValue,
    trustedSlot: { logicalSlot: toolName === "list_run_assets" ? 0 : 1, revisionIndex: 0 },
    allowedTools,
  };
}

test("list_run_assets is bound to the current Run and exposes no cross-Run argument", async () => {
  const port = new MemoryControlPort();
  const gateway = new ScopedToolGateway(createRunControlToolDefinitions(port));
  const listed = await gateway.dispatch(request("list_run_assets", "understand_goal", {}));
  deepEqual(listed.value, manifest());
  equal(port.approvals.size, 0);

  await rejects(
    () => gateway.dispatch(request("list_run_assets", "understand_goal", { runId: "other-run" })),
    /tool_arguments_invalid/,
  );
  const foreign = new ScopedToolGateway(createRunControlToolDefinitions(new MemoryControlPort(manifest("other-run"))));
  await rejects(
    () => foreign.dispatch(request("list_run_assets", "understand_goal", {})),
    /run_manifest_invalid/,
  );

  const locatorLeak = manifest() as RunAssetManifest & { assets: Array<RunAssetManifest["assets"][number] & { url: string }> };
  locatorLeak.assets[0]!.url = "https://storage.invalid/private-object";
  const leaking = new ScopedToolGateway(createRunControlToolDefinitions(new MemoryControlPort(locatorLeak)));
  await rejects(
    () => leaking.dispatch(request("list_run_assets", "understand_goal", {})),
    /unexpected_property/,
  );
});

test("submit_plan parks with a stable proposal and replays idempotently", async () => {
  const port = new MemoryControlPort();
  const gateway = new ScopedToolGateway(createRunControlToolDefinitions(port));
  const first = await gateway.dispatch(request("submit_plan", "compose_plan", { plan: plan() }));
  const replay = await gateway.dispatch(request("submit_plan", "compose_plan", { plan: plan() }));
  const firstValue = first.value as Record<string, unknown>;
  const replayValue = replay.value as Record<string, unknown>;

  equal(first.callId, replay.callId);
  equal(firstValue.status, "awaiting_plan_approval");
  equal(firstValue.terminalReason, "awaiting_plan_approval");
  equal(firstValue.estimatedAdditionalCredits, 9);
  equal(firstValue.reused, false);
  equal(replayValue.reused, true);
  equal(firstValue.proposalHash, sha256Hex(canonicalJson(plan())));
  equal(port.approvals.size, 1);
  equal([...port.approvals.values()][0]?.plannedToolCount, 3);

  await rejects(
    () => gateway.dispatch(request("submit_plan", "compose_plan", { plan: plan("漂移后的目标") })),
    /call_id_args_hash_conflict/,
  );
});

test("submit_plan rejects model pricing, unknown assets, invalid dependencies, server budget and policy mismatch before parking", async () => {
  const port = new MemoryControlPort();
  const gateway = new ScopedToolGateway(createRunControlToolDefinitions(port));
  const forgedPricing = plan() as HarnessPlan & { steps: Array<HarnessPlan["steps"][number] & { estimatedCredits?: number }> };
  forgedPricing.steps[0]!.estimatedCredits = 0;
  await rejects(
    () => gateway.dispatch(request("submit_plan", "compose_plan", { plan: forgedPricing })),
    /tool_arguments_invalid/,
  );
  const unknownAsset = plan();
  unknownAsset.steps[0]!.inputAssetIds = ["asset-other-run"];
  await rejects(
    () => gateway.dispatch(request("submit_plan", "compose_plan", { plan: unknownAsset })),
    /plan_asset_not_in_run/,
  );

  const badDependency = plan();
  badDependency.steps[0]!.dependsOn = ["compose_page"];
  await rejects(
    () => gateway.dispatch(request("submit_plan", "compose_plan", { plan: badDependency })),
    /tool_arguments_invalid/,
  );

  const overBudget = new ScopedToolGateway(createRunControlToolDefinitions(
    new MemoryControlPort(manifest(), 6, 5),
  ));
  await rejects(
    () => overBudget.dispatch(request("submit_plan", "compose_plan", { plan: plan() })),
    /plan_budget_exceeded/,
  );
  await rejects(
    () => gateway.dispatch(request("submit_plan", "understand_goal", { plan: plan() })),
    /tool_phase_denied/,
  );
  await rejects(
    () => gateway.dispatch(request("submit_plan", "compose_plan", { plan: plan() }, new Set())),
    /tool_not_allowed/,
  );
  equal(port.approvals.size, 0);
});
