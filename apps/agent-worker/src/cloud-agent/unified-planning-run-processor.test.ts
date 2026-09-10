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
import {
  requiredExactCopyLines,
  UnifiedPlanningRunProcessor,
} from "./unified-planning-run-processor.ts";
import type { HarnessPlan } from "../harness/run-control-tools.ts";
import type { RenderHtmlResultV1 } from "../contracts/render-html.ts";
import { loadUnifiedAgentSkill } from "../skills/bowerbird-unified-agent/loader.ts";

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

for (const htmlCase of [false, true]) test(`v3 uses one Agent for ${htmlCase ? "HTML inspection and revision" : "ten images and selective repair"}, with crash-safe final selection`, async () => {
  const proposal = { schemaVersion: 3, title: "产品场景", summary: "交付十张产品场景图", assetIds: ["asset-product"],
    outputCount: htmlCase ? 1 : 10, modelTurns: 16, capabilities: htmlCase
      ? [{ tool: "compose_html", maxCalls: 2 }, { tool: "render_html", maxCalls: 2 }, { tool: "inspect_artifact", maxCalls: 1 }]
      : [{ tool: "generate_image", maxCalls: 11 }, { tool: "inspect_artifact", maxCalls: 1 }] };
  const hash = sha256Hex(canonicalJson(proposal));
  const plannedToolCount = proposal.capabilities.reduce((sum, item) => sum + item.maxCalls, 1);
  const runClaim = claimed(hash, plannedToolCount);
  const observationId = "c".repeat(64);
  const observation = { schemaVersion: 1, assetId: "asset-product", summary: "已有产品观察",
    observations: [{ category: "subject", detail: "白色瓶身，蓝色标签" }] };
  let checkpointText = canonicalJson({ schemaVersion: 1, runId: runClaim.run.id, conversationId: runClaim.run.conversationId,
    skillId: "bowerbird-unified-agent", skillVersion: "0.1.0", skillHash: loadUnifiedAgentSkill().instructionHash,
    checkpointVersion: 0, phase: "compose_plan", compactedFacts: [], completedToolResults: [],
    visualObservations: [{ assetId: "asset-product", imageSha256: "b".repeat(64), focus: "general",
      callId: observationId, summaryExcerpt: observation.summary }],
    input: { schemaVersion: 1, goal: "根据产品图生成十张不同场景图片" } });
  runClaim.run.checkpointHash = sha256Hex(checkpointText);
  runClaim.run.snapshotSchemaVersion = 1;
  runClaim.approvedPlan = { proposalHash: hash, plannedToolCount, url: "https://local.invalid/authorization" };
  let adapterCount = 0, generated = 0, active = 0, peak = 0, parked = 0, visionCalls = 0, rendered = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const statuses = new Map<string, string>();
  const delivered: string[] = [];
  let crash = true;
  const events: Array<{ type: string; displayPayload?: Record<string, unknown> }> = [];
  const control = {
    async loadRawCheckpoint() { return new TextEncoder().encode(checkpointText); },
    async downloadVerifiedJson(url: string) { return url === "https://local.invalid/observation" ? observation : proposal; },
    async getArtifactByCall(_run: string, _lease: string, id: string) {
      equal(id, observationId);
      return { role: "diagnostic", mime: "application/json", url: "https://local.invalid/observation", sha256: "d".repeat(64) };
    },
    async saveRawCheckpoint(args: { bytes: Uint8Array }) {
      const next = new TextDecoder().decode(args.bytes);
      if (crash && JSON.parse(next).phase === "awaiting_result_feedback") { crash = false; throw new SimulatedProcessCrash(); }
      checkpointText = next;
    },
    async appendEvents(_runId: string, _leaseId: string, batch: typeof events) { events.push(...batch); },
    async awaitResultFeedback() { parked++; },
    async prepareTool(args: { callId: string }) {
      const existing = statuses.get(args.callId); statuses.set(args.callId, existing ?? "prepared");
      return { callId: args.callId, status: existing ?? "prepared", reused: !!existing };
    },
    async markToolSubmitted(args: { callId: string }) { statuses.set(args.callId, "submitted"); return { callId: args.callId, status: "submitted", reused: false }; },
    async completeTool(args: { callId: string }) { statuses.set(args.callId, "succeeded"); },
    async uploadDiagnostic(args: { sourceCallId: string; bytes: Uint8Array; sha256: string }) {
      return { artifactId: `diagnostic-${args.sourceCallId}`, objectKey: `diagnostic/${args.sourceCallId}`,
        mime: "application/json", bytes: args.bytes.byteLength, sha256: args.sha256, role: "diagnostic" };
    },
    async recordUsage() { visionCalls++; },
    async uploadArtifact(args: { sourceCallId: string; parentArtifactId: string; sha256: string; role: string; bytes: Uint8Array; mime: string }) {
      if (args.role === "final_result") delivered.push(args.parentArtifactId);
      return { artifactId: `output-${args.sourceCallId}`, runId: runClaim.run.id, conversationId: runClaim.run.conversationId,
        objectKey: `outputs/${args.sourceCallId}`, sha256: args.sha256, role: args.role, bytes: args.bytes.byteLength, mime: args.mime, userVisible: args.role === "final_result" };
    },
  } as unknown as AgentControlClient;
  const processor = new UnifiedPlanningRunProcessor({
    workspaceRoot: join(process.env.TEMP ?? ".", "bowerbird-adaptive-tests", randomUUID()),
    vision: { apiKey: "unused", baseUrl: "https://ark.invalid", model: "unused", mock: true },
    modelProxy: { upstream: { apiKey: "unused", baseUrl: "https://deepseek.invalid", model: "fixture" } },
    createApprovedStepExecutor(context, workspace) {
      return { async generate(request) {
        generated++; active++; peak = Math.max(peak, active);
        if (generated === 10) release();
        await barrier; active--;
        const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        const image = { mime: "image/png" as const, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
        const artifact = { artifactId: request.stepId, runId: context.claimed.run.id,
          conversationId: context.claimed.run.conversationId, role: "stage_result" as const,
          mime: image.mime, bytes: image.bytes.byteLength, sha256: image.sha256, userVisible: false, objectKey: request.stepId };
        workspace.rememberArtifact(request.callId, artifact, image);
        return artifact;
      } };
    },
    htmlExecution: {
      renderConfig: { rendererUrl: "http://renderer.invalid", internalToken: "fixture" },
      createAdapter() { throw new Error("must_not_start_domain_agent"); },
      createRenderExecutor(context, workspace) {
        return { async render(request) {
          rendered++;
          const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const artifactId = `render-${rendered}`;
          workspace.rememberArtifact(request.callId, { artifactId, role: "full_page_screenshot", mime: "image/png", bytes: bytes.byteLength,
            sha256, userVisible: true, runId: context.claimed.run.id, conversationId: context.claimed.run.conversationId, objectKey: artifactId },
            { mime: "image/png", bytes, sha256 });
          return { schemaVersion: 1, rendererFingerprint: "fixture", sourceHtmlSha256: sha256, argsHash: sha256,
            document: { widthCssPx: 800, heightCssPx: 600, widthDevicePx: 800, heightDevicePx: 600 }, renderMs: 1,
            manifestArtifactId: `manifest-${rendered}`, manifestObjectKey: `manifest-${rendered}`,
            outputs: [{ artifactId, role: "full_page_screenshot", mime: "image/png", bytes: bytes.byteLength, sha256,
              clipDevicePx: { x: 0, y: 0, width: 800, height: 600 } }] };
        } };
      },
    },
    createAdapter(environment) {
      adapterCount++;
      const execute = (toolName: string, actionId: string, input: unknown) => toolCall(environment, "call_tool", {
        toolName, actionId, inputJson: JSON.stringify(input),
      });
      return { id: "adaptive-fixture", async open(seed) { return { sessionId: "one-agent", runId: seed.runId,
        async turn(prompt) {
          const promptText = canonicalJson(prompt);
          ok(promptText.includes(`vision:${observationId}:0`));
          ok(promptText.includes("requiredOutputCount"));
          const readState = async () => (await toolCall(environment, "read_context", { id: "run_state" }) as {
            content: { progress: { availableCandidateCount: number }; actions: Array<{ outputArtifactIds: string[] }> }
          }).content;
          equal((await readState()).progress.availableCandidateCount, 0);
          const cached = await toolCall(environment, "read_context", { id: `vision:${observationId}:0` }) as { content: { text: string } };
          deepEqual(JSON.parse(cached.content.text), observation);
          equal(visionCalls, 0);
          const unavailable = await toolCall(environment, "understand_asset", { assetId: "asset-product", focus: "general" }) as { correction: string };
          ok(unavailable.correction.includes("call_tool"));
          if (htmlCase) {
            const first = await execute("compose_html", "layout-first", { html: "<main><h1>产品</h1></main>", assetIds: [] }) as { artifactId: string };
            const preview = await execute("render_html", "preview-first", { documentId: first.artifactId }) as RenderHtmlResultV1;
            const current = await readState();
            equal(current.progress.availableCandidateCount, 1);
            ok(current.actions.some(action => action.outputArtifactIds.includes(preview.outputs[0]!.artifactId)));
            await execute("inspect_artifact", "inspect-layout", { assetId: preview.outputs[0]!.artifactId, focus: "layout", goal: "检查布局" });
            const revised = await execute("compose_html", "layout-revised", { html: "<main><h1>产品</h1><p>修订布局</p></main>", assetIds: [] }) as { artifactId: string };
            const final = await execute("render_html", "preview-revised", { documentId: revised.artifactId }) as RenderHtmlResultV1;
            await execute("finalize_output", "deliver", { assetIds: [final.outputs[0]!.artifactId] });
            return { stopReason: "end_turn", committedContent: [] };
          }
          await Promise.all(Array.from({ length: 10 }, (_, index) => execute("generate_image", `scene-${index}`,
            { prompt: `产品场景 ${index}`, assetIds: ["asset-product"] })));
          await execute("inspect_artifact", "check-one", { assetId: "scene-2", focus: "subject", goal: "检查主体一致性" });
          await execute("generate_image", "repair-one", { prompt: "修正产品标签", assetIds: ["scene-2"] });
          const recovered = await toolCall(environment, "read_context", { id: "action:repair-one:0" }) as { content: { text: string } };
          const action = JSON.parse(recovered.content.text);
          equal(action.actionId, "repair-one");
          equal(action.status, "completed");
          equal(action.arguments.prompt, "修正产品标签");
          await execute("finalize_output", "deliver", { assetIds: Array.from({ length: 10 }, (_, index) => index === 2 ? "repair-one" : `scene-${index}`) });
          return { stopReason: "end_turn", committedContent: [] };
        }, async close() {}, async cancel() {},
      }; } };
    },
  });
  await rejects(() => processor.process({ claimed: runClaim, control, signal: signal() }), SimulatedProcessCrash);
  equal(generated, htmlCase ? 0 : 11); equal(peak, htmlCase ? 0 : 10); equal(visionCalls, 1); equal(delivered.length, htmlCase ? 1 : 10);
  if (htmlCase) { equal(rendered, 2); deepEqual(delivered, ["render-2"]); }
  else { ok(delivered.includes("repair-one")); ok(!delivered.includes("scene-2")); }
  runClaim.run.checkpointHash = sha256Hex(checkpointText);
  await processor.process({ claimed: runClaim, control, signal: signal() });
  equal(adapterCount, 1); equal(generated, htmlCase ? 0 : 11); equal(delivered.length, htmlCase ? 1 : 10); equal(parked, 1);
  equal(events.find((event) => event.type === "result.ready")?.displayPayload?.selectionVersion, 1);
});

test("exact detail delivery extracts only the fenced source copy for parent validation", () => {
  deepEqual(requiredExactCopyLines("给产品做详情页。参考内容：# 标题 —— 副标题\n\n正文，逐字保留。\n:::"), [
    "标题——副标题",
    "正文,逐字保留。",
  ]);
  deepEqual(requiredExactCopyLines("给产品生成一张主图。参考内容：普通视觉方向"), []);
});

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
          ok(!text.includes("htmlOutput"));
          ok(!text.includes("full_page_and_slices"));
          ok(!text.includes("普通修图"));
          ok(!text.includes("staged_controlled"));
          ok(!text.includes("BOWERBIRD_REQUIRED_DELIVERY_POLICY_V1"));
          ok(text.includes("project_visual_profile"));
          ok(!text.includes(visualProfileCapsule.hash));
          ok(!text.includes("contentThemes"));
          const profileContext = await toolCall(adapterEnvironment!, "read_context", { id: "project_visual_profile" }) as { content: unknown };
          ok(JSON.stringify(profileContext.content).includes(visualProfileCapsule.hash));
          ok(JSON.stringify(profileContext.content).includes("never mutate or write back"));
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
    skillHash: "7e2285cb221119152498b7938930c7812b4d8384b45299b606b6df9fe79dce91",
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

test("formal unified processor runs eight independent image branches concurrently and keeps every final artifact", async () => {
  const sceneSteps = Array.from({ length: 8 }, (_, index) => ({
    id: `scene_${index + 1}`,
    kind: "generate_image" as const,
    goal: `生成场景 ${index + 1}`,
    inputAssetIds: ["asset-product"],
    dependsOn: [],
  }));
  const plan = {
    schemaVersion: 1 as const,
    title: "八张并列场景组图",
    summary: "同一产品在八个独立场景中生成",
    steps: [
      ...sceneSteps,
      { id: "finalize", kind: "finalize_output" as const, goal: "交付全部场景", inputAssetIds: [], dependsOn: sceneSteps.map((step) => step.id) },
    ],
  };
  const approvedPlanHash = sha256Hex(canonicalJson(plan));
  let checkpointText = canonicalJson({
    schemaVersion: 1, runId: "run-unified-1", conversationId: "conversation-unified-1",
    skillId: "bowerbird-unified-agent", skillVersion: "0.1.0",
    skillHash: "7e2285cb221119152498b7938930c7812b4d8384b45299b606b6df9fe79dce91",
    checkpointVersion: 0, phase: "compose_plan", compactedFacts: [], completedToolResults: [],
    input: { schemaVersion: 1, goal: "参考风格图，为产品生成不同场景组图" },
  });
  const runClaim = claimed(approvedPlanHash, plan.steps.length);
  runClaim.run.checkpointHash = sha256Hex(checkpointText);
  runClaim.run.snapshotSchemaVersion = 1;
  runClaim.checkpointUrl = "https://local.invalid/checkpoint.json";
  runClaim.approvedPlan = { proposalHash: approvedPlanHash, plannedToolCount: plan.steps.length, url: "https://local.invalid/plan.json" };

  let releaseImages!: () => void;
  const released = new Promise<void>((resolve) => { releaseImages = resolve; });
  let markAllStarted!: () => void;
  const allStarted = new Promise<void>((resolve) => { markAllStarted = resolve; });
  let active = 0;
  let maxActive = 0;
  const generated: GenerateApprovedStepRequest[] = [];
  const events: Array<{ type: string; displayPayload?: Record<string, unknown> }> = [];
  let parked = 0;
  const processor = new UnifiedPlanningRunProcessor({
    workspaceRoot: join(process.env.TEMP ?? ".", "bowerbird-unified-tests", randomUUID()),
    vision: { apiKey: "unused", baseUrl: "https://ark.invalid", model: "unused", mock: true },
    createAdapter() { throw new Error("must_not_open"); },
    createApprovedStepExecutor() {
      return {
        async generate(request) {
          generated.push(request);
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (generated.length === sceneSteps.length) markAllStarted();
          await released;
          active -= 1;
          return {
            artifactId: `artifact-${request.stepId}`,
            mime: "image/png",
            bytes: 42,
            sha256: String(Number(request.stepId.split("_")[1])).repeat(64),
          };
        },
      };
    },
  });
  const control = {
    async loadRawCheckpoint() { return new TextEncoder().encode(checkpointText); },
    async downloadVerifiedJson() { return plan; },
    async saveRawCheckpoint(args: { bytes: Uint8Array }) { checkpointText = new TextDecoder().decode(args.bytes); },
    async appendEvents(_runId: string, _leaseId: string, next: typeof events) { events.push(...next); },
    async awaitResultFeedback() { parked += 1; },
  } as unknown as AgentControlClient;

  const processing = processor.process({ claimed: runClaim, control, signal: signal() });
  const startedTogether = await Promise.race([
    allStarted.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  releaseImages();
  await processing;

  equal(startedTogether, true);
  equal(maxActive, 8);
  equal(generated.length, 8);
  ok(generated.every((request) => request.outputRole === "final_result"));
  equal(parked, 1);
  const checkpoint = JSON.parse(checkpointText) as { phase: string; completedToolResults: unknown[] };
  equal(checkpoint.phase, "awaiting_result_feedback");
  equal(checkpoint.completedToolResults.length, 8);
  const ready = events.find((event) => event.type === "result.ready");
  deepEqual(ready?.displayPayload?.artifactIds, sceneSteps.map((step) => `artifact-${step.id}`));
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
    skillHash: "7e2285cb221119152498b7938930c7812b4d8384b45299b606b6df9fe79dce91",
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

for (const mixed of [false, true]) test(`approved HTML execution survives restart (generated resources: ${mixed})`, async () => {
  const plan: HarnessPlan = {
    schemaVersion: 1 as const,
    title: "批准的 HTML 长图",
    summary: "排版当前产品素材并离线渲染",
    steps: [
      { id: "compose", kind: "compose_html" as const, goal: "生成受限 HTML", inputAssetIds: ["asset-product"], dependsOn: [] },
      { id: "render", kind: "render_html" as const, goal: "离线渲染", inputAssetIds: [], dependsOn: ["compose"] },
      { id: "inspect", kind: "inspect_artifact" as const, goal: "检查整页层级与内容完整性", inputAssetIds: [], dependsOn: ["render"] },
      { id: "finalize", kind: "finalize_output" as const, goal: "交付长图", inputAssetIds: [], dependsOn: ["inspect"] },
    ],
  };
  if (mixed) {
    plan.steps[0]!.dependsOn = ["generate"];
    plan.steps.unshift({ id: "generate", kind: "generate_image", goal: "海边产品主视觉", inputAssetIds: ["asset-product"], dependsOn: [] });
  }
  const resourceIds = mixed ? ["asset-product", "generated-scene"] : ["asset-product"];
  const generatedCalls = new Set<string>();
  const approvedPlanHash = sha256Hex(canonicalJson(plan));
  const checkpoint = {
    schemaVersion: 1, runId: "run-unified-1", conversationId: "conversation-unified-1",
    skillId: "bowerbird-unified-agent", skillVersion: "0.1.0",
    skillHash: "7e2285cb221119152498b7938930c7812b4d8384b45299b606b6df9fe79dce91",
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
      if (crashBeforeResultCheckpoint && next.completedToolResults.length === plan.steps.length) {
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
          const text = prompt[0]?.type === "text" ? prompt[0].text : "";
          ok(text.includes("html_render_contract"));
          ok(!text.includes('"widthCssPx":1080'));
          const renderContext = JSON.stringify(await toolCall(executionEnvironment!, "read_context", { id: "html_render_contract" }));
          ok(renderContext.includes('"widthCssPx":1080'));
          ok(renderContext.includes('"htmlSrc":"asset:reference-1"'));
          ok(renderContext.includes("none of the literal tokens <!--, -->, /*, or */"));
          await toolCall(executionEnvironment!, "compose_html", {
            schemaVersion: 1,
            html: "<main><img src=\"asset:reference-1\"><h1>完整推文</h1></main>",
            resourceArtifactIds: resourceIds,
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
    createApprovedStepExecutor(_context, workspace) {
      return { async generate(request) {
        generatedCalls.add(request.callId);
        equal(request.outputRole, "stage_result");
        const artifact = { artifactId: "generated-scene", conversationId: "conversation-unified-1", runId: "run-unified-1", role: "stage_result" as const, stepId: "generate", mime: "image/png" as const, bytes: onePixelPng.byteLength, sha256: onePixelSha256, userVisible: true, objectKey: "generated.png" };
        workspace.rememberArtifact(request.callId, artifact, { mime: "image/png", bytes: onePixelPng, sha256: onePixelSha256 });
        return artifact;
      } };
    },
    htmlExecution: {
      renderConfig: { rendererUrl: "http://renderer.invalid", internalToken: "fixture" },
      createAdapter(environment) { executionEnvironment = environment; return htmlAdapter; },
      createRenderExecutor(_context, workspace) {
        return {
          async render(request) {
            if (mixed) equal((await workspace.readArtifact("generated-scene")).sha256, onePixelSha256);
            const restored = renderedByCall.get(request.callId);
            const result = restored ?? (() => {
              renderCalls++;
              equal(request.input.htmlArtifactId, "html-document");
              deepEqual(request.input.resourceArtifactIds, resourceIds);

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
  equal(generatedCalls.size, mixed ? 1 : 0);
  deepEqual(saved.completedToolResults.map((item: { toolName: string }) => item.toolName), plan.steps.map((step) => step.kind));
  equal(saved.completedToolResults.at(-1).result.primaryArtifactId, "full-page");
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
      { id: "render", kind: "render_html" as const, goal: "渲染长图", inputAssetIds: [], dependsOn: ["compose"] },
      { id: "compose_xhs", kind: "compose_xiaohongshu" as const, goal: "派生小红书草稿", inputAssetIds: [], dependsOn: ["render"] },
      { id: "finalize", kind: "finalize_output" as const, goal: "交付渠道包", inputAssetIds: [], dependsOn: ["compose_xhs"] },
    ],
  };
  const approvedPlanHash = sha256Hex(canonicalJson(plan));
  let checkpointText = canonicalJson({
    schemaVersion: 1, runId: "run-unified-1", conversationId: "conversation-unified-1",
    skillId: "bowerbird-unified-agent", skillVersion: "0.1.0",
    skillHash: "7e2285cb221119152498b7938930c7812b4d8384b45299b606b6df9fe79dce91",
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
          ok(!text.includes("reviewable Xiaohongshu draft"));
          ok(text.includes("xiaohongshu_draft"));
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
    skillHash: "7e2285cb221119152498b7938930c7812b4d8384b45299b606b6df9fe79dce91",
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
