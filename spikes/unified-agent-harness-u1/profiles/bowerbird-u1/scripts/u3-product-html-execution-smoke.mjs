import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { UnifiedPlanningRunProcessor } from "../../../../../apps/agent-worker/src/cloud-agent/unified-planning-run-processor.ts";
import { AgentControlError } from "../../../../../apps/agent-worker/src/control-plane/agent-control-client.ts";
import { DshAcpHarnessAdapter } from "../../../../../apps/agent-worker/src/harness/dsh-acp-harness-adapter.ts";
import { NodeDshAcpPort } from "../../../../../apps/agent-worker/src/harness/node-dsh-acp-port.ts";
import { validateHarnessPlan } from "../../../../../apps/agent-worker/src/harness/run-control-tools.ts";
import { canonicalJson, sha256Hex } from "../../../../../apps/agent-worker/src/kernel/tool-ledger.ts";
import {
  creditsForAgentUsage,
  normalizeAgentUsageItem,
  parseAgentUsagePricing,
} from "../../../../../apps/cloud/supabase/functions/_shared/agent-usage-pricing.ts";
import { startRenderServer } from "../../../../../apps/html-renderer/src/server.ts";
import { createRenderService } from "../../../../../apps/html-renderer/src/render-service.ts";
import { computeRendererFingerprint } from "../../../../../apps/html-renderer/src/fingerprint.ts";
import { createU3VisualProfileFixture } from "./u3-product-planning-smoke.mjs";
import { loadUnifiedAgentSkill } from "../../../../../apps/agent-worker/src/skills/bowerbird-unified-agent/loader.ts";

const REAL_EXECUTION_FLAG = "--allow-real-u3-html-execution";
const PROFILE_TEMPLATE = join(import.meta.dirname, "..");
const REPO_ROOT = join(import.meta.dirname, "../../../../../");
const PRODUCT_PATH = join(REPO_ROOT, "apps/desktop/src-tauri/resources/samples/preset-01.webp");
const STYLE_PATH = join(REPO_ROOT, "apps/desktop/src-tauri/resources/samples/preset-11.webp");
const PRODUCT_ASSET_ID = "asset-product";
const STYLE_ASSET_ID = "asset-typography-style";
const DSH_MODEL = "deepseek-v4-flash";
const EXECUTION_TIMEOUT_MS = 240_000;

