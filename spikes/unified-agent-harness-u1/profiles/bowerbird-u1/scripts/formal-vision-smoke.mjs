import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { UnifiedPlanningRunProcessor } from "../../../../../apps/agent-worker/src/cloud-agent/unified-planning-run-processor.ts";
import { AgentControlError } from "../../../../../apps/agent-worker/src/control-plane/agent-control-client.ts";
import { DshAcpHarnessAdapter } from "../../../../../apps/agent-worker/src/harness/dsh-acp-harness-adapter.ts";
import { NodeDshAcpPort } from "../../../../../apps/agent-worker/src/harness/node-dsh-acp-port.ts";

const REAL_VISION_FLAG = "--allow-real-vision";
const FIXTURE_PATH = join(import.meta.dirname, "../../../../../apps/extension/icons/128x128.png");
const PROFILE_TEMPLATE = join(import.meta.dirname, "..");
const DSH_MODEL = "deepseek-v4-flash";

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name}_missing`);
  return normalized;
}

function createControl({ runId, conversationId, image }) {
  const calls = new Map();
  const artifacts = new Map();
  const usageByCall = new Map();
  const state = {
    checkpointSaved: false,
    modelUsage: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    modelDiagnostics: 0,
    visionUsage: 0,
    diagnosticSaved: false,
    observationShapeValid: false,
    approvalSaved: false,
  };

  return {
    state,
    control: {
      async loadRawCheckpoint() { return null; },
      async downloadVerifiedJson(url) {
        if (url !== "memory://input") throw new Error("unexpected_json_download");
        return {
          schemaVersion: 1,
          goal: "必须先列出当前素材，再调用 understand_asset 以 general 重点观察 asset-product；收到视觉事实后，提交一个只使用 asset-product 且以 finalize_output 结束的最小计划。",
        };
      },
      async downloadVerifiedBytes(url) {
        if (url === "memory://asset-product") return image;
        const stored = artifacts.get(url.replace("memory://", ""));
        if (!stored) throw new Error("unexpected_asset_download");
        return Uint8Array.from(stored.bytes);
      },
      async saveRawCheckpoint(args) {
        assert.equal(args.runId, runId);
        state.checkpointSaved = true;
        return { checkpointHash: args.sha256, objectKey: "memory/checkpoint.json" };
      },
      async appendEvents() {},
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
          status: "prepared",
          reused: false,
        };
        calls.set(args.callId, created);
        return created;
      },
      async markToolSubmitted(args) {
        const existing = calls.get(args.callId);
        assert.ok(existing);
        const updated = { ...existing, status: "submitted" };
        calls.set(args.callId, updated);
        return updated;
      },
      async completeTool(args) {
        const existing = calls.get(args.callId);
        assert.ok(existing);
        const updated = { ...existing, ...args };
        calls.set(args.callId, updated);
        return updated;
      },
      async uploadDiagnostic(args) {
        const parsed = JSON.parse(new TextDecoder().decode(args.bytes));
        if (args.stepId === "model-compose_plan") {
          assert.equal(parsed.schemaVersion, 2);
          assert.equal(parsed.status, 200);
          assert.equal(parsed.bodyEncoding, "gzip+base64");
          assert.ok(Number.isSafeInteger(parsed.bodyBytes) && parsed.bodyBytes > 0);
          assert.match(parsed.bodySha256, /^[0-9a-f]{64}$/);
          assert.ok(typeof parsed.bodyGzipBase64 === "string" && parsed.bodyGzipBase64.length > 0);
          const bodyBytes = gunzipSync(Buffer.from(parsed.bodyGzipBase64, "base64"), { maxOutputLength: 512 * 1024 });
          assert.equal(bodyBytes.byteLength, parsed.bodyBytes);
          assert.equal(createHash("sha256").update(bodyBytes).digest("hex"), parsed.bodySha256);
          assert.ok(new TextDecoder("utf8", { fatal: true }).decode(bodyBytes).includes("data: [DONE]"));
          assert.ok(Number.isSafeInteger(parsed.usage?.inputUnits) && parsed.usage.inputUnits >= 0);
          assert.ok(Number.isSafeInteger(parsed.usage?.outputUnits) && parsed.usage.outputUnits >= 0);
          const artifact = {
            artifactId: `diagnostic-model-${args.sourceCallId}`,
            conversationId,
            runId,
            role: "diagnostic",
            stepId: args.stepId,
            mime: "application/json",
            bytes: args.bytes.byteLength,
            sha256: args.sha256,
            userVisible: false,
            objectKey: `memory/diagnostic-model-${args.sourceCallId}.json`,
            url: `memory://${args.sourceCallId}`,
          };
          artifacts.set(args.sourceCallId, { artifact, bytes: Uint8Array.from(args.bytes) });
          state.modelDiagnostics += 1;
          return artifact;
        }
        assert.equal(parsed.schemaVersion, 1);
        assert.equal(parsed.assetId, "asset-product");
        assert.ok(typeof parsed.summary === "string" && parsed.summary.length > 0);
        assert.ok(Array.isArray(parsed.observations) && parsed.observations.length > 0);
        state.observationShapeValid = parsed.observations.every((item) =>
          item && typeof item.category === "string" && typeof item.detail === "string" && item.detail.length > 0
        );
        state.diagnosticSaved = true;
        return {
          artifactId: "diagnostic-vision-1",
          conversationId,
          runId,
          role: "diagnostic",
          stepId: args.stepId,
          mime: "application/json",
          bytes: args.bytes.byteLength,
          sha256: args.sha256,
          userVisible: false,
          objectKey: "memory/diagnostic-vision-1.json",
        };
      },
      async recordUsage(args) {
        const usageKey = `${args.kind}:${args.callId}`;
        const normalizedUsage = {
          provider: args.provider,
          model: args.model,
          inputUnits: args.inputUnits,
          outputUnits: args.outputUnits,
          imageCount: args.imageCount,
        };
        const existingUsage = usageByCall.get(usageKey);
        if (existingUsage) {
          assert.deepEqual(existingUsage, normalizedUsage);
          return;
        }
        usageByCall.set(usageKey, normalizedUsage);
        if (args.kind === "model_tokens") {
          assert.equal(args.provider, "deepseek");
          assert.ok(Number.isSafeInteger(args.inputUnits) && args.inputUnits >= 0);
          assert.ok(Number.isSafeInteger(args.outputUnits) && args.outputUnits >= 0);
          state.modelUsage += 1;
          state.modelInputTokens += args.inputUnits;
          state.modelOutputTokens += args.outputUnits;
        } else {
          assert.equal(args.kind, "vision_call");
          assert.equal(args.provider, "ark");
          state.visionUsage += 1;
        }
      },
      async requestUnifiedPlanApproval(args) {
        assert.equal(state.visionUsage, 1);
        assert.ok(state.modelUsage >= 2);
        assert.equal(state.diagnosticSaved, true);
        assert.equal(args.runId, runId);
        assert.match(args.callId, /^[0-9a-f]{64}$/);
        assert.match(args.proposalHash, /^[0-9a-f]{64}$/);
        state.approvalSaved = true;
        return {
          status: "awaiting_approval",
          proposalHash: args.proposalHash,
          estimatedAdditionalCredits: 2,
          reused: false,
        };
      },
      async getArtifactByCall(_runId, _leaseId, callId) {
        const stored = artifacts.get(callId);
        if (!stored) throw new AgentControlError(409);
        return stored.artifact;
      },
    },
    succeededCalls() {
      return [...calls.values()].filter((call) => call.status === "succeeded").length;
    },
    failedCalls() {
      return [...calls.values()]
        .filter((call) => call.status === "failed" || call.status === "outcome_unknown")
        .map((call) => ({
          toolName: call.toolName,
          status: call.status,
          safeErrorCode: call.safeErrorCode || "unclassified",
        }));
    },
  };
}

