import { equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { FakeModel, scriptedActions } from "../fakes/fake-model.ts";
import { compilePromptWithAgent, type PromptAgentInput } from "./prompt-agent.ts";

const INPUT: PromptAgentInput = {
  originalPrompt: "参考 A 的构图、B 的主体、C 的类型，生成一张海报",
  references: [
    {
      assetId: "a",
      name: "A",
      dimensions: [{ key: "构图", label: "构图", raw: "主体位于下半区，花枝向上延展，大量留白" }],
    },
    {
      assetId: "b",
      name: "B",
      dimensions: [{ key: "主体", label: "主体", raw: "保留人物身份、轮廓和服装特征" }],
    },
    {
      assetId: "c",
      name: "C",
      dimensions: [{ key: "类型", label: "类型", raw: "柔边软陶手办式 3D 微缩模型" }],
    },
  ],
  output: { kind: "图片", ratio: "3:4" },
};

const VALID_ANALYSIS = {
  intent: "创作一张以 B 中人物为主体的东方禅意海报",
  referenceRoles: [
    {
      assetId: "a",
      dimensions: [{
        dimensionKey: "构图",
        instruction: "采用平视中景，主体集中于下半区，以向上延展的视觉线条连接大面积留白",
        excludedElements: ["花枝"],
      }],
    },
    {
      assetId: "b",
      dimensions: [{
        dimensionKey: "主体",
        instruction: "保留人物身份、轮廓和服装特征",
        excludedElements: [],
      }],
    },
    {
      assetId: "c",
      dimensions: [{
        dimensionKey: "类型",
        instruction: "表现为柔边软陶手办式 3D 微缩模型",
        excludedElements: [],
      }],
    },
  ],
  globalConstraints: ["不要生成可读文字"],
};

test("prompt agent returns one generation-ready prompt without a director checkpoint", async () => {
  const model = new FakeModel(scriptedActions([
    { action: "return_prompt_analysis", arguments: VALID_ANALYSIS },
  ]));
  const result = await compilePromptWithAgent(INPUT, model, "prompt-test-1");
  ok(result.prompt.includes("主体集中于下半区"));
  ok(result.prompt.includes("该维度不要复制：花枝"));
  ok(result.prompt.includes("画幅比例：3:4"));
  equal(result.attempts, 1);
  equal(model.requests.length, 1);
  equal(model.requests[0]!.allowedActions.length, 1);
  equal(model.requests[0]!.allowedActions[0]!.name, "return_prompt_analysis");
  const manifest = model.requests[0]!.context.find((block) => block.kind === "input_manifest");
  ok(JSON.stringify(manifest?.body).includes("柔边软陶手办式"));
});

test("prompt agent retries one malformed tool response", async () => {
  const model = new FakeModel([
    { kind: "refusal", reason: "invalid_tool_arguments", providerUsage: {} },
    ...scriptedActions([
      { action: "return_prompt_analysis", arguments: VALID_ANALYSIS },
    ]),
  ]);
  const result = await compilePromptWithAgent(INPUT, model, "prompt-test-2");
  ok(result.prompt.includes("参考图职责（严格边界）"));
  equal(result.attempts, 2);
  equal(model.requests.length, 2);
  equal(model.requests[1]!.phase, "analyze_prompt_retry");
});

test("prompt agent retries when an excluded source entity leaks into its positive instruction", async () => {
  const leaked = JSON.parse(JSON.stringify(VALID_ANALYSIS)) as typeof VALID_ANALYSIS;
  leaked.referenceRoles[0]!.dimensions[0]!.instruction = "让花枝向上延展并保留大量留白";
  const model = new FakeModel(scriptedActions([
    { action: "return_prompt_analysis", arguments: leaked },
    { action: "return_prompt_analysis", arguments: VALID_ANALYSIS },
  ]));
  const result = await compilePromptWithAgent(INPUT, model, "prompt-test-3");
  equal(result.attempts, 2);
  ok(result.prompt.includes("以向上延展的视觉线条连接大面积留白"));
  equal(model.requests.length, 2);
});

test("prompt agent accepts zero references", async () => {
  const model = new FakeModel(scriptedActions([
    {
      action: "return_prompt_analysis",
      arguments: {
        intent: "生成一张安静克制的海报",
        referenceRoles: [],
        globalConstraints: ["不要生成可读文字"],
      },
    },
  ]));
  const result = await compilePromptWithAgent({
    originalPrompt: "生成一张安静克制的海报，不要生成文字",
    references: [],
  }, model, "prompt-test-no-reference");
  ok(result.prompt.includes("生成一张安静克制的海报"));
  ok(!result.prompt.includes("参考图职责"));
});

test("prompt agent accepts a reference with no role and arbitrary custom dimensions", async () => {
  const model = new FakeModel(scriptedActions([
    {
      action: "return_prompt_analysis",
      arguments: {
        intent: "生成一张产品图",
        referenceRoles: [
          { assetId: "plain", dimensions: [] },
          {
            assetId: "custom",
            dimensions: [{
              dimensionKey: "视觉节奏",
              instruction: "使用疏密交替的视觉节奏",
              excludedElements: [],
            }],
          },
        ],
        globalConstraints: [],
      },
    },
  ]));
  const result = await compilePromptWithAgent({
    originalPrompt: "参考这些图片生成一张产品图",
    references: [
      { assetId: "plain", name: "未选择维度的参考图", dimensions: [] },
      {
        assetId: "custom",
        name: "自定义维度参考图",
        dimensions: [{ key: "视觉节奏", label: "视觉节奏", raw: "元素排列疏密交替" }],
      },
    ],
  }, model, "prompt-test-custom-dimension");
  ok(result.prompt.includes("视觉节奏：使用疏密交替的视觉节奏"));
  ok(result.prompt.includes("未选择维度的参考图"));
  ok(result.prompt.includes("按用户原始 prompt 中对本图的指代作为一般参考"));
});
