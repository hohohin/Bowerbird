import { test } from "node:test";
import * as assert from "node:assert/strict";
import { chatUpstreamFetch, completeChatJob, consumeChatQueues, processChatJob } from "./runtime.ts";
import { DeepSeekBackend, DeepSeekBackendError } from "../providers/deepseek/backend.ts";
import { createHash } from "node:crypto";
import { chatFailure, validateChatInput } from "../../../cloud/supabase/functions/_shared/chat.ts";

test("a DSH slot waiting for desktop lets the standard slot finish other jobs", async () => {
  const stop = new AbortController(), waiting = Promise.withResolvers<void>(), served = Promise.withResolvers<void>();
  let plain = 0, dsh = 0;
  await consumeChatQueues(async claim => {
    if (claim.engine) { dsh++; return { job: { id: "DSH" } }; }
    await waiting.promise;
    return { job: { id: "ordinary" } };
  }, async job => {
    if (job.id === "DSH") { waiting.resolve(); await served.promise; return; }
    if (++plain === 2) { stop.abort(); served.resolve(); }
  }, "dsh-vps-v2", stop.signal);
  assert.equal(plain, 2); assert.equal(dsh, 1);
});

test("shared Agent chat preserves large input and result through the worker", async () => {
  const content = "长文🙂\n".repeat(400_000);
  const text = JSON.stringify({ messages: [{ role: "user", content }], tools_enabled: false });
  const job = { id: "large", lease_id: "lease", input_url: "https://fixture.invalid/request", input_hash: createHash("sha256").update(text).digest("hex") };
  const calls: Record<string, unknown>[] = [];
  await processChatJob(job, async body => { calls.push(body); return {}; }, { chat: async messages => {
    assert.equal(messages[1].content, content);
    return { message: { role: "assistant", content }, content, toolCalls: [], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } };
  } }, "fixture", async () => downloaded(text));
  assert.equal(calls.length, 1); assert.equal(calls[0].status, "succeeded");
  assert.equal((calls[0].result as { message: { content: string } }).message.content, content);
});

test("chat rejects images, forged tools and mismatched tool results", () => {
  assert.throws(() => validateChatInput({ messages: [{ role: "user", content: [{ type: "image_url" }] }] }));
  assert.throws(() => validateChatInput({ messages: [{ role: "user", content: "hi" }], tools: [] }));
  assert.throws(() => validateChatInput({ messages: [{ role: "tool", tool_call_id: "missing", content: "done" }] }));
});

test("one completion uses fixed tools, records usage and never executes the card tool", async () => {
  const input = validateChatInput({ messages: [{ role: "user", content: "创建分区" }] });
  const calls: unknown[] = [];
  const result = await completeChatJob(input, { chat: async (...args: unknown[]) => {
    calls.push(args);
    return { message: { role: "assistant", content: null, tool_calls: [{ id: "call1", type: "function", function: { name: "create_canvas_cards", arguments: "{}" } }] }, content: "", toolCalls: [], finishReason: "tool_calls", usage: { promptTokens: 10, completionTokens: 4 } };
  } });
  assert.equal(calls.length, 1);
  assert.equal(result.message.tool_calls?.[0].function.name, "create_canvas_cards");
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 4 });
  const [messages, tools] = calls[0] as Array<Array<Record<string, unknown>>>;
  assert.equal(messages[0].role, "system");
  assert.equal(tools.length, 1);
});

test("plain chat disables card tools and unknown transport is never retried", async () => {
  let count = 0;
  await assert.rejects(() => completeChatJob(validateChatInput({ messages: [{ role: "user", content: "hello" }], tools_enabled: false }), { chat: async (_messages: unknown, tools: unknown[]) => {
    count += 1; assert.deepEqual(tools, []); throw new Error("transport unknown");
  } }));
  assert.equal(count, 1);
});

test("tool history preserves matching calls but unknown tool output is rejected", () => {
  const call = { id: "call1", type: "function", function: { name: "create_canvas_cards", arguments: "{}" } };
  const messages = [{ role: "user", content: "创建" }, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: "call1", content: "已创建" }];
  assert.equal(validateChatInput({ messages }).messages.length, 3);
  assert.throws(() => validateChatInput({ messages: [{ role: "assistant", content: null, tool_calls: [{ ...call, function: { name: "shell", arguments: "{}" } }] }] }));
});

function downloaded(text: string): Response {
  let done = false;
  return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text,
    body: { getReader: () => ({ read: async () => { const ended = done; done = true; return { done: ended, value: new TextEncoder().encode(text) }; }, cancel: async () => {}, releaseLock: () => {} }) } };
}