export async function runFormalVisionSmoke() {
  if (!process.argv.includes(REAL_VISION_FLAG)) throw new Error("real_vision_flag_required");
  process.env.BOWERBIRD_U1_ALLOW_NETWORK = "1";

  const deepSeekKey = required(process.env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY");
  const arkKey = required(process.env.ARK_API_KEY, "ARK_API_KEY");
  const arkModel = required(process.env.ARK_VISION_MODEL, "ARK_VISION_MODEL");

  const image = new Uint8Array(readFileSync(FIXTURE_PATH));
  const imageHash = createHash("sha256").update(image).digest("hex");
  const runId = `run-vision-${randomUUID()}`;
  const conversationId = `conversation-${randomUUID()}`;
  const leaseId = `lease-${randomUUID()}`;
  const workspaceRoot = mkdtempSync(join(tmpdir(), "bowerbird-u2-vision-"));
  const dshRuntimeRoot = join(workspaceRoot, "dsh-runtime");
  const harness = createControl({ runId, conversationId, image });

  const claimed = {
    run: {
      id: runId,
      conversationId,
      skillId: "bowerbird-unified-agent",
      skillVersion: "0.1.0",
      inputManifestHash: "a".repeat(64),
      approvedPlanHash: null,
      plannedToolCount: null,
      resultFeedbackAction: null,
      budgetCredits: 30,
      pricingVersion: 1,
      checkpointHash: null,
      snapshotSchemaVersion: null,
    },
    lease: { leaseId, leaseSeconds: 120 },
    inputUrl: "memory://input",
    artifactUrls: [{
      artifactId: "asset-product",
      conversationId,
      runId,
      role: "input",
      mime: "image/png",
      bytes: image.byteLength,
      sha256: imageHash,
      width: 128,
      height: 128,
      userVisible: true,
      url: "memory://asset-product",
    }],
  };
  const signal = { aborted: false, cancelRequested: false, leaseLost: false, stopRequested: false };
  const processor = new UnifiedPlanningRunProcessor({
    workspaceRoot,
    vision: {
      apiKey: arkKey,
      baseUrl: (process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, ""),
      model: arkModel,
      mock: false,
    },
    modelProxy: {
      upstream: {
        apiKey: deepSeekKey,
        baseUrl: (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
        model: DSH_MODEL,
      },
    },
    createAdapter(toolBridge, providerEnvironment) {
      if (!providerEnvironment) throw new Error("model_proxy_environment_missing");
      return new DshAcpHarnessAdapter({
        cwd: dshRuntimeRoot,
        createPort: () => NodeDshAcpPort.create({
          profileTemplateDir: PROFILE_TEMPLATE,
          runtimeRoot: dshRuntimeRoot,
          childEnvironment: toolBridge,
          providerEnvironment,
          parentEnvironment: process.env,
        }),
      });
    },
  });

  try {
    await processor.process({ claimed, control: harness.control, signal });
    assert.deepEqual(harness.state, {
      checkpointSaved: true,
      modelUsage: 3,
      modelInputTokens: harness.state.modelInputTokens,
      modelOutputTokens: harness.state.modelOutputTokens,
      modelDiagnostics: 3,
      visionUsage: 1,
      diagnosticSaved: true,
      observationShapeValid: true,
      approvalSaved: true,
    });
    assert.ok(harness.state.modelInputTokens > 0);
    assert.ok(harness.state.modelOutputTokens > 0);
    assert.equal(harness.succeededCalls(), 4);
    return {
      ok: true,
      dshReal: true,
      arkVisionReal: true,
      ...harness.state,
      durableSucceededCalls: harness.succeededCalls(),
      deepSeekUsageMetered: true,
      deepSeekSecretStayedInParent: true,
      arkSecretStayedInParent: true,
      deployed: false,
    };
  } catch {
    const failures = harness.failedCalls();
    const summary = {
      failures: failures.length > 0 ? failures : [{
        toolName: "unclassified",
        status: "failed",
        safeErrorCode: "formal_vision_smoke_unclassified",
      }],
      state: harness.state,
      durableSucceededCalls: harness.succeededCalls(),
    };
    throw new Error(`formal_vision_smoke_failed:${JSON.stringify(summary)}`);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runFormalVisionSmoke();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
