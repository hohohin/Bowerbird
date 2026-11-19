import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workerRoot = process.env.BOWERBIRD_CHAT_TEST_WORKER ?? resolve(import.meta.dirname, "../../../../../apps/agent-worker");
const profile = process.env.BOWERBIRD_DSH_PROFILE_TEMPLATE ?? resolve(import.meta.dirname, "..");
const { processChatJob } = await import(pathToFileURL(join(workerRoot, "src/cloud-chat/runtime.ts")).href);

const engine = "dsh-vps-v1";
const receipt = { success: true, created_count: 1 };
const args = { cards: [{ id: "a", title: "草稿", kind: "content", text: "正文" }] };
function completion(delta, finish_reason) {
  const event = { choices: [{ delta, finish_reason, index: 0 }], usage: { prompt_tokens: 101, completion_tokens: 7 } };
  return { ok: true, status: 200, text: async () => 'data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n' };
}

async function run({ skill, fetch, onControl, turnTimeoutMs }) {
  const root = mkdtempSync(join(process.env.BOWERBIRD_DSH_RUNTIME_ROOT ?? tmpdir(), "bowerbird-dsh-chat-"));
  const calls = [], requests = [];
  const input = JSON.stringify({ engine, skill, tools_enabled: !skill,
    messages: [{ role: "user", content: "历史主题" }, { role: "assistant", content: "已知主题" },
      { role: "user", content: skill ? "请润色当前段落" : "请创建一张内容卡片。" }] });
  try {
    await processChatJob({ engine, id: "job", lease_id: "lease", input_hash: createHash("sha256").update(input).digest("hex"), input_url: "fixture:" }, async body => {
      calls.push(body);
      assert.equal(body.job_id, "job"); assert.equal(body.lease_id, "lease");
      return onControl?.(body, requests.length) ?? { active: true, ...(body.action === "dsh_poll" && body.call_id ? { result: receipt } : {}) };
    }, { async chat() { assert.fail("DSH must own this turn"); } }, "legacy", async () => new Response(input), {
      runtimeRoot: root, profileTemplateDir: profile, upstream: { model: "deepseek-flash", baseUrl: "https://fixture.invalid", apiKey: "parent-only" },
      toolPollMs: 20, heartbeatMs: 100, turnTimeoutMs,
      fetch: async (_url, init) => {
        const request = JSON.parse(init.body);
        requests.push(request);
        return fetch(request, requests.length, init.signal);
      },
    });
    assert.deepEqual(readdirSync(root), [], "the private runtime home was removed");
    return { calls, requests, finish: calls.find(call => call.action === "finish") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("real DSH session submits one card request, consumes desktop receipt, returns final reply with total usage", async () => {
  const { calls, requests, finish } = await run({ fetch(request, index) {
    assert.deepEqual(request.tools.map(tool => tool.function.name), ["create_canvas_cards"]);
    assert.equal(request.messages.filter(message => message.content === "历史主题").length, 1);
    if (index === 1) return completion({ content: "内部进度", tool_calls: [{ index: 0, id: "call-card", type: "function",
      function: { name: "create_canvas_cards", arguments: JSON.stringify(args) } }] }, "tool_calls");
    assert.match(JSON.stringify(request.messages.at(-1)), /created_count/);
    return completion({ content: "已创建一张内容卡片。" }, "stop");
  } });
  assert.equal(requests.length, 2);
  const published = calls.filter(call => call.action === "tool_request");
  assert.equal(published.length, 1); assert.deepEqual(published[0].arguments, args);
  assert.ok(calls.some(call => call.action === "dsh_poll" && call.call_id === published[0].call_id));
  assert.deepEqual(finish?.result, { model: "deepseek-flash", usage: { input_tokens: 202, output_tokens: 14 },
    message: { role: "assistant", content: "已创建一张内容卡片。" } });
});

for (const skill of [{ id: "text-editor" }, { id: "h3-video-prompt", parameters: { seconds: 8, ratio: "9:16", mode: "text", firstFrameCount: 0, lastFrameCount: 0 } }]) {
  test("real DSH privately loads " + skill.id + " with no exposed tools", async () => {
    const { calls, requests, finish } = await run({ skill, fetch(request) {
      assert.equal(request.tools?.length ?? 0, 0);
      assert.ok(request.messages.some(message => message.role === "system" && message.content.includes("name: " + skill.id)));
      return completion({ content: "最终正文" }, "stop");
    } });
    assert.equal(requests.length, 1);
    assert.equal(finish?.result?.message?.content, "最终正文");
    assert.doesNotMatch(JSON.stringify(calls), /SKILL|name: |请润色当前段落|历史主题/);
  });
}

test("upstream failure never replays a model call", async () => {
  const { requests, finish } = await run({ fetch: () => ({ ok: false, status: 503, text: async () => "private" }) });
  assert.equal(requests.length, 1);
  assert.equal(finish?.error_code, "chat_upstream_http_503");
});

for (const afterCard of [false, true]) {
  test(afterCard ? "a 4xx after an acknowledged card preserves pending settlement" : "a first-call 4xx is a definitive rejection", async () => {
    const { calls, requests, finish } = await run({ fetch(request, index) {
      if (afterCard && index === 1) return completion({ tool_calls: [{ index: 0, id: "ack-card", type: "function",
        function: { name: "create_canvas_cards", arguments: JSON.stringify(args) } }] }, "tool_calls");
      if (afterCard) assert.match(JSON.stringify(request.messages.at(-1)), /created_count/);
      return { ok: false, status: 429, text: async () => "rate limit" };
    } });
    assert.equal(requests.length, afterCard ? 2 : 1);
    assert.equal(calls.filter(call => call.action === "tool_request").length, afterCard ? 1 : 0);
    assert.equal(calls.filter(call => call.action === "finish").length, 1);
    assert.equal(finish.engine, engine);
    assert.equal(finish.error_code, "chat_upstream_http_429");
    assert.equal(finish.status, afterCard ? "outcome_unknown" : "failed");
  });
}

test("a model cannot start a second completion after requesting an unavailable tool", async () => {
  const { calls, requests, finish } = await run({ fetch: () => completion({ tool_calls: [
    { index: 0, id: "unknown-call", type: "function", function: { name: "not_registered", arguments: "{}" } },
  ] }, "tool_calls") });
  assert.equal(requests.length, 1);
  assert.equal(calls.some(call => call.action === "tool_request"), false);
  assert.notEqual(finish?.status, "succeeded");
});

test("losing the lease interrupts an in-flight real DSH turn and prevents finish", async () => {
  let aborted = false;
  const { requests, finish } = await run({
    onControl(body, count) { if (body.action === "dsh_poll" && count) return { active: false }; },
    fetch: (_request, _index, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); })),
  });
  assert.equal(requests.length, 1); assert.equal(aborted, true); assert.equal(finish, undefined);
});

test("a desktop that never acknowledges a card releases the DSH slot at its deadline without replay", async () => {
  const { calls, requests, finish } = await run({
    turnTimeoutMs: 8000,
    onControl: () => ({ active: true }),
    fetch: () => completion({ tool_calls: [{ index: 0, id: "pending-call", type: "function",
      function: { name: "create_canvas_cards", arguments: JSON.stringify(args) } }] }, "tool_calls"),
  });
  assert.equal(requests.length, 1);
  assert.equal(calls.filter(call => call.action === "tool_request").length, 1);
  assert.equal(finish?.status, "outcome_unknown"); assert.equal(finish?.error_code, "chat_dsh_deadline");
  assert.equal(finish.engine, engine);
});
