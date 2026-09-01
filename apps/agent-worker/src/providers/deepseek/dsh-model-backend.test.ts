import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { test } from "node:test";
import type { HarnessAdapter, HarnessCheckpointSeed, HarnessPromptBlock } from "../../harness/contracts.ts";
import {
  AgentControlError,
  type PreparedToolCall,
  type RegisteredAgentArtifact,
} from "../../control-plane/agent-control-client.ts";
import type { ModelTurnRequest } from "../../contracts/model.ts";
import type { DurableToolIdentity } from "../../kernel/durable-tool-dispatcher.ts";
import {
  TOOL_BRIDGE_CAPABILITY_ENV,
  TOOL_BRIDGE_ENDPOINT_ENV,
} from "../../harness/loopback-tool-bridge-server.ts";
import { DshModelBackend, type DshModelBackendDependencies } from "./dsh-model-backend.ts";
import {
  startMeteredDeepSeekProxy,
  type MeteredDeepSeekProxyControl,
} from "../../harness/metered-deepseek-proxy.ts";

class MemoryProxyControl implements MeteredDeepSeekProxyControl {
  readonly calls = new Map<string, PreparedToolCall & { argsHash: string; toolName: string }>();
  readonly artifacts = new Map<string, { artifact: RegisteredAgentArtifact; bytes: Uint8Array }>();
  readonly usage = new Map<string, { inputUnits: number; outputUnits: number }>();

  async prepareTool(args: DurableToolIdentity & { argsHash: string }): Promise<PreparedToolCall> {
    const existing = this.calls.get(args.callId);
    if (existing) {
      equal(existing.argsHash, args.argsHash);
      return { ...existing, reused: true };
    }
    const created = {
      callId: args.callId,
      argsHash: args.argsHash,
      toolName: args.toolName,
      status: "prepared" as const,
      reused: false,
    };
    this.calls.set(args.callId, created);
    return created;
  }

  async markToolSubmitted(args: { callId: string; providerRequestId?: string }): Promise<PreparedToolCall> {
    const existing = this.calls.get(args.callId);
    if (!existing) throw new Error("missing_call");
    const updated = { ...existing, status: "submitted" as const, providerRequestId: args.providerRequestId };
    this.calls.set(args.callId, updated);
    return updated;
  }

  async completeTool(args: {
    callId: string;
    status: "succeeded" | "failed" | "outcome_unknown";
    resultObjectKey?: string;
    resultHash?: string;
    safeErrorCode?: string;
  }): Promise<PreparedToolCall> {
    const existing = this.calls.get(args.callId);
    if (!existing) throw new Error("missing_call");
    const updated = { ...existing, ...args };
    this.calls.set(args.callId, updated);
    return updated;
  }

  async uploadDiagnostic(args: {
    runId: string;
    sourceCallId: string;
    stepId: string;
    bytes: Uint8Array;
    sha256: string;
  }): Promise<RegisteredAgentArtifact> {
    const artifact: RegisteredAgentArtifact = {
      artifactId: `artifact-${args.sourceCallId}`,
      conversationId: "conversation-controlled",
      runId: args.runId,
      role: "diagnostic",
      stepId: args.stepId,
      mime: "application/json",
      bytes: args.bytes.byteLength,
      sha256: args.sha256,
      userVisible: false,
      objectKey: `memory/${args.sourceCallId}.json`,
      url: `memory://${args.sourceCallId}`,
    };
    this.artifacts.set(args.sourceCallId, { artifact, bytes: Uint8Array.from(args.bytes) });
    return artifact;
  }

  async getArtifactByCall(_runId: string, _leaseId: string, callId: string): Promise<RegisteredAgentArtifact> {
    const stored = this.artifacts.get(callId);
    if (!stored) throw new AgentControlError(409);
    return stored.artifact;
  }

  async downloadVerifiedBytes(url: string): Promise<Uint8Array> {
    const stored = this.artifacts.get(url.replace("memory://", ""));
    if (!stored) throw new Error("artifact_missing");
    return Uint8Array.from(stored.bytes);
  }

