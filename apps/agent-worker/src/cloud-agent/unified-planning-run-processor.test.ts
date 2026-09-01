import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentControlClient } from "../control-plane/agent-control-client.ts";
import type { HarnessAdapter, HarnessSession } from "../harness/contracts.ts";
import { canonicalJson, deriveCallId, sha256Hex } from "../kernel/tool-ledger.ts";
import type { GenerateApprovedStepRequest } from "../kernel/controlled-image-edit-runner.ts";
import { SimulatedProcessCrash } from "../kernel/durable-tool-dispatcher.ts";
import type { AgentRunContext } from "./runtime.ts";
import { UnifiedPlanningRunProcessor } from "./unified-planning-run-processor.ts";
import type { RenderHtmlResultV1 } from "../contracts/render-html.ts";

function claimed(
  approvedPlanHash: string | null = null,
  plannedToolCount = approvedPlanHash ? 1 : null,
): AgentRunContext["claimed"] {
  return {
    run: {
      id: "run-unified-1",
      conversationId: "conversation-unified-1",
      skillId: "bowerbird-unified-agent",
      skillVersion: "0.1.0",
      inputManifestHash: "a".repeat(64),
      approvedPlanHash,
      plannedToolCount,
      resultFeedbackAction: null,
      budgetCredits: 30,
      pricingVersion: 1,
      checkpointHash: null,
      snapshotSchemaVersion: null,
    },
    lease: { leaseId: "lease-unified-1", leaseSeconds: 60 },
    inputUrl: "https://local.invalid/request.json",
    artifactUrls: [{
      artifactId: "asset-product",
      conversationId: "conversation-unified-1",
      runId: "run-unified-1",
      role: "input",
      mime: "image/png",
      bytes: 24,
      sha256: "b".repeat(64),
      width: 720,
      height: 960,
      userVisible: true,
    }],
  };
}

function signal() {
  return { aborted: false, cancelRequested: false, leaseLost: false, stopRequested: false };
}

const onePixelBinary = (globalThis as unknown as { atob(input: string): string }).atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
);
const onePixelPng = Uint8Array.from(onePixelBinary, (character) => character.charCodeAt(0));
const onePixelSha256 = createHash("sha256").update(onePixelPng).digest("hex");

