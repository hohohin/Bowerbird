import { test } from "node:test";
import * as assert from "node:assert/strict";
import { completeChatJob, processChatJob } from "./runtime.ts";
import { createHash } from "node:crypto";
import { validateChatInput } from "../../../cloud/supabase/functions/_shared/chat.ts";

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