  async recordUsage(args: { callId: string; inputUnits: number; outputUnits: number }): Promise<void> {
    const value = { inputUnits: args.inputUnits, outputUnits: args.outputUnits };
    const existing = this.usage.get(args.callId);
    if (existing) deepEqual(existing, value);
    else this.usage.set(args.callId, value);
  }
}

function request(): ModelTurnRequest {
  return {
    runId: "run-controlled",
    phase: "analyze_intent_text_only",
    systemPolicy: "system-policy",
    skillInstructions: "skill-instructions",
    context: [{
      kind: "user_goal",
      source: "user",
      trust: "untrusted",
      contentHash: "a".repeat(64),
      body: { goal: "keep subject" },
    }],
    responseSchemaVersion: 1,
    allowedActions: [{
      name: "record_intent_analysis",
      kind: "kernel",
      description: "record analysis",
      argumentSchema: { type: "object", required: ["analysis"] },
    }],
  };
}

function dependencies(state: { closed: number; started: number; maxModelTurns?: number }): DshModelBackendDependencies {
  return {
    async startModelProxy(options) {
      state.started += 1;
      state.maxModelTurns = options.maxModelTurns;
      return {
        childEnvironment: () => ({
          DEEPSEEK_API_KEY: "b".repeat(64),
          DEEPSEEK_BASE_URL: "http://127.0.0.1:45678",
        }),
        async close() { state.closed += 1; },
      };
    },
  };
}

