import { createHash } from "node:crypto";
import { equal, ok } from "node:assert/strict";
import { test } from "node:test";

import type { ControlledImageEditPlan, IntentAnalysis } from "../contracts/controlled-image-edit.ts";
import { AgentControlClient, type AgentWorkerFetch, type HttpResponse } from "../control-plane/agent-control-client.ts";
import { FakeModel } from "../fakes/fake-model.ts";
import { hashIntentAnalysis } from "../skills/bowerbird-controlled-image-edit/planner.ts";
import { ControlledImageEditRunProcessor } from "./controlled-run-processor.ts";

function response(status: number, body = "{}"): HttpResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
  };
}

test("remote processor downloads verified text input, checkpoints, then releases for approval", async () => {
  const input = JSON.stringify({ schemaVersion: 1, intentPrompt: "生成极简蓝色海报", references: [] });
  const intent: IntentAnalysis = {
    schemaVersion: 1,
    intentSummary: "生成极简蓝色海报",
    mustPreserve: [],
    mustTransfer: [],
    mustExclude: [],
    mayChange: [],
    highConsistencySignals: [],
    assumptions: [],
  };
  const plan: ControlledImageEditPlan = {
    schemaVersion: 1,
    intentAnalysisHash: hashIntentAnalysis(intent),
    intentSummary: intent.intentSummary,
    strategy: "direct",
    referenceRoles: [],
    assumptions: [],
    steps: [{
      id: "generate-final",
      kind: "direct_generate",
      goal: "生成最终海报",
      inputs: [],
      modifies: ["画面"],
      preserves: [],
      excludes: [],
      outputRole: "final_result",
      rationale: "无需控制参考",
      estimatedUsage: { generateCalls: 1, understandCalls: 0 },
    }],
  };
  const actions: string[] = [];
  const fetch: AgentWorkerFetch = async (url, request) => {
    if (url === "https://storage/input") {
      actions.push("input_download");
      return response(200, input);
    }
    if (request?.method === "PUT") {
      actions.push("checkpoint_upload");
      return response(200);
    }
    const body = JSON.parse(String(request?.body ?? "{}")) as { action?: string; checkpointHash?: string };
    actions.push(body.action ?? "unknown");
    if (body.action === "checkpoint_prepare") {
      return response(200, JSON.stringify({
        uploadUrl: `https://storage/${body.checkpointHash}`,
        objectKey: `runs/run-1/checkpoints/${body.checkpointHash}.json`,
      }));
    }
    return response(200);
  };
  const model = new FakeModel([
    { kind: "action", action: "record_intent_analysis", arguments: { analysis: intent }, providerUsage: {} },
    { kind: "action", action: "submit_plan_for_approval", arguments: { plan }, providerUsage: {} },
  ]);
  const processor = new ControlledImageEditRunProcessor(model, () => ({
    generate: async () => { throw new Error("generation_before_approval"); },
  }));
  const control = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "worker-1" }, fetch);
  await processor.process({
    claimed: {
      run: {
        id: "run-1",
        conversationId: "conversation-1",
        skillId: "bowerbird-controlled-image-edit",
        skillVersion: "0.1.2",
        inputManifestHash: createHash("sha256").update(input).digest("hex"),
        approvedPlanHash: null,
        plannedToolCount: null,
        resultFeedbackAction: null,
        budgetCredits: 48,
        pricingVersion: 1,
        checkpointHash: null,
        snapshotSchemaVersion: null,
      },
      lease: { leaseId: "lease-1", leaseSeconds: 60 },
      inputUrl: "https://storage/input",
    },
    control,
    signal: { aborted: false, cancelRequested: false, leaseLost: false, stopRequested: false },
  });
  equal(model.remaining(), 0);
  equal(actions.filter((item) => item === "checkpoint_commit").length, 2);
  equal(actions.filter((item) => item === "events").length, 2);
  equal(actions.at(-1), "approval_request");
  ok(actions.indexOf("checkpoint_upload") < actions.indexOf("checkpoint_commit"));
});