test("classifies the original upstream response through Worker finish and public chat error", async () => {
  const input = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
  const job = { id: "sample", lease_id: "lease", input_url: "fixture:", input_hash: createHash("sha256").update(input).digest("hex") };
  const reply = (message: unknown) => downloaded(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
  const cases: [() => Promise<Response>, string, string, RegExp][] = [
    [async () => { throw Error("private bearer"); }, "outcome_unknown", "chat_upstream_connection", /连接中断/],
    [async () => ({ ...downloaded("private body"), ok: false, status: 503 }), "outcome_unknown", "chat_upstream_http_503", /HTTP 503/],
    [async () => ({ ...downloaded(""), ok: false, status: 429 }), "failed", "chat_upstream_http_429", /HTTP 429/],
    [async () => downloaded("broken json"), "outcome_unknown", "chat_reply_json", /无法解析/],
    [async () => ({ ...downloaded(""), text: async () => { throw Error("reset"); } }), "outcome_unknown", "chat_upstream_connection", /连接中断/],
    [async () => reply({ role: "assistant", content: null }), "outcome_unknown", "chat_reply_format", /格式无效/],
    [async () => reply({ role: "assistant", tool_calls: [{ id: "one", type: "function", function: { name: "create_canvas_cards", arguments: "{" } }] }), "outcome_unknown", "chat_reply_tool_arguments", /工具参数/],
  ];
  for (const [respond, status, code, reason] of cases) {
    let requests = 0;
    const model = new DeepSeekBackend({ apiKey: "test", baseUrl: "https://fixture.invalid", model: "deepseek-chat" }, chatUpstreamFetch(async () => { requests++; return respond(); }));
    const writes: Record<string, unknown>[] = [];
    await processChatJob(job, async body => { writes.push(body); return {}; }, model, "test", async () => downloaded(input));
    assert.equal(requests, 1);
    assert.deepEqual(writes, [{ action: "finish", job_id: job.id, lease_id: job.lease_id, status, error_code: code }]);
    const error = chatFailure(status, writes[0].error_code);
    assert.equal(error.code, code); assert.equal(error.recoverable, false); assert.ok(reason.test(error.message));
    assert.ok(!/private|稍后|重试/.test(error.message));
  }
  await processChatJob(job, async body => { assert.equal(body.error_code, "chat_upstream_timeout"); return {}; },
    { chat: async () => { throw new DeepSeekBackendError("deepseek_timeout"); } }, "test", async () => downloaded(input));
  assert.deepEqual(chatFailure("outcome_unknown", "private bearer"), chatFailure("outcome_unknown", null));
});

test("worker verifies input hash, returns result and usage through settlement", async () => {
  const text = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
  const calls: Record<string, unknown>[] = [];
  const job = { id: "job", lease_id: "lease", input_hash: createHash("sha256").update(text).digest("hex"), input_url: "https://signed.invalid/input" };
  await processChatJob(job, async body => { calls.push(body); return {}; }, { chat: async () => ({ message: { role: "assistant", content: "hello back" }, content: "hello back", toolCalls: [], finishReason: "stop", usage: { promptTokens: 12, completionTokens: 3 } }) }, "fixture-model", async () => downloaded(text));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "succeeded");
  assert.deepEqual((calls[0].result as Record<string, unknown>).usage, { input_tokens: 12, output_tokens: 3 });
  assert.equal((calls[0].result as Record<string, unknown>).model, "fixture-model");
});

test("invalid input never reaches provider; network ambiguity stays unknown without retry", async () => {
  let submitted = 0;
  const statuses: unknown[] = [];
  const text = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
  const job = { id: "job", lease_id: "lease", input_hash: "wrong", input_url: "https://signed.invalid/input" };
  const model = { chat: async () => { submitted++; throw new Error("timeout"); } };
  const control = async (body: Record<string, unknown>) => { statuses.push(body.status); return {}; };
  await processChatJob(job, control, model, "fixture", async () => downloaded(text));
  assert.equal(submitted, 0);
  await processChatJob({ ...job, input_hash: createHash("sha256").update(text).digest("hex") }, control, model, "fixture", async () => downloaded(text));
  assert.equal(submitted, 1);
  assert.deepEqual(statuses, ["failed", "outcome_unknown"]);
});

test("lost settlement response never reruns upstream or overwrites completion", async () => {
  const text = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
  let submitted = 0, settlements = 0;
  await assert.rejects(() => processChatJob({ id: "job", lease_id: "lease", input_hash: createHash("sha256").update(text).digest("hex"), input_url: "https://signed.invalid/input" },
    async () => { settlements++; throw new Error("lost finish response"); },
    { chat: async () => { submitted++; return { message: { role: "assistant", content: "done" }, content: "done", toolCalls: [], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }; } },
    "fixture", async () => downloaded(text)));
  assert.equal(submitted, 1); assert.equal(settlements, 1);
});
