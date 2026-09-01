import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { AgentControlError } from "../../../../../apps/agent-worker/src/control-plane/agent-control-client.ts";
import { createHtmlRenderExecutor } from "../../../../../apps/agent-worker/src/providers/renderer/html-render-executor.ts";
import {
  createApprovedComposeHtmlToolDefinition,
  createApprovedRenderHtmlToolDefinition,
} from "../../../../../apps/agent-worker/src/harness/approved-html-tools.ts";
import { createApprovedFinalizeOutputToolDefinition } from "../../../../../apps/agent-worker/src/harness/approved-finalize-output-tool.ts";
import { createApprovedInspectArtifactToolDefinition } from "../../../../../apps/agent-worker/src/harness/understand-asset-tool.ts";
import { DshAcpHarnessAdapter } from "../../../../../apps/agent-worker/src/harness/dsh-acp-harness-adapter.ts";
import { UnifiedHtmlExecutionHarnessRunner } from "../../../../../apps/agent-worker/src/harness/unified-html-execution-harness-runner.ts";
import { UnifiedHtmlExecutionToolBridge } from "../../../../../apps/agent-worker/src/harness/unified-html-execution-tool-bridge.ts";
import { canonicalJson, sha256Hex } from "../../../../../apps/agent-worker/src/kernel/tool-ledger.ts";
import { NodeDshAcpPort } from "../scripts/dsh-acp-port.mjs";
import { spikeRoot } from "../scripts/runtime.mjs";

const HTML_EXECUTION_PATCH = "profiles/bowerbird-u1/cordis.html-execution.patch.yml";
const RUN_ID = "run-real-dsh-html";
const LEASE_ID = "lease-real-dsh-html";
const RESOURCE_ID = "asset-product";
const HTML = "<!doctype html><html><body><main><img src=\"asset:reference-1\"><h1>产品长图</h1></main></body></html>";
const ONE_PIXEL_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const ONE_PIXEL_PNG = Uint8Array.from(Buffer.from(ONE_PIXEL_PNG_B64, "base64"));

function toolCallSse(name, argumentsValue, sequence) {
  const event = {
    id: `fixture-${sequence}`,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: `fixture-call-${sequence}`,
          type: "function",
          function: { name, arguments: JSON.stringify(argumentsValue) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 12,
    },
  };
  return `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
}

async function startFakeDeepSeek() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const sequence = requests.length;
    const payload = sequence === 1
      ? toolCallSse("compose_html", { schemaVersion: 1, html: HTML, resourceArtifactIds: [RESOURCE_ID] }, sequence)
      : sequence === 2
        ? toolCallSse("render_html", {}, sequence)
        : sequence === 3
          ? toolCallSse("inspect_artifact", {}, sequence)
          : toolCallSse("finalize_output", {}, sequence);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.end(payload);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startFakeRenderer(internalToken) {
  const requests = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/render");
    assert.equal(request.headers.authorization, `Bearer ${internalToken}`);
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const pngSha256 = sha256Hex(ONE_PIXEL_PNG);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      schemaVersion: 1,
      rendererFingerprint: "bwr1-real-dsh-fixture",
      runId: parsed.runId,
      callId: parsed.callId,
      argsHash: parsed.argsHash,
      sourceHtmlSha256: sha256Hex(parsed.html),
      document: {
        widthCssPx: parsed.viewport.widthCssPx,
        heightCssPx: 1,
        widthDevicePx: 1,
        heightDevicePx: 1,
      },
      renderMs: 7,
      outputs: [{
        role: "full_page_screenshot",
        clipDevicePx: { x: 0, y: 0, width: 1, height: 1 },
        mime: "image/png",
        widthDevicePx: 1,
        heightDevicePx: 1,
        bytes: ONE_PIXEL_PNG.byteLength,
        sha256: pngSha256,
        dataBase64: ONE_PIXEL_PNG_B64,
      }],
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function createMemoryControl() {
  const calls = new Map();
  const artifacts = new Map();
  const bytesByUrl = new Map();
  const usage = [];
  let artifactSequence = 0;
  const artifactKey = (callId, outputName = "default") => `${callId}:${outputName}`;
  return {
    calls,
    artifacts,
    bytesByUrl,
    usage,
    async prepareTool(args) {
      const existing = calls.get(args.callId);
      if (existing) {
        if (existing.argsHash !== args.argsHash) throw new Error("call_id_args_hash_conflict");
        return { ...existing, reused: true };
      }
      const created = { callId: args.callId, status: "prepared", reused: false, argsHash: args.argsHash };
      calls.set(args.callId, created);
      return created;
    },
    async markToolSubmitted(args) {
      const current = calls.get(args.callId);
      assert.ok(current);
      const next = { ...current, status: "submitted" };
      calls.set(args.callId, next);
      return next;
    },
    async completeTool(args) {
      const current = calls.get(args.callId);
      assert.ok(current);
      const next = {
        ...current,
        status: args.status,
        resultObjectKey: args.resultObjectKey,
        resultHash: args.resultHash,
        safeErrorCode: args.safeErrorCode,
      };
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
      const objectKey = `runs/${args.runId}/${args.sourceCallId}-${args.outputName ?? "default"}`;
      const url = `memory://${objectKey}`;
      const artifact = {
        artifactId: `artifact-${++artifactSequence}`,
        conversationId: "conversation-real-dsh-html",
        runId: args.runId,
        role: args.role,
        stepId: args.stepId,
        parentArtifactId: args.parentArtifactId ?? null,
        mime: args.mime,
        bytes: args.bytes.byteLength,
        sha256: args.sha256,
        userVisible: args.userVisible ?? true,
        url,
        objectKey,
      };
      artifacts.set(key, artifact);
      bytesByUrl.set(url, args.bytes);
      return artifact;
    },
    async uploadDiagnostic(args) {
      return await this.uploadArtifact({
        ...args,
        role: "diagnostic",
        mime: "application/json",
        userVisible: false,
      });
    },
    async getArtifactByCall(_runId, _leaseId, callId, outputName) {
      const artifact = artifacts.get(artifactKey(callId, outputName));
      if (!artifact) throw new AgentControlError(409);
      return artifact;
    },
    async recordUsage(args) {
      usage.push(args);
    },
    async downloadVerifiedBytes(url, expected) {
      const bytes = bytesByUrl.get(url);
      if (!bytes || bytes.byteLength !== expected.bytes || sha256Hex(bytes) !== expected.sha256) {
        throw new Error("fixture_artifact_verification_failed");
      }
      return bytes;
    },
    async downloadVerifiedJson(url, expectedSha256) {
      const bytes = bytesByUrl.get(url);
      if (!bytes || sha256Hex(bytes) !== expectedSha256) throw new Error("fixture_json_verification_failed");
      return JSON.parse(new TextDecoder().decode(bytes));
    },
  };
}