async function toolCall(environment: Readonly<Record<string, string>>, toolName: string, argumentsValue: unknown) {
  const response = await fetch(environment.BOWERBIRD_TOOL_BRIDGE_ENDPOINT!, {
    method: "POST",
    headers: {
      authorization: `Bearer ${environment.BOWERBIRD_TOOL_BRIDGE_CAPABILITY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ toolName, arguments: argumentsValue }),
  });
  const body = await response.json() as { ok: boolean; value?: unknown };
  equal(response.status, 200);
  equal(body.ok, true);
  return body.value;
}

test("formal unified processor checkpoints before DSH and parks through the parent planning bridge", async () => {
  const visualProfilePayload = {
    schemaVersion: 1 as const,
    profileId: "profile-u3",
    version: 2,
    sourceScopeHash: "source-scope-u3",
    summary: "暖灰、克制、留白",
    must: [{ category: "composition" as const, value: "大量留白", polarity: "must" as const }],
    prefer: [{ category: "palette" as const, value: "暖灰与深棕", polarity: "prefer" as const }],
    avoid: [{ category: "light" as const, value: "硬闪", polarity: "avoid" as const }],
    contentThemes: ["咖啡器具"],
  };
  const visualProfileCapsule = {
    ...visualProfilePayload,
    hash: sha256Hex(canonicalJson(visualProfilePayload)),
  };
  const order: string[] = [];
  const events: Array<{ type: string; displayPayload: Record<string, unknown> }> = [];
  let savedCheckpoint = "";
  let approvalCallId = "";
  let approvalProposal: Record<string, unknown> | undefined;
  let closed = 0;
  let adapterEnvironment: Readonly<Record<string, string>> | undefined;
  const control = {
    async loadRawCheckpoint() { return null; },
    async downloadVerifiedJson() {
      return { schemaVersion: 1, goal: "把产品图和推文规划为 HTML 长图", visualProfileCapsule };
    },
    async saveRawCheckpoint(args: { bytes: Uint8Array }) {
      order.push("checkpoint");
      savedCheckpoint = new TextDecoder().decode(args.bytes);
      return { checkpointHash: "c".repeat(64), objectKey: "checkpoint.json" };
    },
    async appendEvents(_runId: string, _leaseId: string, items: typeof events) {
      order.push("event");
      events.push(...items);
    },
    async requestUnifiedPlanApproval(args: { callId: string; proposalHash: string; proposal: Record<string, unknown> }) {
      order.push("approval");
      approvalCallId = args.callId;
      approvalProposal = args.proposal;
      return {
        status: "awaiting_approval" as const,
        proposalHash: args.proposalHash,
        estimatedAdditionalCredits: 2,
        reused: false,
      };
    },
  } as unknown as AgentControlClient;

  const adapter: HarnessAdapter = {
    id: "fake-dsh",
    async open(seed) {
      equal(seed.runId, "run-unified-1");
      equal(seed.phase, "compose_plan");
      const session: HarnessSession = {
        sessionId: "fresh-unified-session",
        runId: seed.runId,
        async turn(prompt) {
          const text = prompt[0]?.type === "text" ? prompt[0].text : "";
          ok(text.includes("HTML 长图"));
          ok(text.includes("BOWERBIRD_VISUAL_PROFILE_CAPSULE_V1"));
          ok(text.includes(visualProfileCapsule.hash));
          ok(text.includes("contentThemes"));
          ok(text.includes("never mutate or write back"));
          const manifest = await toolCall(adapterEnvironment!, "list_run_assets", {}) as {
            assets: Array<{ assetId: string }>;
          };
          equal(manifest.assets[0]?.assetId, "asset-product");
          await toolCall(adapterEnvironment!, "submit_plan", {
            plan: {
              schemaVersion: 2,
              title: "产品长图",
              summary: "使用当前产品素材完成输出，并按冻结的视觉档案约束留白、色彩与光线。",
              contentPlan: {
                assetAssignments: [{
                  assetId: "asset-product",
                  roles: ["product", "logo", "copy_source"],
                  rationale: "当前 Run 的产品图同时提供主体、品牌标识与可核验包装文字。",
                }],
                informationArchitecture: [{
                  id: "hero",
                  purpose: "展示产品主体与核心卖点",
                  sourceAssetIds: ["asset-product"],
                  copySource: "user_goal",
                }],
                missingAssets: [],
                visualProfile: {
                  profileId: visualProfileCapsule.profileId,
                  version: visualProfileCapsule.version,
                  hash: visualProfileCapsule.hash,
                  applied: ["大量留白", "暖灰与深棕", "避免硬闪"],
                  ignoredContentThemes: ["咖啡器具"],
                },
              },
              steps: [{
                id: "finalize",
                kind: "finalize_output",
                goal: "交付最终长图",
                inputAssetIds: ["asset-product"],
                dependsOn: [],
              }],
            },
          });
          return { stopReason: "end_turn", committedContent: [] };
        },
        async cancel() {},
        async close() { closed += 1; },
      };
      return session;
    },
  };
  const workspaceRoot = join(process.env.TEMP ?? ".", "bowerbird-unified-tests", randomUUID());
  const processor = new UnifiedPlanningRunProcessor({
    workspaceRoot,
    vision: { apiKey: "unused", baseUrl: "https://ark.invalid", model: "unused", mock: true },
    createAdapter(environment) {
      adapterEnvironment = environment;
      return adapter;
    },
  });

  await processor.process({ claimed: claimed(), control, signal: signal() });
  equal(order.join(","), "checkpoint,event,approval");
  ok(savedCheckpoint.includes('"skillId":"bowerbird-unified-agent"'));
  ok(savedCheckpoint.includes(visualProfileCapsule.hash));
  const profileEvent = events.find((event) => event.type === "unified.visual_profile.bound");
  equal(profileEvent?.displayPayload.hash, visualProfileCapsule.hash);
  deepEqual(profileEvent?.displayPayload.must, visualProfileCapsule.must);
  equal(approvalCallId, deriveCallId({
    runId: "run-unified-1",
    phase: "compose_plan",
    logicalSlot: 10_000,
    revisionIndex: 0,
  }));
  equal(approvalProposal?.schemaVersion, 2);
  deepEqual((approvalProposal?.contentPlan as Record<string, unknown>)?.visualProfile, {
    profileId: visualProfileCapsule.profileId,
    version: visualProfileCapsule.version,
    hash: visualProfileCapsule.hash,
    applied: ["大量留白", "暖灰与深棕", "避免硬闪"],
    ignoredContentThemes: ["咖啡器具"],
  });
  equal(closed, 1);
  ok(adapterEnvironment);
});

test("formal unified processor executes only approved generate steps and parks the final artifact", async () => {
  const plan = {
    schemaVersion: 1 as const,
    title: "批准的两步生图",
    summary: "先生成结构稿，再生成最终图",
    steps: [
      { id: "generate_base", kind: "generate_image" as const, goal: "生成结构稿", inputAssetIds: ["asset-product"], dependsOn: [] },
      { id: "generate_final", kind: "generate_image" as const, goal: "生成最终图", inputAssetIds: [], dependsOn: ["generate_base"] },
      { id: "finalize", kind: "finalize_output" as const, goal: "交付最终图", inputAssetIds: [], dependsOn: ["generate_final"] },
    ],
  };
  const approvedPlanHash = sha256Hex(canonicalJson(plan));
  const checkpoint = {
    schemaVersion: 1 as const,
    runId: "run-unified-1",
    conversationId: "conversation-unified-1",
    skillId: "bowerbird-unified-agent" as const,
    skillVersion: "0.1.0",
    skillHash: "d54e2216c43a8ae62baa4a1d2c9df4f3cb349c4f340304bb69a84bf77f2c8169",
    checkpointVersion: 0,
    phase: "compose_plan",
    compactedFacts: [],
    completedToolResults: [],
    input: { schemaVersion: 1 as const, goal: "生成产品主视觉" },
  };
  const checkpointText = canonicalJson(checkpoint);
  const runClaim = claimed(approvedPlanHash, plan.steps.length);
  runClaim.run.checkpointHash = sha256Hex(checkpointText);
  runClaim.run.snapshotSchemaVersion = 1;
  runClaim.checkpointUrl = "https://local.invalid/checkpoint.json";
  runClaim.approvedPlan = { proposalHash: approvedPlanHash, plannedToolCount: plan.steps.length, url: "https://local.invalid/plan.json" };

  let adapters = 0;
  let parked = 0;
  const generated: GenerateApprovedStepRequest[] = [];
  const saved: string[] = [];
  const processor = new UnifiedPlanningRunProcessor({
    workspaceRoot: join(process.env.TEMP ?? ".", "bowerbird-unified-tests", randomUUID()),
    vision: { apiKey: "unused", baseUrl: "https://ark.invalid", model: "unused", mock: true },
    createAdapter() {
      adapters += 1;
      throw new Error("must_not_open");
    },
    createApprovedStepExecutor() {
      return {
        async generate(request) {
          generated.push(request);
          const suffix = request.stepId === "generate_base" ? "base" : "final";
          return { artifactId: `artifact-${suffix}`, mime: "image/png", bytes: 42, sha256: (suffix === "base" ? "b" : "c").repeat(64) };
        },
      };
    },
  });
  const control = {
    async loadRawCheckpoint() { return new TextEncoder().encode(checkpointText); },
    async downloadVerifiedJson(url: string) {
      equal(url, "https://local.invalid/plan.json");
      return plan;
    },
    async saveRawCheckpoint(args: { bytes: Uint8Array }) { saved.push(new TextDecoder().decode(args.bytes)); },
    async appendEvents() {},
    async awaitResultFeedback() { parked += 1; },
  } as unknown as AgentControlClient;

  await processor.process({ claimed: runClaim, control, signal: signal() });
  equal(adapters, 0);
  equal(parked, 1);
  equal(generated.length, 2);
  equal(generated[0]?.outputRole, "stage_result");
  equal(generated[1]?.outputRole, "final_result");
  deepEqual(generated[1]?.inputArtifactIds, ["artifact-base"]);
  equal(generated[1]?.parentArtifactId, "artifact-base");
  equal(generated[0]?.callId, deriveCallId({ runId: "run-unified-1", phase: "execute_approved_plan", logicalSlot: 0, revisionIndex: 0 }));
  ok(saved.at(-1)?.includes('"phase":"awaiting_result_feedback"'));
});

test("formal unified processor rebuild reuses the same durable call after artifact-before-checkpoint crash", async () => {
  const plan = {
    schemaVersion: 1 as const,
    title: "批准的单步生图",
    summary: "验证统一 checkpoint 未推进时不重复上游",
    steps: [
      { id: "generate_final", kind: "generate_image" as const, goal: "生成最终图", inputAssetIds: ["asset-product"], dependsOn: [] },
      { id: "finalize", kind: "finalize_output" as const, goal: "交付最终图", inputAssetIds: [], dependsOn: ["generate_final"] },
    ],
  };
  const approvedPlanHash = sha256Hex(canonicalJson(plan));
  let checkpointText = canonicalJson({
    schemaVersion: 1, runId: "run-unified-1", conversationId: "conversation-unified-1",
    skillId: "bowerbird-unified-agent", skillVersion: "0.1.0",
    skillHash: "d54e2216c43a8ae62baa4a1d2c9df4f3cb349c4f340304bb69a84bf77f2c8169",
    checkpointVersion: 0, phase: "compose_plan", compactedFacts: [], completedToolResults: [],
    input: { schemaVersion: 1, goal: "生成产品主视觉" },
  });
  const runClaim = claimed(approvedPlanHash, plan.steps.length);
  runClaim.run.snapshotSchemaVersion = 1;
  runClaim.checkpointUrl = "https://local.invalid/checkpoint.json";
  runClaim.approvedPlan = { proposalHash: approvedPlanHash, plannedToolCount: plan.steps.length, url: "https://local.invalid/plan.json" };
  const callIds: string[] = [];
  const durableResults = new Map<string, { artifactId: string; mime: string; bytes: number; sha256: string }>();
  let upstreamCalls = 0;
  let crashBeforeCheckpoint = true;
  let parked = 0;
  const control = {
    async loadRawCheckpoint() { return new TextEncoder().encode(checkpointText); },
    async downloadVerifiedJson() { return plan; },
    async saveRawCheckpoint(args: { bytes: Uint8Array }) {
      const nextText = new TextDecoder().decode(args.bytes);
      const next = JSON.parse(nextText) as { completedToolResults: unknown[] };
      if (crashBeforeCheckpoint && next.completedToolResults.length === 1) {
        crashBeforeCheckpoint = false;
        throw new SimulatedProcessCrash();
      }
      checkpointText = nextText;
      return { checkpointHash: sha256Hex(nextText), objectKey: "checkpoint.json" };
    },
    async appendEvents() {},
    async awaitResultFeedback() { parked += 1; },
  } as unknown as AgentControlClient;
  const processor = new UnifiedPlanningRunProcessor({
    workspaceRoot: join(process.env.TEMP ?? ".", "bowerbird-unified-tests", randomUUID()),
    vision: { apiKey: "unused", baseUrl: "https://ark.invalid", model: "unused", mock: true },
    createAdapter() { throw new Error("must_not_open"); },
    createApprovedStepExecutor() {
      return {
        async generate(request) {
          callIds.push(request.callId);
          const restored = durableResults.get(request.callId);
          if (restored) return restored;
          upstreamCalls += 1;
          const result = { artifactId: "artifact-final", mime: "image/png", bytes: 42, sha256: "d".repeat(64) };
          durableResults.set(request.callId, result);
          return result;
        },
      };
    },
  });

  runClaim.run.checkpointHash = sha256Hex(checkpointText);
  await rejects(() => processor.process({ claimed: runClaim, control, signal: signal() }), /simulated_process_crash/);
  equal(JSON.parse(checkpointText).phase, "execute_approved_plan");
  equal(JSON.parse(checkpointText).completedToolResults.length, 0);
  runClaim.run.checkpointHash = sha256Hex(checkpointText);
  await processor.process({ claimed: runClaim, control, signal: signal() });

  equal(upstreamCalls, 1);
  equal(callIds.length, 2);
  equal(callIds[0], callIds[1], "checkpoint replay must derive the same call id");
  equal(parked, 1);
  equal(JSON.parse(checkpointText).phase, "awaiting_result_feedback");
});

test("formal unified processor executes approved compose_html then parent-owned render_html and parks", async () => {
  const plan = {
    schemaVersion: 1 as const,
    title: "批准的 HTML 长图",
    summary: "排版当前产品素材并离线渲染",
    steps: [
      { id: "compose", kind: "compose_html" as const, goal: "生成受限 HTML", inputAssetIds: ["asset-product"], dependsOn: [] },
      { id: "render", kind: "render_html" as const, goal: "离线渲染", inputAssetIds: ["asset-product"], dependsOn: ["compose"] },
      { id: "inspect", kind: "inspect_artifact" as const, goal: "检查整页层级与内容完整性", inputAssetIds: [], dependsOn: ["render"] },
      { id: "finalize", kind: "finalize_output" as const, goal: "交付长图", inputAssetIds: [], dependsOn: ["inspect"] },
    ],
  };
  const approvedPlanHash = sha256Hex(canonicalJson(plan));
  const checkpoint = {
    schemaVersion: 1, runId: "run-unified-1", conversationId: "conversation-unified-1",
    skillId: "bowerbird-unified-agent", skillVersion: "0.1.0",
    skillHash: "d54e2216c43a8ae62baa4a1d2c9df4f3cb349c4f340304bb69a84bf77f2c8169",
    checkpointVersion: 0, phase: "compose_plan", compactedFacts: [], completedToolResults: [],
    input: {
      schemaVersion: 1,
      goal: "把产品图与完整推文排成 HTML 长图",
      htmlOutput: {
        viewport: { widthCssPx: 1080, heightCssPx: 720, deviceScaleFactor: 2 },
        capture: { mode: "full_page" },
        background: "transparent",
      },
    },
  };
  let checkpointText = canonicalJson(checkpoint);
  const runClaim = claimed(approvedPlanHash, plan.steps.length);
  runClaim.run.checkpointHash = sha256Hex(checkpointText);
  runClaim.run.snapshotSchemaVersion = 1;
  runClaim.checkpointUrl = "https://local.invalid/checkpoint.json";
  runClaim.approvedPlan = { proposalHash: approvedPlanHash, plannedToolCount: plan.steps.length, url: "https://local.invalid/plan.json" };
  const calls = new Map<string, { callId: string; status: "prepared" | "submitted" | "succeeded"; reused: boolean; resultObjectKey?: string; resultHash?: string }>();
  const argsHashes = new Map<string, string>();
  const artifacts = new Map<string, Record<string, unknown>>();
  const diagnosticValues = new Map<string, unknown>();
  let visionUsage = 0;
  let parked = 0;
  let renderCalls = 0;
  let crashBeforeResultCheckpoint = true;
  const renderedByCall = new Map<string, RenderHtmlResultV1 & { manifestArtifactId: string; manifestObjectKey: string }>();
  let executionEnvironment: Readonly<Record<string, string>> | undefined;
  const control = {
    async loadRawCheckpoint() { return new TextEncoder().encode(checkpointText); },
    async downloadVerifiedJson(url: string) {
      if (url.startsWith("memory://diagnostic/")) return diagnosticValues.get(url);
      return plan;
    },
    async saveRawCheckpoint(args: { bytes: Uint8Array }) {
      const nextText = new TextDecoder().decode(args.bytes);
      const next = JSON.parse(nextText) as { completedToolResults: unknown[] };
      if (crashBeforeResultCheckpoint && next.completedToolResults.length === 4) {
        crashBeforeResultCheckpoint = false;
        throw new SimulatedProcessCrash();
      }
      checkpointText = nextText;
    },
    async appendEvents() {},
    async awaitResultFeedback() { parked++; },
    async prepareTool(args: { callId: string; argsHash: string }) {
      const existing = calls.get(args.callId);
      if (existing) {
        if (argsHashes.get(args.callId) !== args.argsHash) throw new Error("tool_args_hash_mismatch");
        return { ...existing, reused: true };
      }
      const created = { callId: args.callId, status: "prepared" as const, reused: false };
      calls.set(args.callId, created);
      argsHashes.set(args.callId, args.argsHash);
      return created;
    },
    async markToolSubmitted(args: { callId: string }) {
      const next = { ...calls.get(args.callId)!, status: "submitted" as const };
      calls.set(args.callId, next);
      return next;
    },
    async completeTool(args: { callId: string; status: "succeeded"; resultObjectKey?: string; resultHash?: string }) {
      const next = { ...calls.get(args.callId)!, status: args.status, resultObjectKey: args.resultObjectKey, resultHash: args.resultHash };
      calls.set(args.callId, next);
      return next;
    },
    async uploadArtifact(args: { sourceCallId: string; runId: string; role: string; stepId: string; mime: string; bytes: Uint8Array; sha256: string }) {
      const artifact = {
        artifactId: "html-document", conversationId: "conversation-unified-1", runId: args.runId,
        role: args.role, stepId: args.stepId, mime: args.mime, bytes: args.bytes.byteLength,
        sha256: args.sha256, userVisible: false, objectKey: `runs/${args.runId}/${args.sourceCallId}.html`,
      };
      artifacts.set(args.sourceCallId, artifact);
      return artifact;
    },
    async uploadDiagnostic(args: { sourceCallId: string; runId: string; stepId: string; bytes: Uint8Array; sha256: string }) {
      const url = `memory://diagnostic/${args.sourceCallId}`;
      const artifact = {
        artifactId: `diagnostic-${args.sourceCallId.slice(0, 8)}`, conversationId: "conversation-unified-1", runId: args.runId,
        role: "diagnostic", stepId: args.stepId, mime: "application/json", bytes: args.bytes.byteLength,
        sha256: args.sha256, userVisible: false, objectKey: `runs/${args.runId}/${args.sourceCallId}.json`, url,
      };
      diagnosticValues.set(url, JSON.parse(new TextDecoder().decode(args.bytes)));
      artifacts.set(args.sourceCallId, artifact);
      return artifact;
    },
    async recordUsage(args: { kind: string }) {
      if (args.kind === "vision_call") visionUsage++;
    },
    async getArtifactByCall(_runId: string, _leaseId: string, callId: string) {
      const artifact = artifacts.get(callId);
      if (!artifact) throw new Error("artifact_missing");
      return artifact;
    },
  } as unknown as AgentControlClient;
  const htmlAdapter: HarnessAdapter = {
    id: "fake-html-dsh",
    async open(seed) {
      equal(seed.phase, "execute_approved_plan");
      return {
        sessionId: "html-session", runId: seed.runId,
        async turn(prompt) {
          ok((prompt[0]?.type === "text" ? prompt[0].text : "").includes('"widthCssPx":1080'));
          await toolCall(executionEnvironment!, "compose_html", {
            schemaVersion: 1,
            html: "<main><img src=\"asset:reference-1\"><h1>完整推文</h1></main>",
            resourceArtifactIds: ["asset-product"],
          });
          await toolCall(executionEnvironment!, "render_html", {});
          await toolCall(executionEnvironment!, "inspect_artifact", {});
          await toolCall(executionEnvironment!, "finalize_output", {});
          return { stopReason: "end_turn", committedContent: [] };
        },
        async cancel() {},
        async close() {},
      };
    },
  };
  const processor = new UnifiedPlanningRunProcessor({
    workspaceRoot: join(process.env.TEMP ?? ".", "bowerbird-unified-tests", randomUUID()),
    vision: { apiKey: "unused", baseUrl: "https://ark.invalid", model: "unused", mock: true },
    createAdapter() { throw new Error("planning_must_not_open"); },
    modelProxy: { upstream: { apiKey: "parent", baseUrl: "https://deepseek.invalid", model: "deepseek-v4-flash" } },
    htmlExecution: {
      renderConfig: { rendererUrl: "http://renderer.invalid", internalToken: "fixture" },
      createAdapter(environment) { executionEnvironment = environment; return htmlAdapter; },
      createRenderExecutor(_context, workspace) {
        return {
          async render(request) {
            const restored = renderedByCall.get(request.callId);
            const result = restored ?? (() => {
              renderCalls++;
              equal(request.input.htmlArtifactId, "html-document");
              deepEqual(request.input.resourceArtifactIds, ["asset-product"]);
              deepEqual(request.input.viewport, { widthCssPx: 1080, heightCssPx: 720, deviceScaleFactor: 2 });
              deepEqual(request.input.capture, { mode: "full_page" });
              equal(request.input.background, "transparent");
              return {
                schemaVersion: 1 as const, rendererFingerprint: "fixture-renderer", sourceHtmlSha256: "e".repeat(64),
                argsHash: "f".repeat(64), renderMs: 12, document: { widthCssPx: 1080, heightCssPx: 1200, widthDevicePx: 2160, heightDevicePx: 2400 },
                outputs: [{ artifactId: "full-page", role: "full_page_screenshot" as const, clipDevicePx: { x: 0, y: 0, width: 1, height: 1 }, mime: "image/png" as const, bytes: onePixelPng.byteLength, sha256: onePixelSha256 }],
                manifestArtifactId: "render-manifest", manifestObjectKey: "runs/run-unified-1/render-manifest.json",
              };
            })();
            renderedByCall.set(request.callId, result);
            workspace.rememberArtifact(request.callId, {
              artifactId: "full-page", conversationId: "conversation-unified-1", runId: "run-unified-1",
              role: "full_page_screenshot", stepId: "render", mime: "image/png", bytes: onePixelPng.byteLength,
              sha256: onePixelSha256, userVisible: true, objectKey: "runs/run-unified-1/full-page.png",
            }, { mime: "image/png", bytes: onePixelPng, sha256: onePixelSha256 });
            return result;
          },
        };
      },
    },
  });
  await rejects(() => processor.process({ claimed: runClaim, control, signal: signal() }), /simulated_process_crash/);
  equal(JSON.parse(checkpointText).phase, "execute_approved_plan");
  runClaim.run.checkpointHash = sha256Hex(checkpointText);
  await processor.process({ claimed: runClaim, control, signal: signal() });
  equal(renderCalls, 1);
  equal(visionUsage, 1);
  equal(parked, 1);
  const saved = JSON.parse(checkpointText);
  equal(saved.phase, "awaiting_result_feedback");
  equal(saved.completedToolResults.length, 4);
  equal(saved.completedToolResults[0].toolName, "compose_html");
  equal(saved.completedToolResults[1].toolName, "render_html");
  equal(saved.completedToolResults[2].toolName, "inspect_artifact");
  equal(saved.completedToolResults[3].toolName, "finalize_output");
  equal(saved.completedToolResults[3].result.primaryArtifactId, "full-page");
});