test("processor binds input artifact metadata but never downloads image bytes before plan approval", async () => {
  const referenceSha = "b".repeat(64);
  const inputValue = {
    schemaVersion: 1 as const,
    intentPrompt: "以 @图1 为底图，只替换背景",
    references: [{ referenceId: "ref-1", token: "@图1", ordinal: 1, mime: "image/png", bytes: 128, sha256: referenceSha }],
  };
  const input = JSON.stringify(inputValue);
  const intent: IntentAnalysis = {
    schemaVersion: 1,
    intentSummary: "保持图1主体，只替换背景",
    finalSubjectReferenceId: "ref-1",
    mustPreserve: ["主体"],
    mustTransfer: [],
    mustExclude: [],
    mayChange: ["背景"],
    highConsistencySignals: ["identity"],
    assumptions: [],
  };
  const plan: ControlledImageEditPlan = {
    schemaVersion: 1,
    intentAnalysisHash: hashIntentAnalysis(intent),
    intentSummary: intent.intentSummary,
    strategy: "controlled",
    referenceRoles: [{ referenceId: "ref-1", role: "base", mustPreserve: ["主体"], mustTransfer: [], mustExclude: [] }],
    assumptions: [],
    steps: [{
      id: "edit-background", kind: "direct_generate", goal: "替换背景",
      inputs: [{ type: "reference", referenceId: "ref-1" }], modifies: ["背景"], preserves: ["主体"], excludes: [],
      outputRole: "final_result", rationale: "单一局部修改，无需额外控制参考",
      estimatedUsage: { generateCalls: 1, understandCalls: 0 },
    }],
  };
  let imageDownloads = 0;
  const fetch: AgentWorkerFetch = async (url, request) => {
    if (url === "https://storage/input") return response(200, input);
    if (url === "https://storage/reference") {
      imageDownloads++;
      return response(200, "image-bytes-must-not-be-read");
    }
    if (request?.method === "PUT") return response(200);
    const body = JSON.parse(String(request?.body ?? "{}")) as { action?: string; checkpointHash?: string };
    if (body.action === "checkpoint_prepare") {
      return response(200, JSON.stringify({ uploadUrl: `https://storage/${body.checkpointHash}`, objectKey: `runs/run-2/checkpoints/${body.checkpointHash}.json` }));
    }
    return response(200);
  };
  const processor = new ControlledImageEditRunProcessor(new FakeModel([
    { kind: "action", action: "record_intent_analysis", arguments: { analysis: intent }, providerUsage: {} },
    { kind: "action", action: "submit_plan_for_approval", arguments: { plan }, providerUsage: {} },
  ]), () => ({ generate: async () => { throw new Error("generation_before_approval"); } }));
  const control = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "worker-1" }, fetch);
  await processor.process({
    claimed: {
      run: {
        id: "run-2", conversationId: "conversation-2", skillId: "bowerbird-controlled-image-edit", skillVersion: "0.1.2",
        inputManifestHash: createHash("sha256").update(input).digest("hex"), approvedPlanHash: null,
        plannedToolCount: null, resultFeedbackAction: null, budgetCredits: 48, pricingVersion: 1,
        checkpointHash: null, snapshotSchemaVersion: null,
      },
      lease: { leaseId: "lease-2", leaseSeconds: 60 },
      inputUrl: "https://storage/input",
      artifactUrls: [{
        artifactId: "artifact-input-1", conversationId: "conversation-2", runId: "run-2", role: "input",
        stepId: "ref-1", mime: "image/png", bytes: 128, sha256: referenceSha, userVisible: true,
        url: "https://storage/reference",
      }],
    },
    control,
    signal: { aborted: false, cancelRequested: false, leaseLost: false, stopRequested: false },
  });
  equal(imageDownloads, 0);
});
