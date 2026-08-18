import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { FakeModel, scriptedActions } from "../../fakes/fake-model.ts";
import type { LoadedSkill } from "./skill-loader.ts";
import { loadPromptReviewSkill } from "./skill-loader.ts";
import { splitClauses } from "./clauses.ts";
import { expandPrompt } from "./expand.ts";
import { FIXTURES } from "./fixtures.ts";
import { scorePrompt } from "./score.ts";
import { reviewWithSkill, type ReviewAgentInput } from "./review-agent.ts";

const SKILL: LoadedSkill = {
  id: "bowerbird-prompt",
  version: "0.1.0-ab",
  instructions: "# 测试用 skill 指令",
  contentHash: "test-hash",
};

const CANONICAL = FIXTURES.find((fixture) => fixture.id === "abc-clothing-swap")!;
const UNANALYZED = FIXTURES.find((fixture) => fixture.id === "abc-clothing-swap-unanalyzed-b")!;
const [NAME_A, NAME_B, NAME_C] = CANONICAL.truth.requiredReferenceNames;

test("splitClauses handles english commas, conjunctions and keeps decimals", () => {
  deepEqual(
    splitClauses(
      "A young, androgynous person with vibrant, multi-colored hair, and an aged shirt",
    ),
    [
      "A young",
      "androgynous person with vibrant",
      "multi-colored hair",
      "an aged shirt",
    ],
  );
  deepEqual(splitClauses("黄昏天台，远处楼宇剪影；地面有雨水反光。"), [
    "黄昏天台",
    "远处楼宇剪影",
    "地面有雨水反光",
  ]);
  deepEqual(splitClauses("muted tones. 3.5 stops of light"), [
    "muted tones",
    "3.5 stops of light",
  ]);
});

test("expandPrompt synthesizes the desktop unfold template", () => {
  const expanded = expandPrompt(CANONICAL.input.originalPrompt, CANONICAL.input.references);
  ok(expanded.includes(`@${NAME_A} 的【主体】：A young`));
  ok(expanded.includes(`@${NAME_B} 的【服装】：黑色机车皮夹克`));
  const bare = expandPrompt(UNANALYZED.input.originalPrompt, UNANALYZED.input.references);
  ok(bare.includes(`@${NAME_B} 的衣服`));
  ok(!bare.includes("@cloth-b"));
});

test("baseline expansion fails leak threshold on the canonical fixture", () => {
  const expanded = expandPrompt(CANONICAL.input.originalPrompt, CANONICAL.input.references);
  const score = scorePrompt(CANONICAL, expanded);
  equal(score.bindingOk, true);
  ok(score.leakedTerms.includes("red leather biker jacket"));
});

test("scorePrompt accepts exclusion lines and flags unknown tokens", () => {
  const good = [
    "生成一张人物全身照",
    `「人物」@${NAME_A} 的【主体】：multi-colored hair，androgynous person`,
    `「服装」@${NAME_B} 的【服装】：黑色机车皮夹克`,
    `不要复制：@${NAME_A} 中的 red leather biker jacket、black pants、aged shirt`,
    `「场景」@${NAME_C} 的【场景】：黄昏天台`,
  ].join("\n");
  const pass = scorePrompt(CANONICAL, good);
  equal(pass.bindingOk, true);
  equal(pass.leakedTerms.length, 0);
  equal(pass.missingIntentTerms.length, 0);

  const corrupt = good.replace(NAME_C, `${NAME_C.slice(0, 10)}截断.webp`);
  const fail = scorePrompt(CANONICAL, corrupt);
  equal(fail.bindingOk, false);
  ok(fail.missingReferences.length > 0);
  ok(fail.unknownTokens.length > 0);
});

