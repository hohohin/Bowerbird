import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A source checkout exercises the upstream patch. An installed runtime exercises
// the separate, preloaded production bundle through its public adapter and SSE parser.
const installed = process.argv[2] === "--installed";
const root = resolve(process.argv[installed ? 3 : 2]);
const src = join(root, "packages/llm/llm-deepseek/src/translate.ts");
const modules = installed ? createRequire(join(root, "package.json")) : createRequire(src);
const { BlockAssembler, createUserMessage } = await import(pathToFileURL(modules.resolve("@deepseek-ai/dsh-llm")));
let translate;
if (installed) {
  const { DeepSeekAdapter, resolveAdapterOptions } = await import(pathToFileURL(modules.resolve("@deepseek-ai/dsh-llm-deepseek")));
  const adapter = new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ baseURL: "http://127.0.0.1:1/anthropic" }),
    resolveAuth: async () => ({ headers: { "x-api-key": "fixture" } }),
    resolveUserId: () => "fixture",
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  });
  translate = (events, _model, sessionId) => {
    globalThis.fetch = async (url) => {
      assert.equal(new URL(url).hostname, "127.0.0.1");
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const next = await events.next();
            if (next.done) controller.close();
            else controller.enqueue(new TextEncoder().encode(`event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`));
          } catch (error) { controller.error(error); }
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    return adapter.stream({
      provider: "deepseek-official", model: "deepseek-v4-flash", sessionId,
      messages: [createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "fixture" }] })],
    });
  };
} else {
  ({ translate } = await import(pathToFileURL(src)));
}
const session = "session-bowerbird-chat-" + "1".repeat(64);
const tool = "create_canvas_cards";

async function run(raw, { reason = "tool_use", name = tool, id = "call-1", scope = session, tail = "complete" } = {}) {
  async function* events() {
    yield { type: "message_start", message: { usage: { input_tokens: 7 } } };
    yield { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "sig" } };
    yield { type: "content_block_stop", index: 0 };
    yield { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name, input: {} } };
    for (const fragment of [raw.slice(0, 4), raw.slice(4)]) {
      yield { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: fragment } };
    }
    yield { type: "content_block_stop", index: 1 };
    if (tail === "abort") throw new Error("cancelled");
    if (tail === "disconnect") return;
    yield { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 3 } };
    yield { type: "message_stop" };
  }
  const assembler = new BlockAssembler();
  const chunks = [];
  for await (const chunk of translate(events(), "fixture", scope)) {
    assembler.push(chunk);
    chunks.push(chunk);
  }
  assert.equal(assembler.usage.totalTokens, 10);
  assert.equal(assembler.replayState.blocks[0].signature, "sig");
  assert.equal(chunks.filter(c => c.type === "tool-call-delta").map(c => c.argumentsDelta).join(""), raw);
  if (reason === "max_tokens") {
    assert.equal(assembler.blocks().length, 1);
    assert.equal(assembler.replayState.blocks.length, 1);
    return;
  }
  const toolBlock = assembler.blocks()[1];
  assert.equal(toolBlock.id, id);
  assert.deepEqual(toolBlock, chunks.find(c => c.type === "block-end" && c.index === 1).block);
  return toolBlock.arguments;
}

const valid = JSON.stringify({ cards: [{ title: '中文 } " \\', body: { text: "{}" } }] });
assert.equal(await run(valid), valid);
assert.equal(await run(valid + "} \r\n"), valid + " \r\n");
for (const raw of [valid + "}}", valid + "{}", valid + " text}", '[]}', '0}', '"str"}', '{"x"=1}', '{"x":"}', '{"x":1 "y":2}']) {
  await assert.rejects(run(raw), /invalid JSON/);
}
for (const opts of [{ name: "different" }, { scope: "other-session" }, { reason: "end_turn" }]) {
  await assert.rejects(run(valid + "}", opts), /invalid JSON/);
}
await assert.rejects(run(valid + "}", { id: "" }), /empty tool identity/);
await assert.rejects(run(valid + "}", { tail: "abort" }), /cancelled|transport failed/);
await assert.rejects(run(valid + "}", { tail: "disconnect" }), /before message_stop/);
await run(valid + "}", { reason: "max_tokens" });
console.log("DSH translator and assembler boundary checks passed.");

export { run };