const PRICING = parseAgentUsagePricing({
  billing: "agent_usage",
  model_tokens: {
    provider: "deepseek",
    input_tokens_per_credit: 500_000,
    output_tokens_per_credit: 100_000,
    minimum_credits: 1,
  },
  vision_call: { provider: "ark", credits_per_call: 1 },
  image_generation: { ark: 5, jimeng: 0, codex: 0 },
  html_render: { credits_per_call: 0 },
}, 1);

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name}_missing`);
  return normalized;
}

function sha256(bytesOrText) {
  return createHash("sha256").update(bytesOrText).digest("hex");
}

function outputRoot(argv) {
  const option = argv.find((value) => value.startsWith("--output-dir="));
  if (option) return join(process.cwd(), option.slice("--output-dir=".length));
  return join(REPO_ROOT, "spikes/unified-agent-harness-u1/results/u3-html-execution");
}

function recoverSuccessDirectory(argv) {
  const option = argv.find((value) => value.startsWith("--recover-success-dir="));
  return option?.slice("--recover-success-dir=".length) ?? null;
}

function recoverSuccessfulRun(runDir) {
  const failurePath = join(runDir, "failure-report.json");
  const failure = JSON.parse(readFileSync(failurePath, "utf8"));
  const calls = Array.isArray(failure.calls) ? failure.calls : [];
  const required = ["compose_html", "render_html", "inspect_artifact"];
  assert.deepEqual(
    calls.filter((call) => required.includes(call.toolName)).map((call) => [call.toolName, call.status]),
    required.map((toolName) => [toolName, "succeeded"]),
  );
  assert.equal(calls.filter((call) => call.toolName === "model_turn" && call.status === "succeeded").length, 4);
  assert.equal(failure.usage?.arkVisionCalls, 1);
  assert.equal(failure.usage?.htmlRenderCalls, 1);
  assert.ok(failure.checkpointSteps?.some((item) => item.step === "awaiting_result_feedback" && item.progress === 90));
  const files = failure.artifacts.map((artifact) => artifact.filePath);
  const html = failure.artifacts.find((artifact) => artifact.role === "html_document")?.filePath;
  const manifest = failure.artifacts.find((artifact) => artifact.role === "render_manifest")?.filePath;
  const primary = failure.artifacts.find((artifact) => artifact.role === "full_page_screenshot")?.filePath;
  const visible = failure.artifacts
    .filter((artifact) => artifact.role === "full_page_screenshot" || artifact.role === "slice_screenshot")
    .map((artifact) => artifact.filePath);
  assert.ok(html && manifest && primary && files.every((filePath) => existsSync(filePath)));
  const manifestValue = JSON.parse(readFileSync(manifest, "utf8"));
  const report = {
    ok: true,
    real: { dsh: true, deepSeek: true, renderer: true, arkVision: true },
    runId: failure.runId,
    proposalHash: failure.proposalHash,
    toolChain: [
      { toolName: "compose_html", status: "succeeded" },
      { toolName: "render_html", status: "succeeded" },
      { toolName: "inspect_artifact", status: "succeeded" },
      { toolName: "finalize_output", status: "succeeded", evidence: "awaiting_result_feedback checkpoint" },
    ],
    timing: { totalMs: failure.elapsedMs, rendererMs: manifestValue.renderMs },
    usage: {
      deepSeekTurns: failure.usage.deepSeekTurns,
      deepSeekInputTokens: failure.usage.deepSeekInputTokens,
      deepSeekOutputTokens: failure.usage.deepSeekOutputTokens,
      arkVisionCalls: 1,
      htmlRenderCalls: 1,
      actualCredits: failure.usage.deepSeekTurns + 1,
    },
    renderer: { fingerprint: manifestValue.rendererFingerprint },
    artifacts: {
      html,
      manifest,
      primary,
      visible,
      privateDiagnostics: failure.artifacts.filter((artifact) => artifact.role === "diagnostic").length,
    },
    checkpointSteps: failure.checkpointSteps,
    recoveredFromHarnessAssertionBug: true,
    deployed: false,
  };
  const reportPath = join(runDir, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { ...report, reportPath };
}

function approvedPlan(profile) {
  return validateHarnessPlan({
    schemaVersion: 2,
    title: "紫白双罐未来感产品长图",
    summary: "以产品图作为唯一产品事实来源，使用用户给定推文建立大字、留白与分区节奏；排版参考只贡献抽象字形节奏，不展示其原图、不复用其文字、主体或黑白配色。独立 Logo、功效、成分与品类事实均不补写。",
    contentPlan: {
      assetAssignments: [
        {
          assetId: PRODUCT_ASSET_ID,
          roles: ["product", "supporting"],
          rationale: "唯一产品事实来源；可见紫白双罐悬浮、未来感光线与机械陈列元素。标签文字仅作为图中既有像素，不转写成新增事实。",
        },
        {
          assetId: STYLE_ASSET_ID,
          roles: ["style_reference"],
          rationale: "只参考超大展示字与充足留白的版式节奏；不显示这张图，不复制其汉字、品牌、主体或黑白配色。",
        },
      ],
      informationArchitecture: [
        {
          id: "hero",
          purpose: "首屏用超大中文标题与完整产品主图建立紫白未来感，产品优先于装饰。",
          sourceAssetIds: [PRODUCT_ASSET_ID],
          copySource: "user_goal",
        },
        {
          id: "product_stage",
          purpose: "用同一产品图的受控裁切、留白和紫色分区展示双罐包装、质感与悬浮陈列方式，不增加产品事实。",
          sourceAssetIds: [PRODUCT_ASSET_ID],
          copySource: "none",
        },
        {
          id: "type_rhythm",
          purpose: "采用排版参考的大字与留白节奏，但不显示参考图、不复制参考文字或黑白配色。",
          sourceAssetIds: [STYLE_ASSET_ID],
          copySource: "none",
        },
        {
          id: "closing",
          purpose: "以用户原文收束，保持包装、质感和展示方式三项视觉重点。",
          sourceAssetIds: [PRODUCT_ASSET_ID],
          copySource: "user_goal",
        },
      ],
      missingAssets: [
        { id: "independent_logo", purpose: "独立可复用 Logo", decision: "not_needed", resolutionStepId: null },
        { id: "efficacy_claims", purpose: "功效、成分、品类与认证事实", decision: "not_needed", resolutionStepId: null },
      ],
      visualProfile: {
        profileId: profile.profileId,
        version: profile.version,
        hash: profile.hash,
        applied: [
          "信息层级清楚，产品主体优先于装饰",
          "使用明确分区和充足留白组织长图节奏",
          "避免与产品紫白主色冲突的高饱和杂色",
        ],
        ignoredContentThemes: ["咖啡器具"],
      },
    },
    steps: [
      {
        id: "compose",
        kind: "compose_html",
        goal: "生成安全的 1080px 宽产品长图 HTML。只可用 asset:reference-1 展示产品图；不得显示排版参考图。可用文案仅为『双罐悬浮，紫白未来感；一眼看见包装、质感和展示方式。』及其不改变事实的短句拆分。采用紫白未来感、大字、清晰分区和充足留白；不添加品牌、Logo、功效、成分、品类、认证或购买信息。",
        inputAssetIds: [PRODUCT_ASSET_ID],
        dependsOn: [],
      },
      {
        id: "render",
        kind: "render_html",
        goal: "按冻结的 1080px 整页加无重叠切片规格，在现有断网 sanitizer 与 sandbox 契约内渲染。",
        inputAssetIds: [PRODUCT_ASSET_ID],
        dependsOn: ["compose"],
      },
      {
        id: "inspect",
        kind: "inspect_artifact",
        goal: "检查整页的信息层级、文字可读性、产品裁切、重复节奏和事实边界；不得提出未批准的生成或修改。",
        inputAssetIds: [],
        dependsOn: ["render"],
      },
      {
        id: "finalize",
        kind: "finalize_output",
        goal: "提交父进程选定的整页与切片产物，等待人工验收。",
        inputAssetIds: [],
        dependsOn: ["inspect"],
      },
    ],
  });
}

function planningInput(profile) {
  return {
    schemaVersion: 1,
    goal: "为紫白色双罐护理产品制作 1080px 宽 HTML 长图。用户推文：『双罐悬浮，紫白未来感；一眼看见包装、质感和展示方式。』产品事实只来自产品图，排版参考只贡献大字与留白节奏，禁止新增功效、成分、品类或品牌事实。",
    htmlOutput: {
      viewport: { widthCssPx: 1080, heightCssPx: 900, deviceScaleFactor: 1 },
      capture: { mode: "full_page_and_slices", sliceHeightCssPx: 1080, overlapCssPx: 0 },
      background: "opaque",
    },
    visualProfileCapsule: profile,
  };
}

function fixtureAssets(runId, conversationId) {
  return [
    {
      artifactId: PRODUCT_ASSET_ID,
      conversationId,
      runId,
      role: "input",
      mime: "image/webp",
      width: 506,
      height: 900,
      userVisible: true,
      bytesValue: new Uint8Array(readFileSync(PRODUCT_PATH)),
    },
    {
      artifactId: STYLE_ASSET_ID,
      conversationId,
      runId,
      role: "control_reference",
      mime: "image/webp",
      width: 720,
      height: 480,
      userVisible: true,
      bytesValue: new Uint8Array(readFileSync(STYLE_PATH)),
    },
  ].map((asset) => ({
    ...asset,
    bytes: asset.bytesValue.byteLength,
    sha256: sha256(asset.bytesValue),
    url: `memory://${asset.artifactId}`,
  }));
}