function adapterFactory(
  action: string | undefined,
  observed: { seed?: HarnessCheckpointSeed; prompt?: HarnessPromptBlock[] },
) {
  return (childEnvironment: Readonly<Record<string, string>>): HarnessAdapter => ({
    id: "fake-dsh",
    async open(seed) {
      observed.seed = seed;
      return {
        sessionId: "session-1",
        runId: seed.runId,
        async turn(prompt) {
          observed.prompt = prompt;
          if (action) {
            const response = await fetch(childEnvironment[TOOL_BRIDGE_ENDPOINT_ENV]!, {
              method: "POST",
              headers: {
                authorization: `Bearer ${childEnvironment[TOOL_BRIDGE_CAPABILITY_ENV]}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                toolName: action,
                arguments: { analysis: { intentSummary: "captured" } },
              }),
            });
            ok(response.ok);
          }
          return { stopReason: "end_turn", committedContent: [] };
        },
        async cancel() {},
        async close() {},
      };
    },
  });
}

test("DSH model backend returns one captured action and closes its metered proxy", async () => {
  const state: { closed: number; started: number; maxModelTurns?: number } = { closed: 0, started: 0 };
  const observed: { seed?: HarnessCheckpointSeed; prompt?: HarnessPromptBlock[] } = {};
  const backend = new DshModelBackend({
    runId: "run-controlled",
    leaseId: "lease-1",
    control: {} as MeteredDeepSeekProxyControl,
    upstream: { apiKey: "parent", baseUrl: "https://deepseek.invalid", model: "deepseek-v4-flash" },
    createAdapter: adapterFactory("record_intent_analysis", observed),
  }, dependencies(state));

  deepEqual(await backend.turn(request(), { aborted: false }), {
    kind: "action",
    action: "record_intent_analysis",
    arguments: { analysis: { intentSummary: "captured" } },
    providerUsage: {},
  });
  equal(state.started, 1);
  equal(state.closed, 1);
  equal(state.maxModelTurns, 3);
  equal(observed.seed?.phase, "analyze_intent_text_only");
  const text = observed.prompt?.[0]?.type === "text" ? observed.prompt[0].text : "";
  ok(text.includes("exactly one currently allowed action tool directly"));
  ok(text.includes("valid JSON tool arguments are mandatory"));
  ok(text.includes("Reference IDs are closed-world"));
  ok(text.includes("all four terms 背面, 不可见, 未知, and 推测"));
  ok(text.includes("Strategy routing is exact"));
  ok(text.includes("copy plan.intentAnalysisHash exactly"));
  ok(text.includes("record_intent_analysis"));
  ok(text.includes("system-policy"));
});

test("DSH model backend fails closed when no accepted action arrives and still closes proxy", async () => {
  const state = { closed: 0, started: 0 };
  const backend = new DshModelBackend({
    runId: "run-controlled",
    leaseId: "lease-1",
    control: {} as MeteredDeepSeekProxyControl,
    upstream: { apiKey: "parent", baseUrl: "https://deepseek.invalid", model: "deepseek-v4-flash" },
    createAdapter: adapterFactory(undefined, {}),
  }, dependencies(state));
  await rejects(() => backend.turn(request(), { aborted: false }), /controlled_dsh_model_action_missing/);
  equal(state.closed, 1);
});

test("DSH model backend refuses pre-aborted turns without starting DSH or provider proxy", async () => {
  const state = { closed: 0, started: 0 };
  const backend = new DshModelBackend({
    runId: "run-controlled",
    leaseId: "lease-1",
    control: {} as MeteredDeepSeekProxyControl,
    upstream: { apiKey: "parent", baseUrl: "https://deepseek.invalid", model: "deepseek-v4-flash" },
    createAdapter: adapterFactory("record_intent_analysis", {}),
  }, dependencies(state));
  deepEqual(await backend.turn(request(), { aborted: true }), {
    kind: "refusal",
    reason: "aborted",
    providerUsage: {},
  });
  equal(state.started, 0);
  equal(state.closed, 0);
  await rejects(() => backend.turn({ ...request(), runId: "another-run" }, { aborted: false }),
    /controlled_dsh_model_run_mismatch/);
});

test("DSH model backend rebuild replays a persisted provider response without a second upstream call", async () => {
  const control = new MemoryProxyControl();
  let upstreamCalls = 0;
  const dependencies: DshModelBackendDependencies = {
    async startModelProxy(options) {
      return await startMeteredDeepSeekProxy({
        ...options,
        fetch: async () => {
          upstreamCalls += 1;
          return {
            ok: true,
            status: 200,
            async text() {
              return `data: ${JSON.stringify({
                id: "provider-controlled-1",
                choices: [{ index: 0, delta: { content: "tool" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 31, completion_tokens: 9, total_tokens: 40 },
              })}\n\ndata: [DONE]\n\n`;
            },
          };
        },
      });
    },
  };
  const createAdapter = (
    childEnvironment: Readonly<Record<string, string>>,
    providerEnvironment: Readonly<Record<string, string>>,
  ): HarnessAdapter => ({
    id: "fake-dsh-with-proxy",
    async open(seed) {
      return {
        sessionId: "session-replay",
        runId: seed.runId,
        async turn() {
          const modelResponse = await fetch(`${providerEnvironment.DEEPSEEK_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${providerEnvironment.DEEPSEEK_API_KEY}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "deepseek-v4-flash",
              stream: true,
              messages: [{ role: "user", content: "stable controlled request" }],
            }),
          });
          ok(modelResponse.ok);
          ok((await modelResponse.text()).includes("data: [DONE]"));
          const actionResponse = await fetch(childEnvironment[TOOL_BRIDGE_ENDPOINT_ENV]!, {
            method: "POST",
            headers: {
              authorization: `Bearer ${childEnvironment[TOOL_BRIDGE_CAPABILITY_ENV]}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              toolName: "record_intent_analysis",
              arguments: { analysis: { intentSummary: "replayed" } },
            }),
          });
          ok(actionResponse.ok);
          return { stopReason: "end_turn", committedContent: [] };
        },
        async cancel() {},
        async close() {},
      };
    },
  });
  const options = {
    runId: "run-controlled",
    leaseId: "lease-1",
    control,
    upstream: { apiKey: "parent", baseUrl: "https://deepseek.invalid", model: "deepseek-v4-flash" },
    createAdapter,
  };
  const first = await new DshModelBackend(options, dependencies).turn(request(), { aborted: false });
  const rebuilt = await new DshModelBackend(options, dependencies).turn(request(), { aborted: false });
  deepEqual(rebuilt, first);
  equal(upstreamCalls, 1);
  equal(control.usage.size, 1);
});