test("review agent returns the reviewed prompt and roles", async () => {
  const input: ReviewAgentInput = {
    intentPrompt: CANONICAL.input.originalPrompt,
    expandedPrompt: expandPrompt(CANONICAL.input.originalPrompt, CANONICAL.input.references),
    references: CANONICAL.input.references,
    output: CANONICAL.input.output,
  };
  const finalPrompt = `模特全身照\n「人物」@${NAME_A}：保持长相与发型\n「服装」@${NAME_B}：机车皮夹克造型\n「场景」@${NAME_C}：黄昏天台`;
  const model = new FakeModel(scriptedActions([
    {
      action: "return_reviewed_prompt",
      arguments: {
        verdict: "A 主体维度的服装需让渡给 B",
        finalPrompt,
        referenceRoles: [
          { assetId: "subj-a", role: "人物" },
          { assetId: "cloth-b", role: "服装" },
          { assetId: "scene-c", role: "场景" },
        ],
        decisionPoints: ["护目镜按用户未排除保留"],
      },
    },
  ]));
  const result = await reviewWithSkill(input, model, "route-b-1", SKILL);
  equal(result.prompt, finalPrompt);
  equal(result.attempts, 1);
  deepEqual(result.decisionPoints, ["护目镜按用户未排除保留"]);
  const skillBlock = model.requests[0]!.context.find((block) => block.kind === "skill_instruction");
  equal(skillBlock?.source, "bowerbird-prompt@0.1.0-ab");
});

test("review agent retries when a reference token is missing or unknown", async () => {
  const input: ReviewAgentInput = {
    intentPrompt: CANONICAL.input.originalPrompt,
    expandedPrompt: "展开版",
    references: CANONICAL.input.references,
  };
  const roles = [
    { assetId: "subj-a", role: "人物" },
    { assetId: "cloth-b", role: "服装" },
    { assetId: "scene-c", role: "场景" },
  ];
  const missing = `「人物」@${NAME_A} \n「服装」@${NAME_B}`; // 丢了 C
  // 未知 token 分支：真实文件名必须全在（先查缺失再查未知），再额外混入假 token。
  const unknown = `「人物」@${NAME_A}\n「服装」@${NAME_B}（另参考@虚构文件名~tplv.webp）\n「场景」@${NAME_C}`;
  const good = `「人物」@${NAME_A}\n「服装」@${NAME_B}\n「场景」@${NAME_C}`;
  const model = new FakeModel(scriptedActions([
    { action: "return_reviewed_prompt", arguments: { verdict: "v", finalPrompt: missing, referenceRoles: roles, decisionPoints: [] } },
    { action: "return_reviewed_prompt", arguments: { verdict: "v", finalPrompt: unknown, referenceRoles: roles, decisionPoints: [] } },
  ]));
  await reviewWithSkill(input, model, "route-b-missing", SKILL).then(
    () => { throw new Error("expected failure"); },
    (error: Error) => ok(error.message.includes("review_agent_unknown_token")),
  );
  equal(model.requests.length, 2);

  const retryModel = new FakeModel(scriptedActions([
    { action: "return_reviewed_prompt", arguments: { verdict: "v", finalPrompt: missing, referenceRoles: roles, decisionPoints: [] } },
    { action: "return_reviewed_prompt", arguments: { verdict: "v", finalPrompt: good, referenceRoles: roles, decisionPoints: [] } },
  ]));
  const recovered = await reviewWithSkill(input, retryModel, "route-b-retry", SKILL);
  equal(recovered.attempts, 2);
});

test("review agent salvages a prompt when roles metadata is malformed but tokens are intact", async () => {
  const input: ReviewAgentInput = {
    intentPrompt: CANONICAL.input.originalPrompt,
    expandedPrompt: "展开版",
    references: CANONICAL.input.references,
  };
  const finalPrompt = `「人物」@${NAME_A}\n「服装」@${NAME_B}\n「场景」@${NAME_C}`;
  const model = new FakeModel(scriptedActions([
    {
      action: "return_reviewed_prompt",
      arguments: {
        verdict: "v",
        finalPrompt,
        referenceRoles: [{ assetId: "subj-a", role: "人物" }], // 只回传 1/3
        decisionPoints: [],
      },
    },
  ]));
  const result = await reviewWithSkill(input, model, "route-b-salvage", SKILL);
  equal(result.attempts, 1);
  ok(result.decisionPoints.some((point) => point.includes("referenceRoles")));
});

test("skill loader pins the workspace SKILL.md by hash", () => {
  const skill = loadPromptReviewSkill();
  equal(skill.id, "bowerbird-prompt");
  ok(skill.instructions.includes("偏离"));
  ok(skill.instructions.length > 2000);
  ok(/^[0-9a-f]{64}$/.test(skill.contentHash));
});