test("U5 reuses one approved execution session to render HTML then derive a Xiaohongshu package", async () => {
  const plan = {
    schemaVersion: 2 as const,
    title: "长图派生小红书草稿",
    summary: "先排版和渲染，再从同一批准内容派生渠道草稿。",
    contentPlan: {
      assetAssignments: [{ assetId: "asset-product", roles: ["product", "copy_source"] as const, rationale: "产品与文案事实来源" }],
      informationArchitecture: [{ id: "hero", purpose: "核心卖点与产品细节", sourceAssetIds: ["asset-product"], copySource: "user_goal" as const }],
      missingAssets: [],
      visualProfile: null,
    },
    steps: [
      { id: "compose", kind: "compose_html" as const, goal: "排版长图", inputAssetIds: ["asset-product"], dependsOn: [] },
      { id: "render", kind: "render_html" as const, goal: "渲染长图", inputAssetIds: ["asset-product"], dependsOn: ["compose"] },
      { id: "compose_xhs", kind: "compose_xiaohongshu" as const, goal: "派生小红书草稿", inputAssetIds: [], dependsOn: ["render"] },
      { id: "finalize", kind: "finalize_output" as const, goal: "交付渠道包", inputAssetIds: [], dependsOn: ["compose_xhs"] },
    ],
  };
  const approvedPlanHash = sha256Hex(canonicalJson(plan));
  let checkpointText = canonicalJson({
    schemaVersion: 1, runId: "run-unified-1", conversationId: "conversation-unified-1",
    skillId: "bowerbird-unified-agent", skillVersion: "0.1.0",
    skillHash: "d54e2216c43a8ae62baa4a1d2c9df4f3cb349c4f340304bb69a84bf77f2c8169",
    checkpointVersion: 0, phase: "compose_plan", compactedFacts: [], completedToolResults: [],
    input: { schemaVersion: 1, goal: "先做产品长图，再派生小红书图文草稿" },
  });
  const runClaim = claimed(approvedPlanHash, plan.steps.length);
  runClaim.run.checkpointHash = sha256Hex(checkpointText);
  runClaim.run.snapshotSchemaVersion = 1;
  runClaim.checkpointUrl = "https://local.invalid/checkpoint.json";
  runClaim.approvedPlan = { proposalHash: approvedPlanHash, plannedToolCount: plan.steps.length, url: "https://local.invalid/plan.json" };

  const calls = new Map<string, { callId: string; status: "prepared" | "submitted" | "succeeded"; reused: boolean; resultObjectKey?: string; resultHash?: string }>();
  const artifacts = new Map<string, Record<string, unknown>>();
  let executionEnvironment: Readonly<Record<string, string>> | undefined;
  let selectedProfile = "";
  let packageValue: Record<string, unknown> | undefined;
  let parked = 0;
  const control = {
    async loadRawCheckpoint() { return new TextEncoder().encode(checkpointText); },
    async downloadVerifiedJson() { return plan; },
    async saveRawCheckpoint(args: { bytes: Uint8Array }) { checkpointText = new TextDecoder().decode(args.bytes); },
    async appendEvents() {},
    async awaitResultFeedback() { parked++; },
    async prepareTool(args: { callId: string }) {
      const existing = calls.get(args.callId);
      return existing ? { ...existing, reused: true } : { callId: args.callId, status: "prepared" as const, reused: false };
    },
    async markToolSubmitted(args: { callId: string }) {
      const value = { callId: args.callId, status: "submitted" as const, reused: false };
      calls.set(args.callId, value);
      return value;
    },
    async completeTool(args: { callId: string; resultObjectKey?: string; resultHash?: string }) {
      const value = { callId: args.callId, status: "succeeded" as const, reused: false, resultObjectKey: args.resultObjectKey, resultHash: args.resultHash };
      calls.set(args.callId, value);
      return value;
    },
    async uploadArtifact(args: { sourceCallId: string; runId: string; role: string; stepId: string; mime: string; bytes: Uint8Array; sha256: string; userVisible?: boolean }) {
      const isPackage = args.mime === "application/json";
      if (isPackage) packageValue = JSON.parse(new TextDecoder().decode(args.bytes));
      const artifact = {
        artifactId: isPackage ? "xhs-package" : "html-document", conversationId: "conversation-unified-1", runId: args.runId,
        role: args.role, stepId: args.stepId, mime: args.mime, bytes: args.bytes.byteLength, sha256: args.sha256,
        userVisible: args.userVisible ?? false, objectKey: `runs/${args.runId}/${args.sourceCallId}.${isPackage ? "json" : "html"}`,
      };
      artifacts.set(args.sourceCallId, artifact);
      return artifact;
    },
    async getArtifactByCall(_runId: string, _leaseId: string, callId: string) {
      const artifact = artifacts.get(callId);
      if (!artifact) throw new Error("artifact_missing");
      return artifact;
    },
  } as unknown as AgentControlClient;
  const contentAdapter: HarnessAdapter = {
    id: "fake-content-dsh",
    async open(seed) {
      return {
        sessionId: "content-session", runId: seed.runId,
        async turn(prompt) {
          const text = prompt[0]?.type === "text" ? prompt[0].text : "";
          ok(text.includes("reviewable Xiaohongshu draft"));
          ok(text.includes("Never claim that it was published"));
          await toolCall(executionEnvironment!, "compose_html", {
            schemaVersion: 1,
            html: "<main><img src=\"asset:reference-1\"><h1>产品重点</h1></main>",
            resourceArtifactIds: ["asset-product"],
          });
          await toolCall(executionEnvironment!, "render_html", {});
          await toolCall(executionEnvironment!, "compose_xiaohongshu", {
            schemaVersion: 1,
            title: "产品重点一图看懂",
            body: "先看核心信息，再浏览产品细节。",
            tags: ["产品设计", "视觉灵感"],
            imageNotes: ["产品长图总览"],
          });
          await toolCall(executionEnvironment!, "finalize_output", {});
          return { stopReason: "end_turn", committedContent: [] };
        },
        async cancel() {},
        async close() {},
      };
    },
  };
  const processor = new UnifiedPlanningRunProcessor({
    workspaceRoot: join(process.env.TEMP ?? ".", "bowerbird-unified-tests", randomUUID()),
    vision: { apiKey: "unused", baseUrl: "https://ark.invalid", model: "unused", mock: true },
    createAdapter() { throw new Error("planning_must_not_open"); },
    modelProxy: { upstream: { apiKey: "parent", baseUrl: "https://deepseek.invalid", model: "deepseek-v4-flash" } },
    htmlExecution: {
      renderConfig: { rendererUrl: "http://renderer.invalid", internalToken: "fixture" },
      createAdapter(environment, _provider, profileMode) {
        executionEnvironment = environment;
        selectedProfile = profileMode;
        return contentAdapter;
      },
      createRenderExecutor(_context, workspace) {
        return {
          async render(request) {
            workspace.rememberArtifact(request.callId, {
              artifactId: "full-page", conversationId: "conversation-unified-1", runId: "run-unified-1",
              role: "full_page_screenshot", stepId: "render", mime: "image/png", bytes: onePixelPng.byteLength,
              sha256: onePixelSha256, userVisible: true, objectKey: "runs/run-unified-1/full-page.png",
            }, { mime: "image/png", bytes: onePixelPng, sha256: onePixelSha256 });
            return {
              schemaVersion: 1 as const, rendererFingerprint: "fixture-renderer", sourceHtmlSha256: "e".repeat(64),
              argsHash: "f".repeat(64), renderMs: 8,
              document: { widthCssPx: 900, heightCssPx: 1200, widthDevicePx: 900, heightDevicePx: 1200 },
              outputs: [{
                artifactId: "full-page", role: "full_page_screenshot" as const,
                clipDevicePx: { x: 0, y: 0, width: 1, height: 1 }, mime: "image/png" as const,
                bytes: onePixelPng.byteLength, sha256: onePixelSha256,
              }],
              manifestArtifactId: "render-manifest", manifestObjectKey: "runs/run-unified-1/render-manifest.json",
            };
          },
        };
      },
    },
  });

  await processor.process({ claimed: runClaim, control, signal: signal() });
  equal(selectedProfile, "content-execution");
  equal(parked, 1);
  equal(packageValue?.channel, "xiaohongshu");
  deepEqual(packageValue?.images, [{ position: 1, artifactId: "full-page", note: "产品长图总览" }]);
  const saved = JSON.parse(checkpointText);
  equal(saved.phase, "awaiting_result_feedback");
  deepEqual(saved.completedToolResults.map((item: { toolName: string }) => item.toolName), [
    "compose_html", "render_html", "compose_xiaohongshu", "finalize_output",
  ]);
  equal(saved.completedToolResults.at(-1).result.primaryArtifactId, "xhs-package");
  deepEqual(saved.completedToolResults.at(-1).result.visibleArtifactIds, ["xhs-package", "full-page"]);
});

