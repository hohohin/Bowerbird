import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { ModelBackend, ModelTurnRequest, ModelTurnResult } from "../../contracts/model.ts";
import { AgentControlError, type PreparedToolCall, type RegisteredAgentArtifact } from "../../control-plane/agent-control-client.ts";
import type { DurableToolIdentity } from "../../kernel/durable-tool-dispatcher.ts";
import { sha256Hex } from "../../kernel/tool-ledger.ts";
import { MeteredModelBackend, type MeteredModelControl } from "./metered-model-backend.ts";
import { DeepSeekBackend, DeepSeekBackendError } from "./backend.ts";

const request: ModelTurnRequest = {
  runId: "run-1",
  phase: "compose_plan_with_skill",
  systemPolicy: "policy",
  skillInstructions: "skill",
  context: [],
  allowedActions: [],
  responseSchemaVersion: 1,
};

class FakeDeepSeek implements ModelBackend {
  readonly id = "deepseek" as const;
  calls = 0;
  async turn(): Promise<ModelTurnResult> {
    this.calls += 1;
    return {
      kind: "action",
      action: "submit_plan_for_approval",
      arguments: { plan: { schemaVersion: 1 } },
      providerUsage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, providerRequestId: "req-1", raw: { secret: "drop" } },
    };
  }
}

class UnknownOutcomeDeepSeek implements ModelBackend {
  readonly id = "deepseek" as const;
  async turn(): Promise<ModelTurnResult> {
    throw new DeepSeekBackendError("deepseek_network_error", { retryable: true });
  }
}

class FakeControl implements MeteredModelControl {
  calls = new Map<string, PreparedToolCall & { argsHash: string; phase: string; toolName: string }>();
  artifacts = new Map<string, { bytes: Uint8Array; artifact: RegisteredAgentArtifact }>();
  usages = new Map<string, Record<string, unknown>>();
  failUsageOnce = false;

  async prepareTool(args: DurableToolIdentity & { argsHash: string }): Promise<PreparedToolCall> {
    const existing = this.calls.get(args.callId);
    if (existing) return { ...existing, reused: true };
    const row = { callId: args.callId, status: "prepared" as const, reused: false, argsHash: args.argsHash, phase: args.phase, toolName: args.toolName };
    this.calls.set(args.callId, row);
    return row;
  }
  async markToolSubmitted(args: { runId: string; leaseId: string; callId: string; providerRequestId?: string }): Promise<PreparedToolCall> {
    const row = this.calls.get(args.callId)!;
    const next = { ...row, status: "submitted" as const, providerRequestId: args.providerRequestId ?? row.providerRequestId, reused: row.status !== "prepared" };
    this.calls.set(args.callId, next);
    return next;
  }
  async completeTool(args: { runId: string; leaseId: string; callId: string; status: "succeeded" | "failed" | "outcome_unknown"; resultObjectKey?: string; resultHash?: string; safeErrorCode?: string }): Promise<PreparedToolCall> {
    const row = this.calls.get(args.callId)!;
    const next = { ...row, ...args, reused: false };
    this.calls.set(args.callId, next);
    return next;
  }
  async uploadDiagnostic(args: { runId: string; leaseId: string; sourceCallId: string; stepId: string; bytes: Uint8Array; sha256: string }): Promise<RegisteredAgentArtifact> {
    const artifact: RegisteredAgentArtifact = {
      artifactId: `artifact-${args.sourceCallId}`,
      conversationId: "conversation-1",
      runId: args.runId,
      role: "diagnostic",
      stepId: args.stepId,
      mime: "application/json",
      bytes: args.bytes.byteLength,
      sha256: args.sha256,
      userVisible: false,
      objectKey: `runs/${args.runId}/artifacts/${args.sourceCallId}.json`,
      url: `memory://${args.sourceCallId}`,
    };
    this.artifacts.set(args.sourceCallId, { bytes: args.bytes, artifact });
    return artifact;
  }
  async getArtifactByCall(_runId: string, _leaseId: string, callId: string): Promise<RegisteredAgentArtifact> {
    const stored = this.artifacts.get(callId);
    if (!stored) throw new AgentControlError(409);
    return stored.artifact;
  }
  async downloadVerifiedBytes(url: string, expected: { sha256: string; bytes: number }): Promise<Uint8Array> {
    const callId = url.slice("memory://".length);
    const stored = this.artifacts.get(callId)!;
    equal(stored.bytes.byteLength, expected.bytes);
    equal(sha256Hex(new TextDecoder().decode(stored.bytes)), expected.sha256);
    return stored.bytes;
  }
  async recordUsage(args: Record<string, unknown> & { callId: string }): Promise<void> {
    if (this.failUsageOnce) {
      this.failUsageOnce = false;
      throw new Error("usage_write_failed");
    }
    const existing = this.usages.get(args.callId);
    if (existing) deepEqual(existing, args);
    else this.usages.set(args.callId, args);
  }
}

test("metered model turn persists usage and restores without a second DeepSeek request", async () => {
  const base = new FakeDeepSeek();
  const control = new FakeControl();
  const model = new MeteredModelBackend({ base, control, runId: "run-1", leaseId: "lease-1", model: "deepseek-chat" });
  const first = await model.turn(request, { aborted: false });
  const replay = await model.turn(request, { aborted: false });
  deepEqual(replay, first);
  equal(base.calls, 1);
  equal(control.usages.size, 1);
  const usage = [...control.usages.values()][0];
  equal(usage.inputUnits, 20);
  equal(usage.outputUnits, 10);
  equal(JSON.stringify(replay).includes("secret"), false);
});

