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
    const row = { directDeepSeekV1Model: args.directDeepSeekV1Model, callId: args.callId, status: "prepared" as const, reused: false, argsHash: args.argsHash, phase: args.phase, toolName: args.toolName };
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

for (const committed of [false, true]) {
  test(`unknown model usage survives a single 500 (already committed=${committed})`, async () => {
    const control = new FakeControl();
    const original = control.recordUsage.bind(control);
    const attempts: string[] = [];
    let dispatches = 0;
    control.recordUsage = async args => {
      attempts.push(args.callId);
      if (committed || attempts.length > 1) await original(args);
      if (attempts.length === 1) throw new AgentControlError(500);
    };
    const base: ModelBackend = { id: "deepseek", async turn() {
      dispatches++;
      throw new DeepSeekBackendError("deepseek_network_error", {retryable:true});
    } };
    const model = new MeteredModelBackend({base,control,runId:"run-1",leaseId:"lease-1",model:"fixture"});
    await rejects(() => model.turn(request, {aborted:false}), /deepseek_network_error/);
    equal(attempts.length, 2);
    equal(new Set(attempts).size, 1);
    equal(control.usages.size, 1);
    equal(dispatches, 1);
  });
}

test("two failed usage writes checkpoint the exact observation and replay with no model dispatch", async () => {
  const base = new FakeDeepSeek();
  const control = new FakeControl();
  const original = control.recordUsage.bind(control);
  const model = new MeteredModelBackend({base, control, runId: request.runId, leaseId: "lease", model: "fixture"});
  let attempts = 0;
  control.recordUsage = async args => {
    attempts++;
    if (attempts <= 2) throw new AgentControlError(500);
    await original(args);
  };
  await rejects(() => model.turn(request, {aborted:false}), /agent_model_usage_pending/);
  const [checkpoint] = control.calls.values();
  deepEqual(checkpoint.pendingUsage, {inputUnits:20, outputUnits:10});
  await model.turn(request, {aborted:false});
  equal(base.calls, 1);
  equal(attempts, 3);
  equal(control.usages.get(checkpoint.callId)?.inputUnits, 20);
});

for (const stage of ["providerId", "artifact"]) {
  test(`known counts survive a failed ${stage} checkpoint`, async () => {
    const base = new FakeDeepSeek();
    const control = new FakeControl();
    const submit = control.markToolSubmitted.bind(control);
    if (stage === "providerId") control.markToolSubmitted = async args => {
      if (args.providerRequestId) throw new AgentControlError(500);
      return await submit(args);
    };
    else control.uploadDiagnostic = async () => { throw new AgentControlError(500); };
    const model = new MeteredModelBackend({base, control, runId:request.runId, leaseId:"lease",model:"fixture"});
    await rejects(() => model.turn(request,{aborted:false}),/provider_outcome_unknown/);
    const [usage] = control.usages.values();
    equal(usage.inputUnits,20);
    equal(usage.outputUnits,10);
    await rejects(() => model.turn(request,{aborted:false}),/provider_outcome_unknown/);
    equal(base.calls,1);
    equal(control.usages.size,1);
  });
}

test("two failed minimum writes retain observed evidence for the original lease recovery", async () => {
  const control = new FakeControl();
  const original = control.recordUsage.bind(control);
  let attempts = 0, dispatches = 0;
  control.recordUsage = async args => {
    if (++attempts <= 2) throw new AgentControlError(500);
    await original(args);
  };
  const base: ModelBackend = {id:"deepseek",async turn() {
    dispatches++;
    throw new DeepSeekBackendError("deepseek_network_error", {retryable:true});
  }};
  const model = new MeteredModelBackend({base,control,runId:request.runId,leaseId:"lease",model:"fixture"});
  await rejects(()=>model.turn(request,{aborted:false}),/agent_model_minimum_pending/);
  const [checkpoint] = control.calls.values();
  deepEqual(checkpoint.pendingUsage,{inputUnits:0,outputUnits:0});
  await rejects(()=>model.turn(request,{aborted:false}),/agent_model_minimum_pending/);
  equal(control.usages.size,1);
  equal(dispatches,1);
});

