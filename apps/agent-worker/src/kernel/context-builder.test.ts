import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import type { ContextBlock } from "../contracts/model.ts";
import { buildModelContext } from "./context-builder.ts";
import { canonicalJson, sha256Hex } from "./tool-ledger.ts";

function block(
  kind: ContextBlock["kind"],
  source: string,
  trust: ContextBlock["trust"],
  body: unknown,
): ContextBlock {
  return { kind, source, trust, contentHash: sha256Hex(canonicalJson(body)), body };
}

const goal = () => block("user_goal", "user", "untrusted", { intentPrompt: "只换背景" });
const manifest = () => block("input_manifest", "run-input", "untrusted", { references: [], ratio: "1:1" });

test("context builder uses the fixed trust-bound kind order", () => {
  const result = buildModelContext([
    block("tool_result", "call-1", "approved", { value: 1 }),
    manifest(),
    block("system_policy", "kernel", "system", { rule: "deny shell" }),
    goal(),
    block("budget", "ledger", "approved", { remaining: 5 }),
    block("preference_capsule", "desktop:project-1", "untrusted", { preferred: [] }),
  ], { maxTokens: 10_000 });

  deepEqual(result.blocks.map((item) => item.kind), [
    "system_policy",
    "budget",
    "user_goal",
    "input_manifest",
    "preference_capsule",
    "tool_result",
  ]);
  equal(result.compacted, false);
});

test("context builder rejects provenance or trust escalation", () => {
  throws(
    () => buildModelContext([{ ...goal(), contentHash: "bad" }], { maxTokens: 1_000 }),
    /context_block_hash_invalid/,
  );
  throws(
    () => buildModelContext([{ ...goal(), trust: "system" }], { maxTokens: 1_000 }),
    /context_block_trust_invalid:user_goal/,
  );
});

test("compaction preserves required text-only inputs and source hashes", () => {
  const preference = block("preference_capsule", "desktop:project-1", "untrusted", {
    preferred: [{ category: "palette", value: `低饱和蓝绿色${"色".repeat(2_000)}` }],
    avoid: [{ category: "style", value: "高饱和霓虹" }],
    workflow: [],
  });
  const result = buildModelContext([preference, manifest(), goal()], { maxTokens: 1_000 });

  equal(result.compacted, true);
  deepEqual(result.blocks.slice(0, 2).map((item) => item.kind), ["user_goal", "input_manifest"]);
  const summary = result.blocks.at(-1);
  equal(summary?.kind, "compaction_summary");
  equal(summary?.trust, "untrusted");
  ok(JSON.stringify(summary?.body).includes(preference.contentHash));
  ok(result.compactedFacts.every((fact) => fact.sourceHash === preference.contentHash));
  ok(result.estimatedTokens <= 1_000);
});

test("compaction drops old tool results but keeps the newest result verbatim", () => {
  const oldResult = block("tool_result", "call-old", "approved", {
    details: "x".repeat(3_000),
    compactionFacts: ["旧调用已成功"],
  });
  const recentResult = block("tool_result", "call-recent", "approved", { status: "succeeded" });
  const result = buildModelContext([goal(), manifest(), oldResult, recentResult], {
    maxTokens: 1_100,
    keepRecentToolResults: 1,
  });

  equal(result.compacted, true);
  equal(result.blocks.some((item) => item.source === "call-old"), false);
  equal(result.blocks.some((item) => item.source === "call-recent"), true);
  deepEqual(result.compactedFacts, [{ fact: "旧调用已成功", sourceHash: oldResult.contentHash }]);
});

test("required context fails closed instead of truncating the user goal", () => {
  const largeGoal = block("user_goal", "user", "untrusted", { intentPrompt: "目标".repeat(2_000) });
  throws(
    () => buildModelContext([largeGoal, manifest()], { maxTokens: 100 }),
    /context_token_budget_exceeded_required_blocks/,
  );
});

test("context assembly and compaction hashes are deterministic", () => {
  const input = [
    goal(),
    manifest(),
    block("preference_capsule", "desktop:project-1", "untrusted", {
      preferred: [{ category: "style", value: "克制".repeat(1_000) }],
    }),
  ];
  const first = buildModelContext(input, { maxTokens: 800 });
  const second = buildModelContext(input, { maxTokens: 800 });
  deepEqual(first, second);
});
