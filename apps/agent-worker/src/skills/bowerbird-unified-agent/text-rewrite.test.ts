import { test } from "node:test";
import { deepEqual, equal, throws, ok } from "node:assert/strict";
import { observeTextRewriteStream, parseTextRewriteResult, textRewritePreview, textRewritePrompt } from "./text-rewrite.ts";
import { validateUnifiedAgentPlanningInput } from "./schemas.ts";

test("long multilingual source and complete result survive JSON escaping", () => {
  const source = '中文🙂\\"\n'.repeat(10000) + "末尾标记";
  const input = validateUnifiedAgentPlanningInput({ schemaVersion: 1, goal: "原样返回", textRewrite: { source } });
  equal(input.textRewrite?.source, source);
  ok(textRewritePrompt(input.goal, source).includes(JSON.stringify(source)));
  ok(!textRewritePrompt(input.goal, source).includes("16000"));
  equal(parseTextRewriteResult({ stopReason: "end_turn", committedContent: [{ type: "text", text: JSON.stringify({ schemaVersion: 1, text: source }) }] }), source);
});

test("text editing keeps instruction and untrusted source separate, preserves line breaks", () => {
  const source = "文字：朱砂痣\n左上竖排";
  const input = validateUnifiedAgentPlanningInput({ schemaVersion: 1, goal: "替换为春山可望", textRewrite: { source } });
  equal(input.textRewrite?.source, source);
  ok(textRewritePrompt(input.goal, source).includes('"untrustedSource"'));
  equal(parseTextRewriteResult({ stopReason: "end_turn", committedContent: [{ type: "text", text: JSON.stringify({ schemaVersion: 1, text: "文字：春山可望\n左上竖排" }) }] }), "文字：春山可望\n左上竖排");
});

test("text mode rejects empty, malformed, or mixed media inputs", () => {
  for (const textRewrite of [{ source: " " }, { source: "a", shell: "anything" }, []]) {
    throws(() => validateUnifiedAgentPlanningInput({ schemaVersion: 1, goal: "改写", textRewrite }), /text_input_invalid/);
  }
  throws(() => validateUnifiedAgentPlanningInput({ schemaVersion: 1, goal: "改写", textRewrite: { source: "a" }, references: [{}] }), /text_input_invalid/);
});

test("only a structured completed answer is accepted, never commentary or partial output", () => {
  for (const text of ["已为你改写", "```json\n{}\n```", '{"schemaVersion":1,"text":""}', '{"schemaVersion":1,"text":"ok","tool":"generate_image"}']) {
    throws(() => parseTextRewriteResult({ stopReason: "end_turn", committedContent: [{ type: "text", text }] }), /text_result_invalid/);
  }
  throws(() => parseTextRewriteResult({ stopReason: "cancelled", committedContent: [{ type: "text", text: '{"schemaVersion":1,"text":"ok"}' }] }), /text_result_invalid/);
});
test("writing preview decodes complete JSON characters and ignores partial framing", () => {
  equal(textRewritePreview('{"schemaVersion":1,"text":"街道\\n灯\\uD83D'), "街道\n灯");
  equal(textRewritePreview('{"schemaVersion":1,"text":"街道\\n灯\\uD83D\\uDD26\\'), "街道\n灯🔦");
  equal(textRewritePreview('{"untrustedSource":"不显示"}'), "");
});

test("upstream text preview observes assistant content before the durable SSE response ends", async () => {
  const event = (choices: unknown[]) => `data: ${JSON.stringify({ choices })}\r\n\r\n`;
  const first = event([{ index: 0, delta: { role: "assistant", reasoning_content: "不显示", content: "街道💡" } }]);
  const terminal = event([{ index: 1, delta: { content: "其他回复" } }, { index: 0, delta: { role: "tool", content: "非正文" } }]) +
    event([{ index: 0, delta: { content: "继续写" } }]) + "data: [DONE]\n\n";
  const encoder = new TextEncoder();
  const firstBytes = [...encoder.encode(first)];
  const observed: string[] = [];
  let terminalSent = false;
  const upstream = { ok: true, status: 200, async text() { throw new Error("reader should be used"); }, body: { getReader() { return {
    async read() {
      const byte = firstBytes.shift();
      if (byte !== undefined) return { done: false, value: Uint8Array.of(byte) };
      if (terminalSent) return { done: true, value: new Uint8Array() };
      deepEqual(observed, ["街道💡"]);
      terminalSent = true;
      return { done: false, value: encoder.encode(terminal) };
    },
    async cancel() {}, releaseLock() {},
  }; } } };
  const response = observeTextRewriteStream(upstream, text => observed.push(text));
  equal(await response.text(), first + terminal);
  deepEqual(observed, ["街道💡", "继续写"]);
});