test("legacy direct call replay retains its original policy without upgrading its contract", async () => {
  const base = new FakeDeepSeek(), control = new FakeControl();
  const model = new MeteredModelBackend({base,control,runId:request.runId,leaseId:"lease",model:"fixture"});
  await model.turn(request,{aborted:false});
  const [call] = control.calls.values();
  control.calls.set(call.callId,{...call,status:"submitted",directDeepSeekV1Model:null});
  control.usages.clear(); control.artifacts.clear();
  await rejects(()=>model.turn(request,{aborted:false}),/provider_outcome_unknown/);
  equal(control.usages.get(call.callId)?.inputUnits,0);
  equal(base.calls,1);
});

test("unsupported control contract stops before submitting a new paid call", async () => {
  const base = new FakeDeepSeek(), control = new FakeControl();
  const prepare = control.prepareTool.bind(control);
  control.prepareTool = async args => ({...await prepare(args),directDeepSeekV1Model:undefined});
  const model = new MeteredModelBackend({base,control,runId:request.runId,leaseId:"lease",model:"fixture"});
  await rejects(()=>model.turn(request,{aborted:false}),/direct_model_contract_unavailable/);
  equal(base.calls,0);
});

test("a reused submission acknowledgement never dispatches another direct model request", async () => {
  const base = new FakeDeepSeek(), control = new FakeControl();
  const submit = control.markToolSubmitted.bind(control);
  control.markToolSubmitted = async args => ({...await submit(args), reused:true});
  const model = new MeteredModelBackend({base,control,runId:request.runId,leaseId:"lease",model:"fixture"});
  await rejects(()=>model.turn(request,{aborted:false}),/provider_outcome_unknown/);
  equal(base.calls,0);
  equal(control.usages.size,0);
});

test("recovering an uncertain call writes the terminal observation once per attempt", async () => {
  const control = new FakeControl();
  const complete = control.completeTool.bind(control);
  const codes: (string | undefined)[] = [];
  control.completeTool = async args => {
    codes.push(args.safeErrorCode);
    return await complete(args);
  };
  const model = new MeteredModelBackend({base: new UnknownOutcomeDeepSeek(), control, runId: request.runId, leaseId: "lease", model: "fixture"});
  await rejects(() => model.turn(request, {aborted: false}), /deepseek_network_error/);
  await rejects(() => model.turn(request, {aborted: false}), /deepseek_network_error/);
  deepEqual(codes, ["deepseek_network_error", "deepseek_network_error"]);
});

for (const [error, writes] of [
  [new TypeError("connection reset"), 2], [new Error("control_deadline_exceeded"), 2],
  [new AgentControlError(409), 1], [new AgentControlError(402), 1],
] as const) {
  test(`model usage write ${error.message} performs ${writes} attempts and preserves exact counts`, async () => {
    const control = new FakeControl(), base = new FakeDeepSeek();
    const stored = control.recordUsage.bind(control);
    let attempted = 0;
    control.recordUsage = async args => {
      if (++attempted === 1) throw error;
      await stored(args);
    };
    const model = new MeteredModelBackend({base, control, runId: request.runId, leaseId: "lease", model: "fixture"});
    if (writes === 2) {
      await model.turn(request, {aborted: false});
      equal([...control.usages.values()][0].inputUnits, 20);
    } else {
      await rejects(() => model.turn(request, {aborted: false}), /agent_model_usage_pending/);
      deepEqual([...control.calls.values()][0].pendingUsage, {inputUnits: 20, outputUnits: 10});
    }
    equal(attempted, writes);
    equal(base.calls, 1);
  });
}

for (const cause of ["before-execute", "refusal", "provider-preflight", "unexpected"] as const) {
  test(`model failure ${cause} leaves no billable observation`, async () => {
    const control = new FakeControl();
    const signal = {aborted: false};
    const submit = control.markToolSubmitted.bind(control);
    control.markToolSubmitted = async args => {
      const result = await submit(args);
      signal.aborted = cause === "before-execute";
      return result;
    };
    let calls = 0;
    const base: ModelBackend = {id: "deepseek", async turn() {
      calls++;
      if (cause === "refusal") return {kind: "refusal", reason: "aborted", providerUsage: {}};
      if (cause === "provider-preflight") throw new DeepSeekBackendError("deepseek_not_dispatched");
      throw new TypeError("unexpected");
    }};
    const model = new MeteredModelBackend({base, control, runId: request.runId, leaseId: "lease", model: "fixture"});
    await rejects(() => model.turn(request, signal), cause === "unexpected" ? /provider_outcome_unknown/ : /deepseek_not_dispatched/);
    equal(calls, cause === "before-execute" ? 0 : 1);
    equal(control.usages.size, 0);
    equal([...control.calls.values()][0].status, cause === "unexpected" ? "outcome_unknown" : "failed");
  });
}

