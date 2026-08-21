import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";

import { AgentControlClient, type AgentWorkerFetch, type HttpResponse } from "../../control-plane/agent-control-client.ts";
import { DurableProviderError } from "../../kernel/durable-tool-dispatcher.ts";
import {
  createLocalApprovedStepExecutor,
  LocalTaskPendingError,
} from "./local-approved-step-executor.ts";
import type { GenerateApprovedStepRequest } from "../../kernel/controlled-image-edit-runner.ts";

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

const CALL_ID = "c".repeat(64);
const SHA = "a".repeat(64);

function stepRequest(): GenerateApprovedStepRequest {
  return {
    runId: "run-1",
    conversationId: "conversation-1",
    callId: CALL_ID,
    stepId: "step-1",
    prompt: "生成动作控制参考图",
    inputArtifactIds: ["artifact-input-1"],
    outputRole: "control_reference",
    ratio: "3:4",
  };
}

const SIGNAL = { aborted: false, cancelRequested: false, leaseLost: false, stopRequested: false };

test("local executor parks with a registered task instead of generating", async () => {
  const actions: string[] = [];
  let requestedParams: Record<string, unknown> | null = null;
  const fetch: AgentWorkerFetch = async (_url, request) => {
    const body = JSON.parse(String(request?.body ?? "{}")) as Record<string, unknown>;
    actions.push(String(body.action));
    if (body.action === "local_task_status") return response(404);
    if (body.action === "local_task_request") {
      requestedParams = body.params as Record<string, unknown>;
      return response(200, JSON.stringify({ callId: CALL_ID, status: "pending", expiresAt: "2026-08-21T00:00:00Z" }));
    }
    if (body.action === "tool_prepare") {
      return response(200, JSON.stringify({ callId: body.callId, status: "prepared", reused: false }));
    }
    return response(200);
  };
  const client = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "worker-1" }, fetch);
  const executor = createLocalApprovedStepExecutor({
    runId: "run-1",
    leaseId: "lease-1",
    control: client,
    signal: SIGNAL,
    provider: "jimeng",
    artifactRole: () => ({ role: "input", stepId: "ref-1" }),
  });
  await rejects(() => executor.generate(stepRequest()), LocalTaskPendingError);
  deepEqual(actions, ["tool_prepare", "local_task_status", "tool_submitted", "local_task_request"]);
  deepEqual(requestedParams, {
    prompt: "生成动作控制参考图",
    ratio: "3:4",
    inputs: [{ artifactId: "artifact-input-1", role: "input", stepId: "ref-1" }],
  });
});

test("local executor consumes a completed desktop task through the artifact commit path", async () => {
  const actions: string[] = [];
  const usageRequests: Array<Record<string, unknown>> = [];
  const fetch: AgentWorkerFetch = async (_url, request) => {
    const body = JSON.parse(String(request?.body ?? "{}")) as Record<string, unknown>;
    actions.push(String(body.action));
    if (body.action === "usage") usageRequests.push(body);
    if (body.action === "local_task_status") {
      return response(200, JSON.stringify({
        callId: CALL_ID, status: "completed",
        resultObjectKey: `runs/run-1/artifacts/${CALL_ID}.png`,
        resultSha256: SHA, resultMime: "image/png", resultBytes: 128,
      }));
    }
    if (body.action === "artifact") {
      return response(200, JSON.stringify({
        artifactId: "artifact-result", role: "control_reference", stepId: "step-1",
        mime: "image/png", bytes: 128, sha256: SHA, objectKey: `runs/run-1/artifacts/${CALL_ID}.png`,
      }));
    }
    if (body.action === "tool_prepare") {
      return response(200, JSON.stringify({ callId: body.callId, status: "submitted", reused: true }));
    }
    return response(200);
  };
  const client = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "worker-1" }, fetch);
  const executor = createLocalApprovedStepExecutor({
    runId: "run-1",
    leaseId: "lease-1",
    control: client,
    signal: SIGNAL,
    provider: "codex",
    artifactRole: () => undefined,
  });
  const generated = await executor.generate(stepRequest());
  equal(generated.artifactId, "artifact-result");
  equal(generated.sha256, SHA);
  deepEqual(actions, ["tool_prepare", "local_task_status", "artifact", "usage", "tool_complete"]);
  deepEqual((usageRequests[0].items as Array<Record<string, unknown>>)[0], {
    callId: CALL_ID,
    kind: "image_generation",
    provider: "codex",
    model: "codex-cli-imagegen",
    inputUnits: 0,
    outputUnits: 0,
    imageCount: 1,
  });
});

test("local executor fails terminally when the desktop task failed or expired", async () => {
  for (const status of ["failed", "expired"] as const) {
    const fetch: AgentWorkerFetch = async (_url, request) => {
      const body = JSON.parse(String(request?.body ?? "{}")) as Record<string, unknown>;
      if (body.action === "local_task_status") {
        return response(200, JSON.stringify({ callId: CALL_ID, status, errorCode: "dreamina_error" }));
      }
      if (body.action === "tool_prepare") {
        return response(200, JSON.stringify({ callId: body.callId, status: "submitted", reused: true }));
      }
      return response(200);
    };
    const client = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "worker-1" }, fetch);
    const executor = createLocalApprovedStepExecutor({
      runId: "run-1",
      leaseId: "lease-1",
      control: client,
      signal: SIGNAL,
      provider: "jimeng",
      artifactRole: () => undefined,
    });
    await rejects(() => executor.generate(stepRequest()), (error: unknown) => {
      return error instanceof DurableProviderError && error.safeCode === "dreamina_error";
    });
  }
});

test("local executor restores an already-succeeded call without touching the task table", async () => {
  const actions: string[] = [];
  const fetch: AgentWorkerFetch = async (_url, request) => {
    const body = JSON.parse(String(request?.body ?? "{}")) as Record<string, unknown>;
    actions.push(String(body.action));
    if (body.action === "tool_prepare") {
      return response(200, JSON.stringify({ callId: body.callId, status: "succeeded", reused: true }));
    }
    if (body.action === "artifact_get") {
      return response(200, JSON.stringify({
        artifactId: "artifact-result", mime: "image/png", bytes: 128, sha256: SHA,
        objectKey: `runs/run-1/artifacts/${CALL_ID}.png`,
      }));
    }
    return response(200);
  };
  const client = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "worker-1" }, fetch);
  const executor = createLocalApprovedStepExecutor({
    runId: "run-1",
    leaseId: "lease-1",
    control: client,
    signal: SIGNAL,
    provider: "jimeng",
    artifactRole: () => undefined,
  });
  const generated = await executor.generate(stepRequest());
  equal(generated.artifactId, "artifact-result");
  deepEqual(actions, ["tool_prepare", "artifact_get"]);
});
