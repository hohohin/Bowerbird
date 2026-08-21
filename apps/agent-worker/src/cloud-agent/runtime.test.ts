import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { test } from "node:test";

import { AgentControlClient, type AgentWorkerFetch, type ClaimedAgentRun, type HttpResponse } from "../control-plane/agent-control-client.ts";
import { agentConfigFromEnv, executeClaimedAgentRun, runAgentWorker } from "./runtime.ts";

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

function claim(): ClaimedAgentRun {
  return {
    run: {
      id: "run-1",
      conversationId: "conversation-1",
      skillId: "bowerbird-controlled-image-edit",
      skillVersion: "0.1.1",
      inputManifestHash: "a".repeat(64),
      approvedPlanHash: null,
      plannedToolCount: null,
      resultFeedbackAction: null,
      budgetCredits: 48,
      pricingVersion: 1,
      checkpointHash: null,
      snapshotSchemaVersion: null,
    },
    lease: { leaseId: "lease-1", leaseSeconds: 60 },
  };
}

test("Agent worker config uses dedicated credentials", () => {
  const config = agentConfigFromEnv({
    AGENT_CONTROL_URL: "https://control",
    AGENT_WORKER_TOKEN: "secret",
    AGENT_WORKER_ID: "agent-1",
  });
  equal(config.workerId, "agent-1");
  equal(config.heartbeatIntervalMs, 20_000);
  throws(() => agentConfigFromEnv({ AGENT_CONTROL_URL: "https://control" }), /AGENT_WORKER_TOKEN_missing/);
});

test("heartbeat cancellation is settled at the processor safe point", async () => {
  const actions: string[] = [];
  const fetch: AgentWorkerFetch = async (_url, request) => {
    const body = JSON.parse(String(request?.body ?? "{}")) as { action: string };
    actions.push(body.action);
    if (body.action === "heartbeat") return response(200, JSON.stringify({ status: "running", cancelRequested: true, leaseExpiresAt: null }));
    return response(200);
  };
  const client = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "agent-1" }, fetch);
  let sleeps = 0;
  const sleep = async () => {
    if (sleeps++ === 0) return;
    await new Promise<void>(() => undefined);
  };
  await executeClaimedAgentRun(claim(), client, {
    async process(context) {
      while (!context.signal.cancelRequested) await Promise.resolve();
    },
  }, { requested: false }, 1, sleep);
  deepEqual(actions.slice(0, 2), ["heartbeat", "cancel"]);
});

test("lost lease exits without attempting fail or cancel", async () => {
  const actions: string[] = [];
  const fetch: AgentWorkerFetch = async (_url, request) => {
    const body = JSON.parse(String(request?.body ?? "{}")) as { action: string };
    actions.push(body.action);
    return response(body.action === "heartbeat" ? 409 : 200);
  };
  const client = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "agent-1" }, fetch);
  let sleeps = 0;
  const sleep = async () => {
    if (sleeps++ === 0) return;
    await new Promise<void>(() => undefined);
  };
  await executeClaimedAgentRun(claim(), client, {
    async process(context) {
      while (!context.signal.leaseLost) await Promise.resolve();
      throw new Error("processor_stopped_for_lease_loss");
    },
  }, { requested: false }, 1, sleep);
  deepEqual(actions, ["heartbeat"]);
});

test("approval pause returns without implicit finish or fail", async () => {
  const actions: string[] = [];
  const fetch: AgentWorkerFetch = async (_url, request) => {
    const body = JSON.parse(String(request?.body ?? "{}")) as { action: string };
    actions.push(body.action);
    return response(200);
  };
  const client = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "agent-1" }, fetch);
  await executeClaimedAgentRun(claim(), client, { process: async () => undefined }, { requested: false }, 20_000, async () => {
    await new Promise<void>(() => undefined);
  });
  deepEqual(actions, []);
});

test("poll loop stops gracefully after an empty claim", async () => {
  const stop = { requested: false };
  let claims = 0;
  const fetch: AgentWorkerFetch = async (_url, request) => {
    const body = JSON.parse(String(request?.body ?? "{}")) as { action: string };
    if (body.action === "claim") claims++;
    return response(200, JSON.stringify({ run: null }));
  };
  const client = new AgentControlClient({ controlUrl: "https://control", workerToken: "secret", workerId: "agent-1" }, fetch);
  await runAgentWorker(agentConfigFromEnv({ AGENT_CONTROL_URL: "https://control", AGENT_WORKER_TOKEN: "secret" }), {
    process: async () => undefined,
  }, {
    control: client,
    stop,
    sleep: async () => { stop.requested = true; },
  });
  equal(claims, 1);
  ok(stop.requested);
});