test("an actual model refusal with another reason records its observed tokens", async () => {
  const control = new FakeControl();
  const base: ModelBackend = {id: "deepseek", async turn() {
    return {kind: "refusal", reason: "policy", providerUsage: {promptTokens: 2, completionTokens: 1}};
  }};
  const model = new MeteredModelBackend({base, control, runId: request.runId, leaseId: "lease", model: "fixture"});
  const result = await model.turn(request, {aborted: false});
  equal(result.kind, "refusal");
  equal([...control.usages.values()][0].outputUnits, 1);
});

for (const [status, reused, modelName] of [
  ["submitted", false, null], ["prepared", true, null], ["submitted", true, "different-model"],
] as const) {
  test(`incompatible prepare response ${status}/${reused}/${modelName} stops before model execution`, async () => {
    const control = new FakeControl(), base = new FakeDeepSeek();
    const prepare = control.prepareTool.bind(control);
    control.prepareTool = async args => ({
      ...await prepare(args), directDeepSeekV1Model: modelName, status, reused,
    });
    const model = new MeteredModelBackend({base, control, runId: request.runId, leaseId: "lease", model: "fixture"});
    await rejects(() => model.turn(request, {aborted: false}), /direct_model_contract_unavailable/);
    equal(base.calls, 0);
    equal(control.usages.size, 0);
    equal([...control.calls.values()][0].status, "prepared");
  });
}

for (const status of ["succeeded", "failed"] as const) {
  test(`when another worker has ${status}, a stale submit acknowledgement restores its outcome`, async () => {
    const control = new FakeControl(), base = new FakeDeepSeek();
    const model = new MeteredModelBackend({base, control, runId: request.runId, leaseId: "lease", model: "fixture"});
    const result = await model.turn(request, {aborted: false});
    // The first read sees the row before the concurrent worker's terminal commit.
    const prepare = control.prepareTool.bind(control);
    control.prepareTool = async args => ({...await prepare(args), status: "prepared"});
    control.markToolSubmitted = async () => ({...[...control.calls.values()][0], status, reused: true,
      safeErrorCode: status === "failed" ? "deepseek_http_error" : null});
    if (status === "succeeded") deepEqual(await model.turn(request, {aborted: false}), result);
    else await rejects(() => model.turn(request, {aborted: false}), /deepseek_http_error/);
    equal(base.calls, 1);
    equal(control.usages.size, 1);
  });
}

for (const [safeErrorCode, usage] of [
  ["agent_model_minimum_pending", {inputUnits: 0, outputUnits: 0}],
  ["agent_model_usage_pending", {inputUnits: 20, outputUnits: 10}],
] as const) {
  test(`a failed recovery preserves the evidence class ${safeErrorCode}`, async () => {
    const control = new FakeControl(), base = new FakeDeepSeek();
    const model = new MeteredModelBackend({base, control, runId: request.runId, leaseId: "lease", model: "fixture"});
    await model.turn(request, {aborted: false});
    const [row] = control.calls.values();
    control.calls.set(row.callId, {...row, safeErrorCode, status: "outcome_unknown", pendingUsage: usage});
    control.artifacts.clear(); control.usages.clear();
    control.recordUsage = async () => { throw new AgentControlError(500); };
    await rejects(() => model.turn(request, {aborted: false}), new RegExp(safeErrorCode));
    equal(base.calls, 1);
    deepEqual(control.calls.get(row.callId)?.pendingUsage, usage);
  });
}

test("an empty historical provider error code still reports an unknown outcome on recovery", async () => {
  const control = new FakeControl(), base = new FakeDeepSeek();
  const model = new MeteredModelBackend({base, control, runId: request.runId, leaseId: "lease", model: "fixture"});
  await model.turn(request, {aborted: false});
  const [row] = control.calls.values();
  control.calls.set(row.callId, {...row, status: "outcome_unknown", safeErrorCode: ""});
  control.artifacts.clear();
  await rejects(() => model.turn(request, {aborted: false}), /provider_outcome_unknown/);
  equal(base.calls, 1);
  equal(control.calls.get(row.callId)?.safeErrorCode, "provider_outcome_unknown");
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

test("submitted marker without an observation stays unknown and awaits reconciliation", async () => {
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
  equal(control.usages.has(callId), false);
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
