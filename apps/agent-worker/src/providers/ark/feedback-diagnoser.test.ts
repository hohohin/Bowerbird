import { createHash, randomUUID } from "node:crypto";
import { equal, ok } from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RunWorkspace } from "../../cloud-agent/run-workspace.ts";
import type { ControlledImageEditPlan } from "../../contracts/controlled-image-edit.ts";
import { AgentControlClient, type AgentWorkerFetch, type HttpResponse } from "../../control-plane/agent-control-client.ts";
import type { ControlledRunnerCheckpoint } from "../../kernel/controlled-image-edit-runner.ts";
import { hashIntentAnalysis } from "../../skills/bowerbird-controlled-image-edit/planner.ts";
import { createArkFeedbackDiagnoser } from "./feedback-diagnoser.ts";

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

test("feedback diagnosis is allowed only through a durable private diagnostic artifact and records vision usage", async () => {
  const binary = (globalThis as unknown as { atob(input: string): string }).atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  );
  const png = Uint8Array.from(binary, (char: string) => char.charCodeAt(0));
  const imageHash = createHash("sha256").update(png).digest("hex");
  let diagnosticByteLength = 0;
  const actions: string[] = [];
  let toolStatus = "prepared";
  const fetch: AgentWorkerFetch = async (url, request) => {
    if (url === "https://storage/final") {
      return { ...response(200), arrayBuffer: async () => png.buffer as ArrayBuffer };
    }
    if (url === "https://storage/diagnostic-upload" && request?.method === "PUT") {
      diagnosticByteLength = (request.body as Uint8Array).byteLength;
      return response(200);
    }
    const body = JSON.parse(String(request?.body ?? "{}")) as Record<string, unknown>;
    actions.push(String(body.action ?? "unknown"));
    if (body.action === "tool_prepare") {
      return response(200, JSON.stringify({ callId: body.callId, status: toolStatus, reused: false }));
    }
    if (body.action === "tool_submitted") {
      toolStatus = "submitted";
      return response(200, JSON.stringify({ callId: body.callId, status: toolStatus, reused: false }));
    }
    if (body.action === "artifact_prepare") {
      return response(200, JSON.stringify({
        uploadUrl: "https://storage/diagnostic-upload",
        objectKey: `runs/run-vision/artifacts/${body.sourceCallId}.json`,
      }));
    }
    if (body.action === "artifact") {
      return response(200, JSON.stringify({
        artifactId: "diagnostic-1",
        conversationId: "conversation-vision",
        runId: "run-vision",
        role: "diagnostic",
        stepId: body.stepId,
        mime: "application/json",
        bytes: diagnosticByteLength,
        sha256: body.sha256,
        userVisible: false,
        objectKey: `runs/run-vision/artifacts/${body.sourceCallId}.json`,
        url: "https://storage/diagnostic",
      }));
    }
    if (body.action === "tool_complete") toolStatus = "succeeded";
    return response(200, JSON.stringify({ callId: body.callId, status: toolStatus, reused: false }));
  };
  const control = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "worker" }, fetch);
  const root = join(tmpdir(), `bowerbird-feedback-${randomUUID()}`);
  let workspace: RunWorkspace | undefined;
  try {
    workspace = new RunWorkspace({
      root,
      runId: "run-vision",
      control,
      artifacts: [{
        artifactId: "final-1", conversationId: "conversation-vision", runId: "run-vision",
        role: "final_result", stepId: "generate-final", mime: "image/png", bytes: png.byteLength,
        sha256: imageHash, userVisible: true, url: "https://storage/final",
      }],
    });
    const analysis = {
      schemaVersion: 1 as const, intentSummary: "生成海报", mustPreserve: [], mustTransfer: [], mustExclude: [],
      mayChange: [], highConsistencySignals: [], assumptions: [],
    };
    const plan: ControlledImageEditPlan = {
      schemaVersion: 1,
      intentAnalysisHash: hashIntentAnalysis(analysis),
      intentSummary: "生成海报",
      strategy: "direct",
      referenceRoles: [],
      assumptions: [],
      steps: [{
        id: "generate-final", kind: "direct_generate", goal: "生成海报", inputs: [], modifies: ["画面"],
        preserves: [], excludes: [], outputRole: "final_result", rationale: "单步足够",
        estimatedUsage: { generateCalls: 1, understandCalls: 0 },
      }],
    };
    const checkpoint = {
      schemaVersion: 1, runId: "run-vision", conversationId: "conversation-vision",
      skillId: "bowerbird-controlled-image-edit", skillVersion: "0.1.0", skillHash: "a".repeat(64),
      status: "running", phase: "diagnose_feedback", revisionIndex: 0,
      input: { schemaVersion: 1, intentPrompt: "生成海报", references: [] },
      proposedPlan: plan, plannedToolCount: 1, stepCursor: 1,
      artifacts: [{
        artifactId: "final-1", conversationId: "conversation-vision", runId: "run-vision", role: "final_result",
        stepId: "generate-final", mime: "image/png", bytes: png.byteLength, sha256: imageHash, userVisible: true,
      }],
      feedback: "背景太深", understandCallCount: 0,
    } as ControlledRunnerCheckpoint;
    const diagnoser = createArkFeedbackDiagnoser({
      runId: "run-vision", leaseId: "lease-vision", control, workspace,
      config: { apiKey: "test", baseUrl: "https://ark", model: "vision-model", mock: true },
      signal: { aborted: false, cancelRequested: false, leaseLost: false, stopRequested: false },
      fetch,
    });
    const diagnosis = await diagnoser.diagnose({ checkpoint, feedback: "背景太深" });
    equal(diagnosis.earliestFailedStepId, "generate-final");
    ok(diagnosticByteLength > 0);
    equal(actions.filter((action) => action === "usage").length, 1);
    equal(actions.filter((action) => action === "tool_complete").length, 1);
  } finally {
    workspace?.cleanup();
  }
});