test("formal unified processor rejects unsupported approved tools before image side effects", async () => {
  const plan = {
    schemaVersion: 1 as const,
    title: "尚未接入的视觉步骤",
    summary: "先理解再交付",
    steps: [
      { id: "inspect", kind: "understand_asset" as const, goal: "理解素材", inputAssetIds: ["asset-product"], dependsOn: [] },
      { id: "finalize", kind: "finalize_output" as const, goal: "交付", inputAssetIds: [], dependsOn: ["inspect"] },
    ],
  };
  const approvedPlanHash = sha256Hex(canonicalJson(plan));
  const checkpoint = {
    schemaVersion: 1, runId: "run-unified-1", conversationId: "conversation-unified-1",
    skillId: "bowerbird-unified-agent", skillVersion: "0.1.0",
    skillHash: "d54e2216c43a8ae62baa4a1d2c9df4f3cb349c4f340304bb69a84bf77f2c8169",
    checkpointVersion: 0, phase: "compose_plan", compactedFacts: [], completedToolResults: [],
    input: { schemaVersion: 1, goal: "理解产品" },
  };
  const checkpointText = canonicalJson(checkpoint);
  const runClaim = claimed(approvedPlanHash, plan.steps.length);
  runClaim.run.checkpointHash = sha256Hex(checkpointText);
  runClaim.run.snapshotSchemaVersion = 1;
  runClaim.checkpointUrl = "https://local.invalid/checkpoint.json";
  runClaim.approvedPlan = { proposalHash: approvedPlanHash, plannedToolCount: plan.steps.length, url: "https://local.invalid/plan.json" };
  let generated = 0;
  const processor = new UnifiedPlanningRunProcessor({
    workspaceRoot: join(process.env.TEMP ?? ".", "bowerbird-unified-tests", randomUUID()),
    vision: { apiKey: "unused", baseUrl: "https://ark.invalid", model: "unused", mock: true },
    createAdapter() { throw new Error("must_not_open"); },
    createApprovedStepExecutor() {
      return { async generate() { generated += 1; throw new Error("must_not_generate"); } };
    },
  });
  const control = {
    async loadRawCheckpoint() { return new TextEncoder().encode(checkpointText); },
    async downloadVerifiedJson() { return plan; },
  } as unknown as AgentControlClient;
  await rejects(() => processor.process({ claimed: runClaim, control, signal: signal() }), /unified_agent_approved_plan_tools_unsupported/);
  equal(generated, 0);
});
