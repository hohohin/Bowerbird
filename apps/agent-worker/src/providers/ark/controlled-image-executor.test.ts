import { randomUUID } from "node:crypto";
import { deepEqual, equal } from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RunWorkspace } from "../../cloud-agent/run-workspace.ts";
import { AgentControlClient, type AgentWorkerFetch, type HttpResponse } from "../../control-plane/agent-control-client.ts";
import { arkSizeForRatio, createArkApprovedStepExecutor } from "./controlled-image-executor.ts";

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

test("Ark maps every supported Agent ratio to an explicit 2K canvas", () => {
  deepEqual(
    ["1:1", "3:4", "4:3", "2:3", "3:2", "16:9", "9:16"].map(arkSizeForRatio),
    ["2048x2048", "1728x2304", "2304x1728", "1664x2496", "2496x1664", "2560x1440", "1440x2560"],
  );
  equal(arkSizeForRatio(undefined), undefined);
});

test("Ark approved-step executor uploads and registers one artifact, then restores it idempotently", async () => {
  const actions: string[] = [];
  let toolStatus = "prepared";
  let artifact: Record<string, unknown> | null = null;
  const fetch: AgentWorkerFetch = async (_url, request) => {
    if (request?.method === "PUT") {
      actions.push("upload");
      return response(200);
    }
    const body = JSON.parse(String(request?.body ?? "{}")) as Record<string, unknown>;
    const action = String(body.action ?? "unknown");
    actions.push(action);
    if (action === "tool_prepare") return response(200, JSON.stringify({ callId: body.callId, status: toolStatus, reused: toolStatus !== "prepared" }));
    if (action === "tool_submitted") {
      toolStatus = "submitted";
      return response(200, JSON.stringify({ callId: body.callId, status: toolStatus, reused: false }));
    }
    if (action === "artifact_prepare") return response(200, JSON.stringify({ uploadUrl: "https://storage/upload", objectKey: `runs/run-1/artifacts/${body.sourceCallId}.png` }));
    if (action === "artifact") {
      artifact = {
        artifactId: "artifact-1", conversationId: "conversation-1", runId: "run-1", role: body.role,
        stepId: body.stepId, parentArtifactId: null, mime: body.mime, bytes: body.bytes,
        sha256: body.sha256, userVisible: true, objectKey: `runs/run-1/artifacts/${body.sourceCallId}.png`,
      };
      return response(200, JSON.stringify(artifact));
    }
    if (action === "usage") return response(200);
    if (action === "tool_complete") {
      toolStatus = "succeeded";
      return response(200, JSON.stringify({ callId: body.callId, status: toolStatus, resultObjectKey: body.resultObjectKey, resultHash: body.resultHash, reused: false }));
    }
    if (action === "artifact_get") return response(200, JSON.stringify({ ...artifact, url: "https://storage/artifact" }));
    return response(200);
  };
  const control = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "worker" }, fetch);
  const workspace = new RunWorkspace({ root: join(tmpdir(), `bowerbird-workspace-test-${randomUUID()}`), runId: "run-1", control });
  const executor = createArkApprovedStepExecutor({
    runId: "run-1", leaseId: "lease-1", control, workspace,
    config: { apiKey: "ark-key", baseUrl: "https://ark.example", model: "seedream", size: "2K", mock: true },
    signal: { aborted: false, cancelRequested: false, leaseLost: false, stopRequested: false },
  });
  const request = {
    runId: "run-1", conversationId: "conversation-1", callId: "a".repeat(64), stepId: "final",
    prompt: "生成蓝色海报", inputArtifactIds: [], outputRole: "final_result" as const,
  };
  let first;
  try {
    first = await executor.generate(request);
  } catch (error) {
    throw new Error(`executor_failed_after:${actions.join(",")}`, { cause: error });
  }
  const second = await executor.generate(request);
  equal(first.artifactId, "artifact-1");
  deepEqual(second, first);
  equal(actions.filter((action) => action === "artifact_prepare").length, 1);
  equal(actions.filter((action) => action === "upload").length, 1);
  equal(actions.filter((action) => action === "usage").length, 1);
  workspace.cleanup();
});