test("real pinned DSH executes approved HTML, Ark inspection, and parent finalization exactly once", async () => {
  const approvedPlan = {
    schemaVersion: 1,
    title: "产品长图执行计划",
    summary: "使用当前产品素材排版并渲染。",
    steps: [
      { id: "compose", kind: "compose_html", goal: "排版", inputAssetIds: [RESOURCE_ID], dependsOn: [] },
      { id: "render", kind: "render_html", goal: "渲染", inputAssetIds: [RESOURCE_ID], dependsOn: ["compose"] },
      { id: "inspect", kind: "inspect_artifact", goal: "检查整页布局与文字可读性", inputAssetIds: [], dependsOn: ["render"] },
      { id: "finalize", kind: "finalize_output", goal: "提交", inputAssetIds: [], dependsOn: ["inspect"] },
    ],
  };
  const approvedPlanHash = sha256Hex(canonicalJson(approvedPlan));
  const control = createMemoryControl();
  const htmlDocuments = new Map();
  const remoteArtifacts = new Map();
  const workspace = {
    rememberHtmlDocument(artifact, html) { htmlDocuments.set(artifact.artifactId, html); },
    rememberRemoteArtifact(artifact) { remoteArtifacts.set(artifact.artifactId, artifact); },
    async readHtmlDocumentArtifact(artifactId) {
      const html = htmlDocuments.get(artifactId);
      if (!html) throw new Error("html_document_missing");
      return html;
    },
    async readArtifact(artifactId) {
      if (artifactId === RESOURCE_ID) {
        return { mime: "image/png", bytes: ONE_PIXEL_PNG, sha256: sha256Hex(ONE_PIXEL_PNG) };
      }
      const artifact = remoteArtifacts.get(artifactId);
      const bytes = artifact?.url ? control.bytesByUrl.get(artifact.url) : undefined;
      if (!artifact || !bytes) throw new Error("resource_missing");
      return { mime: artifact.mime, bytes, sha256: artifact.sha256 };
    },
  };
  const internalToken = "fixture-renderer-token-0123456789";
  const modelServer = await startFakeDeepSeek();
  const rendererServer = await startFakeRenderer(internalToken);
  const renderExecutor = createHtmlRenderExecutor({
    runId: RUN_ID,
    leaseId: LEASE_ID,
    control,
    workspace,
    config: { rendererUrl: rendererServer.url, internalToken },
  });
  const bridge = new UnifiedHtmlExecutionToolBridge({
    runId: RUN_ID,
    leaseId: LEASE_ID,
    approvedPlanHash,
    composeSlot: 0,
    renderSlot: 1,
    inspectSlot: 2,
    finalizeSlot: 3,
    composeDefinition: createApprovedComposeHtmlToolDefinition({
      runId: RUN_ID,
      leaseId: LEASE_ID,
      approvedPlanHash,
      step: approvedPlan.steps[0],
      resourceArtifactIds: [RESOURCE_ID],
      control,
      workspace,
    }),
    createRenderDefinition: (document) => createApprovedRenderHtmlToolDefinition({
      runId: RUN_ID,
      leaseId: LEASE_ID,
      approvedPlanHash,
      step: approvedPlan.steps[1],
      input: {
        schemaVersion: 1,
        htmlArtifactId: document.artifactId,
        resourceArtifactIds: [RESOURCE_ID],
        viewport: { widthCssPx: 900, heightCssPx: 700, deviceScaleFactor: 1 },
        capture: { mode: "full_page_and_slices", sliceHeightCssPx: 900, overlapCssPx: 0 },
        background: "opaque",
      },
      executor: renderExecutor,
    }),
    createInspectDefinition: (render) => createApprovedInspectArtifactToolDefinition({
      runId: RUN_ID,
      leaseId: LEASE_ID,
      approvedPlanHash,
      step: approvedPlan.steps[2],
      artifact: {
        artifactId: render.outputs[0].artifactId,
        sha256: render.outputs[0].sha256,
      },
      control,
      workspace,
      config: { apiKey: "unused", baseUrl: "https://ark.invalid", model: "ark-vision-fixture", mock: true },
      signal: { aborted: false, cancelRequested: false, leaseLost: false, stopRequested: false },
    }),
    createFinalizeDefinition: (render) => createApprovedFinalizeOutputToolDefinition({
      runId: RUN_ID,
      leaseId: LEASE_ID,
      approvedPlanHash,
      step: approvedPlan.steps[3],
      output: {
        schemaVersion: 1,
        primaryArtifactId: render.outputs[0].artifactId,
        visibleArtifactIds: render.outputs.map((output) => output.artifactId),
      },
    }),
  });
  const previous = {
    allow: process.env.BOWERBIRD_U1_ALLOW_NETWORK,
    key: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
  };
  process.env.BOWERBIRD_U1_ALLOW_NETWORK = "1";
  process.env.DEEPSEEK_API_KEY = "fixture-only-deepseek-key";
  process.env.DEEPSEEK_BASE_URL = modelServer.baseUrl;

  try {
    const runner = new UnifiedHtmlExecutionHarnessRunner(bridge, (childEnvironment, providerEnvironment) => {
      assert.equal(providerEnvironment.DEEPSEEK_BASE_URL, modelServer.baseUrl);
      return new DshAcpHarnessAdapter({
        cwd: spikeRoot,
        createPort: () => new NodeDshAcpPort({
          allowNetwork: true,
          patches: [HTML_EXECUTION_PATCH],
          toolBridge: childEnvironment,
        }),
      });
    });
    const result = await runner.run({
      schemaVersion: 1,
      runId: RUN_ID,
      checkpointVersion: 1,
      phase: "execute_approved_plan",
      approvedPlanHash,
      compactedFacts: [],
      completedToolResults: [],
    }, [{ type: "text", text: "执行已批准的 HTML 计划。" }], {
      DEEPSEEK_API_KEY: "fixture-only-deepseek-key",
      DEEPSEEK_BASE_URL: modelServer.baseUrl,
    });

    assert.equal(result.stopReason, "end_turn");
    assert.equal(modelServer.requests.length, 4);
    assert.deepEqual(
      modelServer.requests[0].tools.map((tool) => tool.function.name).sort(),
      ["compose_html", "finalize_output", "inspect_artifact", "render_html"],
    );
    assert.ok(modelServer.requests[1].messages.some(
      (message) => message.role === "tool" && message.content.includes("artifact-1"),
    ));
    assert.equal(rendererServer.requests.length, 1);
    assert.equal(rendererServer.requests[0].html, HTML);
    assert.equal(rendererServer.requests[0].resources[0].key, "reference-1");
    assert.equal(rendererServer.requests[0].viewport.widthCssPx, 900);
    assert.equal(bridge.completedCalls.length, 4);
    assert.deepEqual(
      bridge.completedCalls.map((call) => call.toolName),
      ["compose_html", "render_html", "inspect_artifact", "finalize_output"],
    );
    assert.equal(bridge.inspectionResult.assetId, bridge.renderResult.outputs[0].artifactId);
    assert.equal(bridge.finalResult.primaryArtifactId, bridge.renderResult.outputs[0].artifactId);
    assert.equal(bridge.renderResult.rendererFingerprint, "bwr1-real-dsh-fixture");
    assert.equal(bridge.renderResult.outputs[0].role, "full_page_screenshot");
    assert.deepEqual(control.usage.map((entry) => entry.kind), ["html_render", "vision_call"]);
    assert.equal([...control.calls.values()].every((call) => call.status === "succeeded"), true);
    assert.equal([...control.artifacts.values()].filter((artifact) => artifact.role === "html_document").length, 1);
    assert.equal([...control.artifacts.values()].filter((artifact) => artifact.role === "render_manifest").length, 1);
    assert.equal([...control.artifacts.values()].filter((artifact) => artifact.role === "diagnostic").length, 1);
  } finally {
    await modelServer.close();
    await rendererServer.close();
    if (previous.allow === undefined) delete process.env.BOWERBIRD_U1_ALLOW_NETWORK;
    else process.env.BOWERBIRD_U1_ALLOW_NETWORK = previous.allow;
    if (previous.key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous.key;
    if (previous.baseUrl === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = previous.baseUrl;
  }
});