test("artifact-before-usage crash recovers the same model result and records usage once", async () => {
  const base = new FakeDeepSeek();
  const control = new FakeControl();
  control.failUsageOnce = true;
  const model = new MeteredModelBackend({ base, control, runId: "run-1", leaseId: "lease-1", model: "deepseek-chat" });
  await rejects(() => model.turn(request, { aborted: false }));
  const restored = await model.turn(request, { aborted: false });
  equal(restored.kind, "action");
  equal(base.calls, 1);
  equal(control.usages.size, 1);
});

test("submitted model turn without an artifact becomes outcome_unknown and records minimum usage", async () => {
  const base = new FakeDeepSeek();
  const control = new FakeControl();
  const model = new MeteredModelBackend({ base, control, runId: "run-1", leaseId: "lease-1", model: "deepseek-chat" });
  const pending = model.turn(request, { aborted: false });
  await pending;
  const callId = [...control.calls.keys()][0];
  control.calls.set(callId, { ...control.calls.get(callId)!, status: "submitted" });
  control.artifacts.delete(callId);
  control.usages.delete(callId);
  await rejects(() => model.turn(request, { aborted: false }), /provider_outcome_unknown/);
  equal(base.calls, 1);
  equal(control.usages.get(callId)?.inputUnits, 0);
  equal(control.usages.get(callId)?.outputUnits, 0);
});

test("network-unknown DeepSeek outcome records minimum usage before the Run can settle", async () => {
  const control = new FakeControl();
  const model = new MeteredModelBackend({
    base: new UnknownOutcomeDeepSeek(), control, runId: "run-1", leaseId: "lease-1", model: "deepseek-chat",
  });
  await rejects(() => model.turn(request, { aborted: false }), /deepseek_network_error/);
  const callId = [...control.calls.keys()][0];
  equal(control.calls.get(callId)?.status, "outcome_unknown");
  equal(control.usages.get(callId)?.inputUnits, 0);
  equal(control.usages.get(callId)?.outputUnits, 0);
});

for (const [status, body, finalState] of [
  [403, "html", "failed"], [403, "empty", "failed"], [403, "stall", "failed"],
  [429, "empty", "failed"], [503, "json", "failed"], [502, "stall", "failed"],
  [200, "html", "outcome_unknown"],
] as const) {
  test(`metered DeepSeek preserves ${status} with ${body} body through settlement and recovery`, async () => {
    let dispatches = 0;
    let transportAborted = false;
    const control = new FakeControl();
    const base = new DeepSeekBackend({ apiKey: "fixture", baseUrl: "https://local.test", model: "test", timeoutMs: 60 },
      async (_url, init) => {
        dispatches++;
        return {
          ok: status === 200, status,
          json: () => {
            if (body === "stall") return new Promise<never>((_, reject) => {
              init.signal.addEventListener("abort", () => { transportAborted = true; reject(new Error("closed")); }, { once: true });
            });
            return Promise.resolve(JSON.parse(body === "html" ? "<html>private</html>" : body === "empty" ? "" : '{"error":{"type":"upstream_failure"}}'));
          },
        };
      });
    const model = new MeteredModelBackend({ base, control, runId: request.runId, leaseId: "lease", model: "test" });
    const error = status === 200 ? /deepseek_invalid_json/ : /deepseek_http_error/;
    await rejects(() => model.turn(request, { aborted: false }), error);
    const callId = [...control.calls.keys()][0];
    equal(control.calls.get(callId)?.status, finalState);
    equal(control.usages.size, finalState === "failed" ? 0 : 1);
    if (finalState === "outcome_unknown") {
      equal(control.usages.get(callId)?.inputUnits, 0);
      equal(control.usages.get(callId)?.outputUnits, 0);
    }
    if (body === "stall") equal(transportAborted, true);
    await rejects(() => model.turn(request, { aborted: false }), error);
    equal(dispatches, 1);
    equal(control.usages.size, finalState === "failed" ? 0 : 1);
  });
}

test("direct fetch preserves HTTP 403 and actually closes a stalled error body on cancellation", async () => {
  const headers = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const caller = new AbortController();
  let sent = 0;
  const server = createServer((_req, res) => {
    sent++;
    res.on("close", () => disconnected.resolve());
    res.writeHead(403, { "content-type": "text/html" });
    res.write("<html>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("loopback_listen_failed");
  const model = new DeepSeekBackend({ apiKey: "fixture", baseUrl: "https://local.test", model: "test", timeoutMs: 5000 },
    async (_url, init) => {
      const response = await fetch(`http://127.0.0.1:${address.port}`, init);
      return { ok: response.ok, status: response.status, json: () => {
        headers.resolve();
        return response.json();
      } };
    });
  let watchdog: unknown;
  try {
    const verify = async () => {
      const result = rejects(() => model.turn(request, caller.signal), (error: unknown) =>
        error instanceof DeepSeekBackendError && error.safeCode === "deepseek_http_error" && error.status === 403);
      await headers.promise;
      caller.abort();
      await result;
      await disconnected.promise;
      equal(sent, 1);
    };
    await Promise.race([verify(), new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error("stalled_connection_not_closed")), 8000);
    })]);
  } finally {
    clearTimeout(watchdog);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
