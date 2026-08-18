import { equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { FakeModel, scriptedActions } from "../fakes/fake-model.ts";
import { splitClauses } from "./assembly/clauses.ts";
import { compilePromptWithAgent, type PromptAgentInput } from "./prompt-agent.ts";

const NAME_A = "5b354d6db6ed443b996d21553e60da9c~tplv-aigc.webp";
const NAME_B = "7a6a2fa339444b4aabfb9450cf1f37ae~tplv-aigc.webp";
const NAME_C = "2fef4516c2cd4c46aafc1e67e7e55100~tplv-aigc.webp";

const SUBJ_RAW =
  "A young, androgynous person of ambiguous ethnicity with vibrant, multi-colored hair styled in a modern undercut, wearing futuristic goggles with dark lenses, a red leather biker jacket with black pants, and an aged shirt";

const INPUT: PromptAgentInput = {
  originalPrompt:
    "参考@subj-a 的【主体】，让他穿上@cloth-b 的【服装】，放在@scene-c 的【场景】里，生成一张全身照",
  references: [
    { assetId: "subj-a", name: NAME_A, dimensions: [{ key: "主体", label: "主体", raw: SUBJ_RAW }] },
    { assetId: "cloth-b", name: NAME_B, dimensions: [{ key: "服装", label: "服装", raw: "黑色机车皮夹克搭深灰连帽卫衣，厚底短靴" }] },
    { assetId: "scene-c", name: NAME_C, dimensions: [{ key: "场景", label: "场景", raw: "黄昏城市天台，暖橙色天际线，地面雨水反光" }] },
  ],
  output: { kind: "图片", ratio: "3:4" },
};

/** 按内容定位子句索引，避免测试硬编码切分顺序。 */
function clauseIndex(raw: string, needle: string): number {
  const index = splitClauses(raw).findIndex((clause) => clause.includes(needle));
  if (index < 0) throw new Error(`clause not found: ${needle}`);
  return index;
}

const JACKET = clauseIndex(SUBJ_RAW, "biker jacket");

function validAnalysis() {
  const subjectClauses = splitClauses(SUBJ_RAW)
    .map((_, index) => index)
    .filter((index) => index !== JACKET && index !== JACKET + 1);
  return {
    intent: "生成一张人物全身照：A 图人物换上 B 图服装，置于 C 图场景",
    responsibilities: [
      {
        assetId: "subj-a",
        role: "人物",
        dimensions: [{ dimensionKey: "主体", selectedClauses: subjectClauses }],
      },
      {
        assetId: "cloth-b",
        role: "服装",
        dimensions: [{ dimensionKey: "服装", selectedClauses: [0, 1] }],
      },
      {
        assetId: "scene-c",
        role: "场景",
        dimensions: [{ dimensionKey: "场景", selectedClauses: [0, 1, 2] }],
      },
    ],
    anchorLine: `主体为 @${NAME_A} 中的人物本身，保持其脸型、发型与身份特征不变`,
    globalConstraints: ["不要生成可读文字"],
  };
}

test("prompt agent compiles selected clauses with @tokens, exclusions and anchor", async () => {
  const model = new FakeModel(scriptedActions([
    { action: "return_prompt_analysis", arguments: validAnalysis() },
  ]));
  const result = await compilePromptWithAgent(INPUT, model, "route-a-1");
  ok(result.prompt.startsWith("生成一张人物全身照"));
  ok(result.prompt.includes(`「人物」@${NAME_A} 的【主体】：`));
  ok(result.prompt.includes("multi-colored hair"));
  ok(result.prompt.includes(`「服装」@${NAME_B} 的【服装】：黑色机车皮夹克`));
  ok(result.prompt.includes("不要复制以下内容"));
  ok(result.prompt.includes(`的【主体】中不要复制：`));
  ok(result.prompt.includes("red leather biker jacket"));
  ok(result.prompt.includes(`保持其脸型、发型与身份特征不变`));
  ok(result.prompt.includes("画幅比例：3:4"));
  equal(result.attempts, 1);
  equal(model.requests.length, 1);
  equal(model.requests[0]!.allowedActions[0]!.name, "return_prompt_analysis");
  const manifest = JSON.stringify(model.requests[0]!.context.find((block) => block.kind === "input_manifest"));
  ok(manifest.includes("clauses"));
});

test("prompt agent retries on refusal then succeeds", async () => {
  const model = new FakeModel([
    { kind: "refusal", reason: "invalid_tool_arguments", providerUsage: {} },
    ...scriptedActions([{ action: "return_prompt_analysis", arguments: validAnalysis() }]),
  ]);
  const result = await compilePromptWithAgent(INPUT, model, "route-a-2");
  equal(result.attempts, 2);
  equal(model.requests.length, 2);
  equal(model.requests[1]!.phase, "analyze_prompt_retry");
});

test("prompt agent rejects out-of-range clause indexes and retries", async () => {
  const bad = validAnalysis();
  bad.responsibilities[0]!.dimensions[0]!.selectedClauses = [99];
  const model = new FakeModel(scriptedActions([
    { action: "return_prompt_analysis", arguments: bad },
    { action: "return_prompt_analysis", arguments: validAnalysis() },
  ]));
  const result = await compilePromptWithAgent(INPUT, model, "route-a-3");
  equal(result.attempts, 2);
});

test("prompt agent rejects rebind attempts and retries", async () => {
  const bad = validAnalysis();
  (bad.responsibilities[1] as { assetId: string }).assetId = "ghost-asset";
  const model = new FakeModel(scriptedActions([
    { action: "return_prompt_analysis", arguments: bad },
    { action: "return_prompt_analysis", arguments: validAnalysis() },
  ]));
  const result = await compilePromptWithAgent(INPUT, model, "route-a-4");
  equal(result.attempts, 2);
});

test("prompt agent drops an anchor line that references no real image", async () => {
  const bad = validAnalysis();
  bad.anchorLine = "主体保持身份不变"; // 无 @token
  const model = new FakeModel(scriptedActions([
    { action: "return_prompt_analysis", arguments: bad },
  ]));
  const result = await compilePromptWithAgent(INPUT, model, "route-a-5");
  ok(!result.prompt.includes("主体保持身份不变"));
  equal(result.attempts, 1);
});

test("prompt agent normalizes @assetId references in model text to @filename tokens", async () => {
  const withShortRefs = validAnalysis();
  withShortRefs.intent = "参考@subj-a 的人物，换上@cloth-b 的服装，置于@scene-c 场景，生成全身照";
  const model = new FakeModel(scriptedActions([
    { action: "return_prompt_analysis", arguments: withShortRefs },
  ]));
  const result = await compilePromptWithAgent(INPUT, model, "route-a-tokens");
  ok(!result.prompt.includes("@subj-a"));
  ok(result.prompt.includes(`参考@${NAME_A} 的人物`));
  equal(result.attempts, 1);
});

test("prompt agent falls back to a generic declaration when missing", async () => {
  const unanalyzed: PromptAgentInput = {
    originalPrompt: "参考@subj-a 的【主体】，让他穿上@cloth-b 的衣服，生成一张全身照",
    references: [
      INPUT.references[0]!,
      { assetId: "cloth-b", name: NAME_B, dimensions: [] },
    ],
  };
  const missing = validAnalysis();
  missing.responsibilities = [
    missing.responsibilities[0]!,
    { assetId: "cloth-b", role: "服装", dimensions: [] },
  ];
  const provided = JSON.parse(JSON.stringify(missing)) as typeof missing;
  (provided.responsibilities[1] as { declaration?: string }).declaration = "让主体穿上@cloth-b 的衣服";
  // 缺 declaration：不烧重试，兜底整体参考。
  const modelA = new FakeModel(scriptedActions([
    { action: "return_prompt_analysis", arguments: missing },
  ]));
  const fallback = await compilePromptWithAgent(unanalyzed, modelA, "route-a-fallback");
  equal(fallback.attempts, 1);
  ok(fallback.prompt.includes(`「服装」@${NAME_B}：整体参考（本图未反推）`));
  // 有 declaration：照用，且其中的 @assetId 归一为 @文件名。
  const modelB = new FakeModel(scriptedActions([
    { action: "return_prompt_analysis", arguments: provided },
  ]));
  const declared = await compilePromptWithAgent(unanalyzed, modelB, "route-a-declared");
  equal(declared.attempts, 1);
  ok(declared.prompt.includes(`「服装」@${NAME_B}：让主体穿上@${NAME_B} 的衣服`));
});

test("prompt agent tolerates dimension subsets: missing dimension means nothing selected", async () => {
  const subset = validAnalysis();
  subset.responsibilities[0]!.dimensions = []; // 主体维度整体不选
  const model = new FakeModel(scriptedActions([
    { action: "return_prompt_analysis", arguments: subset },
  ]));
  const result = await compilePromptWithAgent(INPUT, model, "route-a-subset");
  equal(result.attempts, 1);
  ok(!result.prompt.includes(`「人物」@${NAME_A} 的【主体】`));
  ok(result.prompt.includes(`- @${NAME_A} 的【主体】中不要复制：`));
});

test("prompt agent accepts zero references", async () => {
  const model = new FakeModel(scriptedActions([
    {
      action: "return_prompt_analysis",
      arguments: {
        intent: "生成一张安静克制的海报",
        responsibilities: [],
        globalConstraints: ["不要生成可读文字"],
      },
    },
  ]));
  const result = await compilePromptWithAgent({
    originalPrompt: "生成一张安静克制的海报，不要生成文字",
    references: [],
  }, model, "route-a-no-ref");
  ok(result.prompt.includes("生成一张安静克制的海报"));
  ok(!result.prompt.includes("「"));
});
