import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { test } from "node:test";
import type { HarnessAdapter, HarnessCheckpointSeed, HarnessSession } from "./contracts.ts";
import { createRunControlToolDefinitions, type RunAssetManifest, type RunControlToolsPort } from "./run-control-tools.ts";
import { ScopedToolGateway, type ToolGatewayRequest } from "./scoped-tool-gateway.ts";
import { UnifiedPlanningHarnessRunner } from "./unified-planning-harness-runner.ts";
import { UnifiedPlanningToolBridge } from "./unified-planning-tool-bridge.ts";
import { canonicalJson, sha256Hex } from "../kernel/tool-ledger.ts";
import { VisualObservationMemory, type VisualObservationReference } from "./visual-observation-memory.ts";
import type { AgentControlClient } from "../control-plane/agent-control-client.ts";

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

test("planning bridge persists observations before returning and reuses them across revisions", async () => {
  const { claimed } = fixture();
  let calls = 0;
  let saved: VisualObservationReference[] = [];
  const value = { schemaVersion: 1, assetId: "asset-runner", summary: "产品观察",
    observations: [{ category: "subject", detail: "蓝色瓶身" }] };
  const memory = new VisualObservationMemory({ runId: claimed.run.id, leaseId: claimed.lease.leaseId,
    assets: claimed.artifactUrls, control: {} as AgentControlClient, save: async refs => { saved = refs; } });
  const gateway = { async dispatch() { calls++; return { callId: "c".repeat(64), value }; } } as unknown as ScopedToolGateway;
  const call = { toolName: "understand_asset", arguments: { assetId: "asset-runner", focus: "general" } };
  const bridge = new UnifiedPlanningToolBridge({ claimed, gateway, observations: memory });
  deepEqual((await bridge.dispatch(call)).value, value);
  equal(saved.length, 1);
  const revision = new UnifiedPlanningToolBridge({ claimed, gateway, observations: memory, revisionIndex: 1 });
  deepEqual((await revision.dispatch(call)).value, value);
  equal(calls, 1);
  const page = await revision.dispatch({ toolName: "read_context", arguments: { id: memory.catalog()[0]!.contextId } });
  deepEqual(JSON.parse((page.value as { content: { text: string } }).content.text), value);
});

test("skill discovery returns metadata and reads only the selected method without legacy Runner rules", async () => {
  const { bridge } = fixture();
  const catalog = (await bridge.dispatch({ toolName: "list_skills", arguments: {} })).value as Array<{ id: string; description: string }>;
  equal(catalog.length, 4);
  for (const entry of catalog) {
    deepEqual(Object.keys(entry).sort(), ["description", "id"]);
    ok(entry.description.length > 0);
    const result = (await bridge.dispatch({ toolName: "read_skill", arguments: { skillId: entry.id } })).value as { id: string; instructions: string };
    equal(result.id, entry.id);
    ok(result.instructions.length > 100);
    for (const legacy of ["IntentAnalysis", "ControlledImageEditPlan", "awaiting_user_review", "compose_html_document", "恰有一个", "不读取图片内容", "staged_controlled"]) {
      ok(!result.instructions.includes(legacy), legacy);
    }
    if (entry.id === "bowerbird-controlled-image-edit") ok(!result.instructions.includes("HTML"));
    if (entry.id === "bowerbird-html-layout-render") ok(!result.instructions.includes("饰品"));
  }
  for (const skillId of ["bowerbird-unified-agent", "../../secret"]) {
    const result = (await bridge.dispatch({ toolName: "read_skill", arguments: { skillId } })).value as { status: string };
    equal(result.status, "retry_required");
  }
});

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

test("planning bridge gives each focus a stable distinct slot", async () => {
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
  equal(requests[1]?.trustedSlot.logicalSlot, 1002);
  await bridge.dispatch({ toolName: "understand_asset", arguments: { assetId: "asset-runner", focus: "text" } });
  equal(requests[2]?.trustedSlot.logicalSlot, 1002);
});