function artifactExtension(mime) {
  return mime === "image/png" ? "png" : mime === "text/html" ? "html" : mime === "application/json" ? "json" : "bin";
}

function createMemoryControl({ runId, conversationId, leaseId, plan, planHash, checkpointBytes, assets, outputDir }) {
  const calls = new Map();
  const artifacts = new Map();
  const artifactById = new Map();
  const bytesByUrl = new Map(assets.map((asset) => [asset.url, asset.bytesValue]));
  const usage = new Map();
  const events = [];
  const checkpointHistory = [];
  let artifactSequence = 0;
  let currentCheckpoint = checkpointBytes;
  let parked = false;

  const artifactKey = (callId, outputName = "default") => `${callId}:${outputName}`;
  const safePart = (value) => value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);

  return {
    state: {
      calls,
      artifacts,
      artifactById,
      usage,
      events,
      checkpointHistory,
      get parked() { return parked; },
      get currentCheckpoint() { return Uint8Array.from(currentCheckpoint); },
    },
    control: {
      async loadRawCheckpoint() { return currentCheckpoint; },
      async downloadVerifiedJson(url, expectedSha256) {
        assert.equal(url, "https://u3-fixture.invalid/approved-plan.json");
        assert.equal(expectedSha256, planHash);
        return plan;
      },
      async downloadVerifiedBytes(url, expected) {
        const bytes = bytesByUrl.get(url);
        if (!bytes || bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
          throw new Error("u3_execution_artifact_verification_failed");
        }
        return Uint8Array.from(bytes);
      },
      async saveRawCheckpoint(args) {
        assert.equal(args.runId, runId);
        assert.equal(args.leaseId, leaseId);
        assert.equal(sha256(args.bytes), args.sha256);
        currentCheckpoint = Uint8Array.from(args.bytes);
        checkpointHistory.push({ step: args.step, progress: args.progress, sha256: args.sha256, bytes: args.bytes.byteLength });
        return { checkpointHash: args.sha256, objectKey: `memory/checkpoint-${checkpointHistory.length}.json` };
      },
      async appendEvents(eventRunId, eventLeaseId, nextEvents) {
        assert.equal(eventRunId, runId);
        assert.equal(eventLeaseId, leaseId);
        events.push(...nextEvents);
      },
      async prepareTool(args) {
        const existing = calls.get(args.callId);
        if (existing) {
          assert.equal(existing.argsHash, args.argsHash);
          return { ...existing, reused: true };
        }
        const created = {
          callId: args.callId,
          argsHash: args.argsHash,
          toolName: args.toolName,
          phase: args.phase,
          status: "prepared",
          reused: false,
          preparedAt: Date.now(),
        };
        calls.set(args.callId, created);
        return created;
      },
      async markToolSubmitted(args) {
        const current = calls.get(args.callId);
        assert.ok(current);
        const next = { ...current, status: "submitted", submittedAt: Date.now(), providerRequestId: args.providerRequestId };
        calls.set(args.callId, next);
        return next;
      },
      async completeTool(args) {
        const current = calls.get(args.callId);
        assert.ok(current);
        const next = { ...current, ...args, completedAt: Date.now(), reused: false };
        calls.set(args.callId, next);
        return next;
      },
      async uploadArtifact(args) {
        const key = artifactKey(args.sourceCallId, args.outputName);
        const existing = artifacts.get(key);
        if (existing) {
          if (existing.sha256 !== args.sha256) throw new AgentControlError(409);
          return existing;
        }
        assert.equal(args.runId, runId);
        assert.equal(args.leaseId, leaseId);
        assert.equal(sha256(args.bytes), args.sha256);
        const artifactId = `artifact-${String(++artifactSequence).padStart(3, "0")}`;
        const fileName = `${artifactId}-${safePart(args.role)}-${safePart(args.outputName ?? "default")}.${artifactExtension(args.mime)}`;
        const filePath = join(outputDir, fileName);
        writeFileSync(filePath, args.bytes);
        const url = `memory://${artifactId}`;
        const artifact = {
          artifactId,
          conversationId,
          runId,
          role: args.role,
          stepId: args.stepId,
          parentArtifactId: args.parentArtifactId ?? null,
          mime: args.mime,
          bytes: args.bytes.byteLength,
          sha256: args.sha256,
          userVisible: args.userVisible ?? true,
          objectKey: relative(REPO_ROOT, filePath).replaceAll("\\", "/"),
          url,
          filePath,
        };
        artifacts.set(key, artifact);
        artifactById.set(artifactId, artifact);
        bytesByUrl.set(url, Uint8Array.from(args.bytes));
        return artifact;
      },
      async uploadDiagnostic(args) {
        return await this.uploadArtifact({
          ...args,
          role: "diagnostic",
          mime: "application/json",
          userVisible: false,
          outputName: args.outputName ?? "diagnostic",
        });
      },
      async getArtifactByCall(_runId, _leaseId, callId, outputName) {
        const artifact = artifacts.get(artifactKey(callId, outputName));
        if (!artifact) throw new AgentControlError(409);
        return artifact;
      },
      async recordUsage(args) {
        const key = `${args.kind}:${args.callId}`;
        const normalized = normalizeAgentUsageItem({
          callId: args.callId,
          kind: args.kind,
          provider: args.provider,
          model: args.model,
          inputUnits: args.inputUnits ?? 0,
          outputUnits: args.outputUnits ?? 0,
          imageCount: args.imageCount ?? 0,
          ...(args.resolution ? { resolution: args.resolution } : {}),
        });
        const existing = usage.get(key);
        if (existing) assert.deepEqual(existing, normalized);
        else usage.set(key, normalized);
      },
      async awaitResultFeedback(awaitRunId, awaitLeaseId) {
        assert.equal(awaitRunId, runId);
        assert.equal(awaitLeaseId, leaseId);
        parked = true;
      },
    },
  };
}

