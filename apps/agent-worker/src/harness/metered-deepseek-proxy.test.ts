import { deepEqual, equal, notEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import {
  AgentControlError,
  type PreparedToolCall,
  type RegisteredAgentArtifact,
} from "../control-plane/agent-control-client.ts";
import type { DurableToolIdentity } from "../kernel/durable-tool-dispatcher.ts";
import {
  startMeteredDeepSeekProxy,
  type MeteredDeepSeekProxyControl,
} from "./metered-deepseek-proxy.ts";

type Usage = {
  callId: string;
  inputUnits: number;
  outputUnits: number;
  model: string;
};

class FakeControl implements MeteredDeepSeekProxyControl {
  readonly calls = new Map<string, PreparedToolCall & { argsHash: string; toolName: string; safeErrorCode?: string }>();
  readonly artifacts = new Map<string, { artifact: RegisteredAgentArtifact; bytes: Uint8Array }>();
  readonly usage = new Map<string, Usage>();

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

  async markToolSubmitted(args: { runId: string; leaseId: string; callId: string; providerRequestId?: string }): Promise<PreparedToolCall> {
    const existing = this.calls.get(args.callId);
    if (!existing) throw new Error("missing_call");
    const updated = { ...existing, status: "submitted" as const, providerRequestId: args.providerRequestId };
    this.calls.set(args.callId, updated);
    return updated;
  }

  async completeTool(args: {
    runId: string;
    leaseId: string;
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
    leaseId: string;
    sourceCallId: string;
    stepId: string;
    bytes: Uint8Array;
    sha256: string;
  }): Promise<RegisteredAgentArtifact> {
    const artifact: RegisteredAgentArtifact = {
      artifactId: `artifact-${args.sourceCallId}`,
      conversationId: "conversation-proxy",
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
    const callId = url.replace("memory://", "");
    const stored = this.artifacts.get(callId);
    if (!stored) throw new Error("artifact_missing");
    return Uint8Array.from(stored.bytes);
  }

  async recordUsage(args: {
    callId: string;
    model: string;
    inputUnits: number;
    outputUnits: number;
  }): Promise<void> {
    const usage = {
      callId: args.callId,
      model: args.model,
      inputUnits: args.inputUnits,
      outputUnits: args.outputUnits,
    };
    const existing = this.usage.get(args.callId);
    if (existing) deepEqual(existing, usage);
    else this.usage.set(args.callId, usage);
  }
}

const requestBody = {
  model: "deepseek-v4-flash",
  stream: true,
  messages: [{ role: "user", content: "plan current run" }],
  tools: [],
};

function sse(withUsage = true): string {
  return `data: ${JSON.stringify({
    id: "provider-request-1",
    choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    ...(withUsage ? { usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 } } : {}),
  })}\n\ndata: [DONE]\n\n`;
}

function largeSse(): string {
  const events = Array.from({ length: 512 }, (_, index) => `data: ${JSON.stringify({
    id: "provider-request-large",
    choices: [{ index: 0, delta: { content: "结构化计划".repeat(8) }, finish_reason: null }],
    ...(index === 511 ? { usage: { prompt_tokens: 3043, completion_tokens: 512, total_tokens: 3555 } } : {}),
  })}`);
  return `${events.join("\n\n")}\n\ndata: [DONE]\n\n`;
}

function htmlExecutionSse(): string {
  const events = Array.from({ length: 4096 }, (_, index) => `data: ${JSON.stringify({
    id: "provider-request-html",
    choices: [{ index: 0, delta: { content: "<div class=\\\"panel\\\">产品</div>" }, finish_reason: null }],
    ...(index === 4095 ? { usage: { prompt_tokens: 4096, completion_tokens: 4096, total_tokens: 8192 } } : {}),
  })}`);
  return `${events.join("\n\n")}\n\ndata: [DONE]\n\n`;
}

async function proxyRequest(environment: Readonly<Record<string, string>>, body: unknown = requestBody, key?: string) {
  return await fetch(`${environment.DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key ?? environment.DEEPSEEK_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function assertResponseBodyRejected(body: string, safeErrorCode: string): Promise<void> {
  const control = new FakeControl();
  let upstreamCalls = 0;
  const proxy = await startMeteredDeepSeekProxy({
    runId: "run-proxy",
    leaseId: "lease-proxy",
    phase: "compose_plan",
    control,
    upstream: { apiKey: "real", baseUrl: "http://127.0.0.1:43123", model: "deepseek-v4-flash" },
    allowInsecureLoopback: true,
    async fetch() {
      upstreamCalls += 1;
      return { ok: true, status: 200, async text() { return body; } };
    },
  });
  try {
    const environment = proxy.childEnvironment();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await proxyRequest(environment);
      equal(response.status, 502);
      equal(await response.text(), JSON.stringify({ error: { code: safeErrorCode } }));
    }
    equal(upstreamCalls, 1);
    equal([...control.calls.values()][0]?.status, "outcome_unknown");
    equal([...control.calls.values()][0]?.safeErrorCode, safeErrorCode);
    deepEqual([...control.usage.values()].map(({ inputUnits, outputUnits }) => ({ inputUnits, outputUnits })), [
      { inputUnits: 0, outputUnits: 0 },
    ]);
  } finally {
    await proxy.close();
  }
}

test("metered DeepSeek proxy keeps the real key in parent, records exact usage and replays one response", async () => {
  const control = new FakeControl();
  let upstreamCalls = 0;
  const proxy = await startMeteredDeepSeekProxy({
    runId: "run-proxy",
    leaseId: "lease-proxy",
    phase: "compose_plan",
    control,
    upstream: {
      apiKey: "real-parent-key",
      baseUrl: "http://127.0.0.1:43123",
      model: "deepseek-v4-flash",
    },
    allowInsecureLoopback: true,
    async fetch(url, init) {
      upstreamCalls += 1;
      equal(url, "http://127.0.0.1:43123/chat/completions");
      equal(init.headers.authorization, "Bearer real-parent-key");
      return { ok: true, status: 200, async text() { return sse(); } };
    },
  });
  try {
    const environment = proxy.childEnvironment();
    notEqual(environment.DEEPSEEK_API_KEY, "real-parent-key");
    equal(/^[0-9a-f]{64}$/.test(environment.DEEPSEEK_API_KEY), true);
    equal(Object.keys(environment).sort().join(","), "DEEPSEEK_API_KEY,DEEPSEEK_BASE_URL");

    const first = await proxyRequest(environment);
    equal(first.status, 200);
    equal(await first.text(), sse());
    const second = await proxyRequest(environment);
    equal(second.status, 200);
    equal(await second.text(), sse());

    equal(upstreamCalls, 1);
    equal(control.calls.size, 1);
    equal([...control.calls.values()][0]?.status, "succeeded");
    deepEqual([...control.usage.values()], [{
      callId: [...control.usage.keys()][0],
      model: "deepseek-v4-flash",
      inputUnits: 21,
      outputUnits: 7,
    }]);
  } finally {
    await proxy.close();
  }
});

test("metered DeepSeek proxy rejects unscoped requests before ledger or upstream", async () => {
  const control = new FakeControl();
  let upstreamCalls = 0;
  const proxy = await startMeteredDeepSeekProxy({
    runId: "run-proxy",
    leaseId: "lease-proxy",
    phase: "compose_plan",
    control,
    upstream: { apiKey: "real", baseUrl: "http://127.0.0.1:43123", model: "deepseek-v4-flash" },
    allowInsecureLoopback: true,
    async fetch() {
      upstreamCalls += 1;
      return { ok: true, status: 200, async text() { return sse(); } };
    },
  });
  try {
    const environment = proxy.childEnvironment();
    equal((await proxyRequest(environment, requestBody, "wrong")).status, 401);
    equal((await proxyRequest(environment, { ...requestBody, model: "foreign-model" })).status, 400);
    equal((await proxyRequest(environment, {
      ...requestBody,
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }],
    })).status, 400);
    equal(upstreamCalls, 0);
    equal(control.calls.size, 0);
  } finally {
    await proxy.close();
  }
});

test("metered DeepSeek proxy parks an incomplete usage outcome and never repeats upstream", async () => {
  const control = new FakeControl();
  let upstreamCalls = 0;
  const proxy = await startMeteredDeepSeekProxy({
    runId: "run-proxy",
    leaseId: "lease-proxy",
    phase: "compose_plan",
    control,
    upstream: { apiKey: "real", baseUrl: "http://127.0.0.1:43123", model: "deepseek-v4-flash" },
    allowInsecureLoopback: true,
    async fetch() {
      upstreamCalls += 1;
      return { ok: true, status: 200, async text() { return sse(false); } };
    },
  });
  try {
    const environment = proxy.childEnvironment();
    equal((await proxyRequest(environment)).status, 502);
    equal((await proxyRequest(environment)).status, 502);
    equal(upstreamCalls, 1);
    equal(control.calls.size, 1);
    equal([...control.calls.values()][0]?.status, "outcome_unknown");
    deepEqual([...control.usage.values()].map(({ inputUnits, outputUnits }) => ({ inputUnits, outputUnits })), [
      { inputUnits: 0, outputUnits: 0 },
    ]);
    ok([...control.calls.values()][0]?.safeErrorCode);
  } finally {
    await proxy.close();
  }
});

test("metered DeepSeek proxy preserves a definitive upstream HTTP status without leaking its body", async () => {
  const control = new FakeControl();
  let upstreamCalls = 0;
  const proxy = await startMeteredDeepSeekProxy({
    runId: "run-proxy",
    leaseId: "lease-proxy",
    phase: "compose_plan",
    control,
    upstream: { apiKey: "real", baseUrl: "http://127.0.0.1:43123", model: "deepseek-v4-flash" },
    allowInsecureLoopback: true,
    async fetch() {
      upstreamCalls += 1;
      return { ok: false, status: 429, async text() { return "provider secret body"; } };
    },
  });
  try {
    const response = await proxyRequest(proxy.childEnvironment());
    equal(response.status, 429);
    equal(await response.text(), JSON.stringify({ error: { code: "deepseek_http_429" } }));
    equal(upstreamCalls, 1);
    equal([...control.calls.values()][0]?.status, "failed");
    equal([...control.calls.values()][0]?.safeErrorCode, "deepseek_http_429");
  } finally {
    await proxy.close();
  }
});

test("metered DeepSeek proxy retries one received gateway failure inside the same durable call", async () => {
  const control = new FakeControl();
  let upstreamCalls = 0;
  const proxy = await startMeteredDeepSeekProxy({
    runId: "run-proxy",
    leaseId: "lease-proxy",
    phase: "compose_plan",
    control,
    upstream: { apiKey: "real", baseUrl: "http://127.0.0.1:43123", model: "deepseek-v4-flash" },
    allowInsecureLoopback: true,
    async fetch() {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        return { ok: false, status: 502, async text() { return "provider secret body"; } };
      }
      return { ok: true, status: 200, async text() { return sse(); } };
    },
  });
  try {
    const response = await proxyRequest(proxy.childEnvironment());
    equal(response.status, 200);
    equal(await response.text(), sse());
    equal(upstreamCalls, 2);
    equal(control.calls.size, 1);
    equal([...control.calls.values()][0]?.status, "succeeded");
    equal(control.usage.size, 1);
  } finally {
    await proxy.close();
  }
});

test("metered DeepSeek proxy accepts a terminal DONE line without a trailing blank line", async () => {
  const control = new FakeControl();
  const body = sse().replace(/\n\n$/, "");
  const proxy = await startMeteredDeepSeekProxy({
    runId: "run-proxy",
    leaseId: "lease-proxy",
    phase: "compose_plan",
    control,
    upstream: { apiKey: "real", baseUrl: "http://127.0.0.1:43123", model: "deepseek-v4-flash" },
    allowInsecureLoopback: true,
    async fetch() {
      return { ok: true, status: 200, async text() { return body; } };
    },
  });
  try {
    const response = await proxyRequest(proxy.childEnvironment());
    equal(response.status, 200);
    equal(await response.text(), body);
    equal([...control.calls.values()][0]?.status, "succeeded");
    deepEqual([...control.usage.values()].map(({ inputUnits, outputUnits }) => ({ inputUnits, outputUnits })), [
      { inputUnits: 21, outputUnits: 7 },
    ]);
  } finally {
    await proxy.close();
  }
});

test("metered DeepSeek proxy classifies a response body read failure and preserves it on replay", async () => {
  const control = new FakeControl();
  let upstreamCalls = 0;
  const proxy = await startMeteredDeepSeekProxy({
    runId: "run-proxy",
    leaseId: "lease-proxy",
    phase: "compose_plan",
    control,
    upstream: { apiKey: "real", baseUrl: "http://127.0.0.1:43123", model: "deepseek-v4-flash" },
    allowInsecureLoopback: true,
    async fetch() {
      upstreamCalls += 1;
      return {
        ok: true,
        status: 200,
        async text() { throw new Error("unsafe transport detail"); },
      };
    },
  });
  try {
    const environment = proxy.childEnvironment();
    const first = await proxyRequest(environment);
    equal(first.status, 502);
    equal(await first.text(), JSON.stringify({ error: { code: "deepseek_transport_unknown" } }));
    const second = await proxyRequest(environment);
    equal(second.status, 502);
    equal(await second.text(), JSON.stringify({ error: { code: "deepseek_transport_unknown" } }));
    equal(upstreamCalls, 1);
    equal([...control.calls.values()][0]?.safeErrorCode, "deepseek_transport_unknown");
    deepEqual([...control.usage.values()].map(({ inputUnits, outputUnits }) => ({ inputUnits, outputUnits })), [
      { inputUnits: 0, outputUnits: 0 },
    ]);
  } finally {
    await proxy.close();
  }
});

test("metered DeepSeek proxy classifies and preserves an empty response body", async () => {
  await assertResponseBodyRejected("", "deepseek_response_empty");
});

test("metered DeepSeek proxy classifies and preserves a planning response body over 2 MiB", async () => {
  await assertResponseBodyRejected("x".repeat(2 * 1024 * 1024 + 1), "deepseek_response_too_large");
});

test("metered DeepSeek proxy accepts compressed planning SSE over the legacy 512 KiB limit", async () => {
  const control = new FakeControl();
  const body = htmlExecutionSse();
  ok(new TextEncoder().encode(body).byteLength > 512 * 1024);
  ok(new TextEncoder().encode(body).byteLength < 2 * 1024 * 1024);
  const proxy = await startMeteredDeepSeekProxy({
    runId: "run-proxy",
    leaseId: "lease-proxy",
    phase: "compose_plan",
    control,
    upstream: { apiKey: "real", baseUrl: "http://127.0.0.1:43123", model: "deepseek-v4-flash" },
    allowInsecureLoopback: true,
    async fetch() {
      return { ok: true, status: 200, async text() { return body; } };
    },
  });
  try {
    const response = await proxyRequest(proxy.childEnvironment());
    equal(response.status, 200);
    equal(await response.text(), body);
    const stored = [...control.artifacts.values()][0];
    ok(stored);
    ok(stored.bytes.byteLength < 64 * 1024);
  } finally {
    await proxy.close();
  }
});

test("metered DeepSeek proxy accepts bounded HTML execution SSE over the planning limit", async () => {
  const control = new FakeControl();
  const body = htmlExecutionSse();
  ok(new TextEncoder().encode(body).byteLength > 512 * 1024);
  ok(new TextEncoder().encode(body).byteLength < 4 * 1024 * 1024);
  let upstreamCalls = 0;
  const proxy = await startMeteredDeepSeekProxy({
    runId: "run-proxy",
    leaseId: "lease-proxy",
    phase: "execute_approved_plan",
    control,
    upstream: { apiKey: "real", baseUrl: "http://127.0.0.1:43123", model: "deepseek-v4-flash" },
    allowInsecureLoopback: true,
    async fetch() {
      upstreamCalls += 1;
      return { ok: true, status: 200, async text() { return body; } };
    },
  });
  try {
    const response = await proxyRequest(proxy.childEnvironment());
    equal(response.status, 200);
    equal(await response.text(), body);
    equal(upstreamCalls, 1);
    const stored = [...control.artifacts.values()][0];
    ok(stored);
    ok(stored.bytes.byteLength < 64 * 1024);
  } finally {
    await proxy.close();
  }
});

test("metered DeepSeek proxy rejects a new model request after the bounded turn budget", async () => {
  const control = new FakeControl();
  let upstreamCalls = 0;
  const proxy = await startMeteredDeepSeekProxy({
    runId: "run-proxy",
    leaseId: "lease-proxy",
    phase: "execute_approved_plan",
    maxModelTurns: 2,
    control,
    upstream: { apiKey: "real", baseUrl: "http://127.0.0.1:43123", model: "deepseek-v4-flash" },
    allowInsecureLoopback: true,
    async fetch() {
      upstreamCalls += 1;
      return { ok: true, status: 200, async text() { return sse(); } };
    },
  });
  try {
    for (let index = 0; index < 2; index += 1) {
      const response = await proxyRequest(proxy.childEnvironment(), {
        ...requestBody,
        messages: [{ role: "user", content: `turn-${index}` }],
      });
      equal(response.status, 200);
    }
    const rejected = await proxyRequest(proxy.childEnvironment(), {
      ...requestBody,
      messages: [{ role: "user", content: "turn-2" }],
    });
    equal(rejected.status, 429);
    equal(await rejected.text(), JSON.stringify({ error: { code: "model_turn_budget_exhausted" } }));
    equal(upstreamCalls, 2);
  } finally {
    await proxy.close();
  }
});

test("metered DeepSeek proxy compresses and replays a bounded SSE larger than the diagnostic artifact limit", async () => {
  const control = new FakeControl();
  const body = largeSse();
  ok(new TextEncoder().encode(body).byteLength > 64 * 1024);
  let upstreamCalls = 0;
  const proxy = await startMeteredDeepSeekProxy({
    runId: "run-proxy",
    leaseId: "lease-proxy",
    phase: "compose_plan",
    control,
    upstream: { apiKey: "real", baseUrl: "http://127.0.0.1:43123", model: "deepseek-v4-flash" },
    allowInsecureLoopback: true,
    async fetch() {
      upstreamCalls += 1;
      return { ok: true, status: 200, async text() { return body; } };
    },
  });
  try {
    const environment = proxy.childEnvironment();
    const first = await proxyRequest(environment);
    equal(first.status, 200);
    equal(await first.text(), body);
    const second = await proxyRequest(environment);
    equal(second.status, 200);
    equal(await second.text(), body);
    equal(upstreamCalls, 1);
    const stored = [...control.artifacts.values()][0];
    ok(stored);
    ok(stored.bytes.byteLength < 64 * 1024);
    const persisted = JSON.parse(new TextDecoder().decode(stored.bytes));
    equal(persisted.schemaVersion, 2);
    equal(persisted.bodyEncoding, "gzip+base64");
    equal(persisted.bodyBytes, new TextEncoder().encode(body).byteLength);
  } finally {
    await proxy.close();
  }
});
