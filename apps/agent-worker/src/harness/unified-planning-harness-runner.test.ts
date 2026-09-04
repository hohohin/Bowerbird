import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import type { HarnessAdapter, HarnessCheckpointSeed, HarnessSession } from "./contracts.ts";
import { createRunControlToolDefinitions, type RunAssetManifest, type RunControlToolsPort } from "./run-control-tools.ts";
import { ScopedToolGateway, type ToolGatewayRequest } from "./scoped-tool-gateway.ts";
import { UnifiedPlanningHarnessRunner } from "./unified-planning-harness-runner.ts";
import { UnifiedPlanningToolBridge } from "./unified-planning-tool-bridge.ts";
import { canonicalJson, sha256Hex } from "../kernel/tool-ledger.ts";

function fixture() {
  const assets: RunAssetManifest["assets"] = [{
    assetId: "asset-runner",
    role: "input",
    mime: "image/png",
    width: 100,
    height: 100,
  }];
  const manifest: RunAssetManifest = {
    schemaVersion: 1,
    runId: "run-planning-runner",
    manifestHash: sha256Hex(canonicalJson({ schemaVersion: 1, assets })),
    assets,
  };
  const port: RunControlToolsPort = {
    async readRunAssets() { return manifest; },
    async requestPlanApproval() { throw new Error("not_used"); },
  };
  const claimed = {
    run: {
      id: manifest.runId, conversationId: "conversation-runner", skillId: "unified-agent", skillVersion: "0.1.0",
      inputManifestHash: "a".repeat(64), approvedPlanHash: null, plannedToolCount: null, resultFeedbackAction: null,
      budgetCredits: 10, pricingVersion: 1, checkpointHash: null, snapshotSchemaVersion: null,
    },
    lease: { leaseId: "lease-runner", leaseSeconds: 60 },
    artifactUrls: [{
      artifactId: "asset-runner", conversationId: "conversation-runner", runId: manifest.runId,
      role: "input" as const, mime: "image/png" as const, bytes: 24, sha256: "b".repeat(64),
      width: 100, height: 100, userVisible: true,
    }],
  };
  return {
    manifest,
    claimed,
    bridge: new UnifiedPlanningToolBridge({
      claimed,
      gateway: new ScopedToolGateway(createRunControlToolDefinitions(port)),
    }),
  };
}

function seed(runId: string): HarnessCheckpointSeed {
  return {
    schemaVersion: 1,
    runId,
    checkpointVersion: 0,
    phase: "compose_plan",
    compactedFacts: [],
    completedToolResults: [],
  };
}

test("planning runner scopes one fresh session to one short-lived bridge environment", async () => {
  const { bridge, manifest } = fixture();
  let closed = 0;
  let childEnvironment: Readonly<Record<string, string>> | undefined;
  const adapter: HarnessAdapter = {
    id: "fake-dsh",
    async open(openedSeed) {
      deepEqual(openedSeed, seed(manifest.runId));
      const session: HarnessSession = {
        sessionId: "fresh-session",
        runId: manifest.runId,
        async turn(prompt) {
          deepEqual(prompt, [{ type: "text", text: "plan" }]);
          return { stopReason: "end_turn", committedContent: [{ type: "text", text: "parked" }] };
        },
        async cancel() {},
        async close() { closed += 1; },
      };
      return session;
    },
  };
  const runner = new UnifiedPlanningHarnessRunner(bridge, (environment) => {
    childEnvironment = environment;
    return adapter;
  });
  const result = await runner.run(seed(manifest.runId), [{ type: "text", text: "plan" }]);
  deepEqual(result, { stopReason: "end_turn", committedContent: [{ type: "text", text: "parked" }] });
  equal(Object.keys(childEnvironment ?? {}).length, 2);
  equal(closed, 1);
});

test("planning runner rejects foreign Run, wrong phase and image prompt before opening DSH", async () => {
  const { bridge, manifest } = fixture();
  let adapters = 0;
  const runner = new UnifiedPlanningHarnessRunner(bridge, () => {
    adapters += 1;
    throw new Error("must_not_open");
  });
  await rejects(() => runner.run(seed("foreign-run"), [{ type: "text", text: "plan" }]), /input_invalid/);
  await rejects(() => runner.run({ ...seed(manifest.runId), phase: "execute" }, [{ type: "text", text: "plan" }]), /input_invalid/);
  await rejects(() => runner.run(seed(manifest.runId), [{ type: "image", mimeType: "image/png", data: "x" }]), /input_invalid/);
  equal(adapters, 0);
});

test("planning bridge binds every focus for one asset to one durable observation slot", async () => {
  const { claimed } = fixture();
  const requests: ToolGatewayRequest[] = [];
  const gateway = {
    async dispatch(request: ToolGatewayRequest) {
      requests.push(request);
      return { callId: "a".repeat(64), value: {} };
    },
  } as unknown as ScopedToolGateway;
  const bridge = new UnifiedPlanningToolBridge({ claimed, gateway });

  await bridge.dispatch({ toolName: "understand_asset", arguments: { assetId: "asset-runner", focus: "general" } });
  await bridge.dispatch({ toolName: "understand_asset", arguments: { assetId: "asset-runner", focus: "text" } });

  equal(requests[0]?.trustedSlot.logicalSlot, 1);
  equal(requests[1]?.trustedSlot.logicalSlot, 1);
});