function findChromiumExecutable(env) {
  const candidates = [
    env.BOWERBIRD_E2E_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

async function startRealLocalRenderer(env) {
  const require = createRequire(join(REPO_ROOT, "apps/html-renderer/package.json"));
  const { chromium } = require("playwright");
  const executablePath = findChromiumExecutable(env);
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--force-color-profile=srgb", "--hide-scrollbars"],
    handleSIGHUP: false,
    handleSIGINT: false,
    handleSIGTERM: false,
  });
  const token = randomBytes(32).toString("hex");
  const logs = [];
  const service = createRenderService(browser, (event) => logs.push(event));
  const rendererFingerprint = computeRendererFingerprint(browser.version());
  const running = startRenderServer({
    port: 0,
    token,
    handleRender: (body) => service.execute(body, typeof body?.requestId === "string" ? body.requestId : "unknown"),
    health: () => ({ rendererFingerprint, chromiumVersion: browser.version() }),
    log: (event) => logs.push(event),
  });
  await new Promise((resolve, reject) => {
    running.server.once("error", reject);
    running.server.listen(0, "127.0.0.1", resolve);
  });
  const address = running.server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    rendererFingerprint,
    chromiumVersion: browser.version(),
    executablePath: executablePath ?? "playwright-managed",
    logs,
    async close() {
      await running.close();
      await browser.close();
    },
  };
}

