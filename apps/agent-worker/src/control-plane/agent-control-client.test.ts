import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";

import { AgentControlClient, type AgentWorkerFetch, type HttpResponse } from "./agent-control-client.ts";
import { createControlledRunnerCheckpoint } from "../kernel/controlled-image-edit-runner.ts";
import { loadControlledImageEditSkill } from "../skills/bowerbird-controlled-image-edit/loader.ts";

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

test("checkpoint is uploaded before its control-plane pointer is committed", async () => {
  const actions: string[] = [];
  const fetch: AgentWorkerFetch = async (_url, request) => {
    if (request?.method === "PUT") {
      actions.push("upload");
      return response(200);
    }
    const body = JSON.parse(String(request?.body ?? "{}")) as { action?: string };
    actions.push(body.action ?? "unknown");
    if (body.action === "checkpoint_prepare") {
      return response(200, JSON.stringify({ uploadUrl: "https://storage/upload", objectKey: "runs/run-1/checkpoints/hash.json" }));
    }
    return response(200);
  };
  const skill = loadControlledImageEditSkill();
  const checkpoint = createControlledRunnerCheckpoint({
    runId: "run-1",
    conversationId: "conversation-1",
    skillVersion: skill.version,
    skillHash: skill.instructionHash,
    input: { schemaVersion: 1, intentPrompt: "生成海报", references: [] },
  });
  const client = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "worker-1" }, fetch);
  await client.saveCheckpoint({ runId: "run-1", leaseId: "lease-1", checkpoint, step: checkpoint.phase, progress: 10 });
  deepEqual(actions, ["checkpoint_prepare", "upload", "checkpoint_commit"]);
});

test("tool ledger client preserves lifecycle and stable call id", async () => {
  const actions: string[] = [];
  const fetch: AgentWorkerFetch = async (_url, request) => {
    const body = JSON.parse(String(request?.body ?? "{}")) as { action?: string; callId?: string };
    actions.push(`${body.action}:${body.callId}`);
    return response(200, JSON.stringify({ callId: body.callId, status: body.action === "tool_prepare" ? "prepared" : body.action === "tool_submitted" ? "submitted" : "succeeded", reused: false }));
  };
  const client = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "worker-1" }, fetch);
  equal((await client.prepareTool({ runId: "run-1", leaseId: "lease-1", callId: "call-1", phase: "execute", toolName: "generate_image", argsHash: "a".repeat(64) })).status, "prepared");
  equal((await client.markToolSubmitted({ runId: "run-1", leaseId: "lease-1", callId: "call-1", providerRequestId: "provider-1" })).status, "submitted");
  equal((await client.completeTool({ runId: "run-1", leaseId: "lease-1", callId: "call-1", status: "succeeded", resultHash: "b".repeat(64) })).status, "succeeded");
  deepEqual(actions, ["tool_prepare:call-1", "tool_submitted:call-1", "tool_complete:call-1"]);
});

test("remote checkpoint is verified and restored against claim identity", async () => {
  const skill = loadControlledImageEditSkill();
  const checkpoint = createControlledRunnerCheckpoint({
    runId: "run-1",
    conversationId: "conversation-1",
    skillVersion: skill.version,
    skillHash: skill.instructionHash,
    input: { schemaVersion: 1, intentPrompt: "生成海报", references: [] },
  });
  const encoded = (await import("../kernel/controlled-checkpoint.ts")).encodeControlledCheckpoint(checkpoint);
  const fetch: AgentWorkerFetch = async () => ({
    ...response(200),
    arrayBuffer: async () => encoded.bytes.buffer as ArrayBuffer,
  });
  const client = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "worker-1" }, fetch);
  const restored = await client.loadControlledCheckpoint({
    run: {
      id: "run-1", conversationId: "conversation-1", skillId: "bowerbird-controlled-image-edit",
      skillVersion: skill.version, inputManifestHash: "a".repeat(64), approvedPlanHash: null,
      plannedToolCount: null, resultFeedbackAction: null, budgetCredits: 48, pricingVersion: 1,
      checkpointHash: encoded.sha256, snapshotSchemaVersion: 1,
    },
    checkpointUrl: "https://storage/checkpoint",
  }, skill.instructionHash);
  equal(restored?.phase, "analyze_intent_text_only");
  await rejects(async () => await client.loadControlledCheckpoint({
    run: {
      id: "other-run", conversationId: "conversation-1", skillId: "bowerbird-controlled-image-edit",
      skillVersion: skill.version, inputManifestHash: "a".repeat(64), approvedPlanHash: null,
      plannedToolCount: null, resultFeedbackAction: null, budgetCredits: 48, pricingVersion: 1,
      checkpointHash: encoded.sha256, snapshotSchemaVersion: 1,
    },
    checkpointUrl: "https://storage/checkpoint",
  }, skill.instructionHash), /controlled_checkpoint_run_mismatch/);
});
