import { test } from "node:test";
import { equal, throws, ok } from "node:assert/strict";
import { parseTextRewriteResult, textRewritePrompt } from "./text-rewrite.ts";
import { validateUnifiedAgentPlanningInput } from "./schemas.ts";

test("text editing keeps instruction and untrusted source separate, preserves line breaks", () => {
  const source = "文字：朱砂痣\n左上竖排";
  const input = validateUnifiedAgentPlanningInput({ schemaVersion: 1, goal: "替换为春山可望", textRewrite: { source } });
  equal(input.textRewrite?.source, source);
  ok(textRewritePrompt(input.goal, source).includes('"untrustedSource"'));
  equal(parseTextRewriteResult({ stopReason: "end_turn", committedContent: [{ type: "text", text: JSON.stringify({ schemaVersion: 1, text: "文字：春山可望\n左上竖排" }) }] }), "文字：春山可望\n左上竖排");
});

test("text mode rejects empty, oversized, or mixed media inputs", () => {
  for (const textRewrite of [{ source: " " }, { source: "x".repeat(16001) }, { source: "a", shell: "anything" }, []]) {
    throws(() => validateUnifiedAgentPlanningInput({ schemaVersion: 1, goal: "改写", textRewrite }), /text_input_invalid/);
  }
  throws(() => validateUnifiedAgentPlanningInput({ schemaVersion: 1, goal: "改写", textRewrite: { source: "a" }, references: [{}] }), /text_input_invalid/);
});

test("only a bounded structured completed answer is accepted, never commentary or partial output", () => {
  for (const text of ["已为你改写", "```json\n{}\n```", '{"schemaVersion":1,"text":""}', JSON.stringify({schemaVersion:1,text:"x".repeat(16001)}), '{"schemaVersion":1,"text":"ok","tool":"generate_image"}']) {
    throws(() => parseTextRewriteResult({ stopReason: "end_turn", committedContent: [{ type: "text", text }] }), /text_result_invalid/);
  }
  throws(() => parseTextRewriteResult({ stopReason: "cancelled", committedContent: [{ type: "text", text: '{"schemaVersion":1,"text":"ok"}' }] }), /text_result_invalid/);
});