function actualCredits(usage) {
  return [...usage.values()].reduce((sum, item) => sum + creditsForAgentUsage(item, PRICING), 0);
}

export async function runU3ProductHtmlExecutionSmoke({ argv = process.argv, env = process.env } = {}) {
  const recovery = recoverSuccessDirectory(argv);
  if (recovery) return recoverSuccessfulRun(recovery);
  if (!argv.includes(REAL_EXECUTION_FLAG)) throw new Error("real_u3_html_execution_flag_required");
  if (env.BOWERBIRD_U1_ALLOW_NETWORK !== "1") throw new Error("BOWERBIRD_U1_ALLOW_NETWORK_required");
  const deepSeekKey = required(env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY");
  const arkKey = required(env.ARK_API_KEY, "ARK_API_KEY");
  const arkModel = required(env.ARK_VISION_MODEL, "ARK_VISION_MODEL");
  const runId = `run-u3-html-${randomUUID()}`;
  const outputDir = join(outputRoot(argv), runId);
  mkdirSync(outputDir, { recursive: true });
  const conversationId = `conversation-${randomUUID()}`;
  const leaseId = `lease-${randomUUID()}`;
  const profile = createU3VisualProfileFixture();
  const input = planningInput(profile);
  const plan = approvedPlan(profile);
  const planHash = sha256Hex(canonicalJson(plan));
  const skill = loadUnifiedAgentSkill();
  const checkpoint = {
    schemaVersion: 1,
    runId,
    conversationId,
    skillId: "bowerbird-unified-agent",
    skillVersion: "0.1.0",
    skillHash: skill.instructionHash,
    checkpointVersion: 1,
    phase: "compose_plan",
    compactedFacts: [],
    completedToolResults: [],
    input,
  };
  const checkpointText = canonicalJson(checkpoint);
  const checkpointBytes = new TextEncoder().encode(checkpointText);
  const checkpointHash = sha256Hex(checkpointText);
  const assets = fixtureAssets(runId, conversationId);
  const harness = createMemoryControl({
    runId,
    conversationId,
    leaseId,
    plan,
    planHash,
    checkpointBytes,
    assets,
    outputDir,
  });
  const renderer = await startRealLocalRenderer(env);
  const workspaceRoot = join(tmpdir(), `bowerbird-u3-html-${randomUUID()}`);
  const dshRuntimeRoot = join(workspaceRoot, "dsh-runtime");
  const startedAt = Date.now();

  const claimed = {
    run: {
      id: runId,
      conversationId,
      skillId: "bowerbird-unified-agent",
      skillVersion: "0.1.0",
      inputManifestHash: "a".repeat(64),
      approvedPlanHash: planHash,
      plannedToolCount: plan.steps.length,
      resultFeedbackAction: null,
      budgetCredits: 30,
      pricingVersion: 1,
      checkpointHash,
      snapshotSchemaVersion: 1,
    },
    lease: { leaseId, leaseSeconds: 300 },
    checkpointUrl: "memory://checkpoint",
    approvedPlan: {
      proposalHash: planHash,
      plannedToolCount: plan.steps.length,
      url: "https://u3-fixture.invalid/approved-plan.json",
    },
    artifactUrls: assets.map(({ bytesValue: _bytesValue, ...asset }) => asset),
  };
  const signal = { aborted: false, cancelRequested: false, leaseLost: false, stopRequested: false };
  const processor = new UnifiedPlanningRunProcessor({
    workspaceRoot,
    vision: {
      apiKey: arkKey,
      baseUrl: (env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, ""),
      model: arkModel,
      mock: false,
    },
    modelProxy: {
      upstream: {
        apiKey: deepSeekKey,
        baseUrl: (env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
        model: DSH_MODEL,
      },
    },
    createAdapter() {
      throw new Error("planning_adapter_must_not_run_after_approval");
    },
    htmlExecution: {
      renderConfig: { rendererUrl: renderer.url, internalToken: renderer.token },
      createAdapter(childEnvironment, providerEnvironment) {
        return new DshAcpHarnessAdapter({
          cwd: dshRuntimeRoot,
          createPort: () => NodeDshAcpPort.create({
            profileTemplateDir: PROFILE_TEMPLATE,
            runtimeRoot: dshRuntimeRoot,
            childEnvironment,
            providerEnvironment,
            parentEnvironment: env,
            timeoutMs: EXECUTION_TIMEOUT_MS,
            profileMode: "html-execution",
          }),
        });
      },
    },
  });

  try {
    await processor.process({ claimed, control: harness.control, signal });
    assert.equal(harness.state.parked, true);
    const completed = JSON.parse(new TextDecoder().decode(harness.state.currentCheckpoint)).completedToolResults;
    const chain = completed.filter((call) =>
      ["compose_html", "render_html", "inspect_artifact", "finalize_output"].includes(call.toolName));
    assert.deepEqual(chain.map((call) => call.toolName), [
      "compose_html",
      "render_html",
      "inspect_artifact",
      "finalize_output",
    ]);
    const ready = harness.state.events.findLast((event) => event.type === "result.ready");
    assert.ok(ready);
    const primary = harness.state.artifactById.get(ready.displayPayload.primaryArtifactId);
    assert.ok(primary?.filePath);
    const htmlArtifact = [...harness.state.artifacts.values()].find((artifact) => artifact.role === "html_document");
    const manifestArtifact = [...harness.state.artifacts.values()].find((artifact) => artifact.role === "render_manifest");
    const diagnostics = [...harness.state.artifacts.values()].filter((artifact) => artifact.role === "diagnostic");
    const usage = [...harness.state.usage.values()];
    const modelUsage = usage.filter((item) => item.kind === "model_tokens");
    const visionUsage = usage.filter((item) => item.kind === "vision_call");
    const renderUsage = usage.filter((item) => item.kind === "html_render");
    assert.ok(modelUsage.length >= 4 && modelUsage.length <= 8);
    assert.equal(visionUsage.length, 1);
    assert.equal(renderUsage.length, 1);

    const report = {
      ok: true,
      real: { dsh: true, deepSeek: true, renderer: true, arkVision: true },
      runId,
      proposalHash: planHash,
      toolChain: chain.map((call) => ({
        toolName: call.toolName,
        status: "succeeded",
        durationMs: (() => {
          const ledger = [...harness.state.calls.values()].find((item) => item.callId === call.callId);
          return ledger?.completedAt && ledger?.submittedAt ? ledger.completedAt - ledger.submittedAt : null;
        })(),
      })),
      timing: {
        totalMs: Date.now() - startedAt,
        rendererMs: ready.displayPayload.outputs ? JSON.parse(readFileSync(manifestArtifact.filePath, "utf8")).renderMs : null,
      },
      usage: {
        deepSeekTurns: modelUsage.length,
        deepSeekInputTokens: modelUsage.reduce((sum, item) => sum + item.inputUnits, 0),
        deepSeekOutputTokens: modelUsage.reduce((sum, item) => sum + item.outputUnits, 0),
        arkVisionCalls: visionUsage.length,
        htmlRenderCalls: renderUsage.length,
        actualCredits: actualCredits(harness.state.usage),
      },
      renderer: {
        fingerprint: ready.displayPayload.rendererFingerprint,
        chromiumVersion: renderer.chromiumVersion,
        executable: renderer.executablePath,
      },
      artifacts: {
        html: htmlArtifact.filePath,
        manifest: manifestArtifact.filePath,
        primary: primary.filePath,
        visible: ready.displayPayload.visibleArtifactIds.map((artifactId) => harness.state.artifactById.get(artifactId)?.filePath),
        privateDiagnostics: diagnostics.length,
      },
      checkpointSteps: harness.state.checkpointHistory.map((item) => ({ step: item.step, progress: item.progress })),
      secretsStayedInParent: { deepSeek: true, ark: true, rendererToken: true },
      deployed: false,
    };
    const reportPath = join(outputDir, "report.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { ...report, reportPath };
  } catch (error) {
    const safeErrorCode = error instanceof Error && /^[A-Za-z0-9 ._():-]{1,200}$/.test(error.message)
      ? error.message
      : "u3_product_html_execution_failed";
    const usage = [...harness.state.usage.values()];
    const failureReport = {
      ok: false,
      runId,
      proposalHash: planHash,
      safeErrorCode,
      elapsedMs: Date.now() - startedAt,
      calls: [...harness.state.calls.values()].map((call) => ({
        toolName: call.toolName,
        status: call.status,
        safeErrorCode: call.safeErrorCode ?? null,
      })),
      usage: {
        deepSeekTurns: usage.filter((item) => item.kind === "model_tokens").length,
        deepSeekInputTokens: usage.filter((item) => item.kind === "model_tokens").reduce((sum, item) => sum + item.inputUnits, 0),
        deepSeekOutputTokens: usage.filter((item) => item.kind === "model_tokens").reduce((sum, item) => sum + item.outputUnits, 0),
        arkVisionCalls: usage.filter((item) => item.kind === "vision_call").length,
        htmlRenderCalls: usage.filter((item) => item.kind === "html_render").length,
      },
      artifacts: [...harness.state.artifacts.values()].map((artifact) => ({
        role: artifact.role,
        userVisible: artifact.userVisible,
        filePath: artifact.filePath,
      })),
      checkpointSteps: harness.state.checkpointHistory.map((item) => ({ step: item.step, progress: item.progress })),
      deployed: false,
    };
    const failurePath = join(outputDir, "failure-report.json");
    writeFileSync(failurePath, `${JSON.stringify(failureReport, null, 2)}\n`, "utf8");
    throw new Error(`u3_product_html_execution_failed:${JSON.stringify({ ...failureReport, failurePath })}`);
  } finally {
    await renderer.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runU3ProductHtmlExecutionSmoke();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
