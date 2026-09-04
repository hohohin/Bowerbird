import assert from "node:assert/strict";
import test from "node:test";

import { cloudAgentPlanDisplay } from "../src/lib/cloudAgentPlan.ts";

test("unified schema v2 is normalized without legacy-only fields", () => {
  const display = cloudAgentPlanDisplay({
    schemaVersion: 2,
    title: "产品详情页",
    summary: "用 HTML 保留全部长文并输出整页截图。",
    contentPlan: {
      assetAssignments: [{ assetId: "asset-1", roles: ["product", "copy_source"], rationale: "产品与原文来源" }],
      informationArchitecture: [{ id: "hero", purpose: "首屏", sourceAssetIds: ["asset-1"], copySource: "user_goal" }],
      missingAssets: [{ id: "detail", purpose: "细节图", decision: "not_needed", resolutionStepId: null }],
      visualProfile: null,
    },
    steps: [
      { id: "compose", kind: "compose_html", goal: "编排 HTML", inputAssetIds: ["asset-1"], dependsOn: [] },
      { id: "render", kind: "render_html", goal: "渲染长页", inputAssetIds: [], dependsOn: ["compose"] },
      { id: "inspect", kind: "inspect_artifact", goal: "检查截图", inputAssetIds: [], dependsOn: ["render"] },
      { id: "finalize", kind: "finalize_output", goal: "确认主产物", inputAssetIds: [], dependsOn: ["inspect"] },
    ],
  });

  assert.equal(display?.title, "产品详情页");
  assert.equal(display?.strategyLabel, "自动选工具");
  assert.equal(display?.references[0]?.label, "asset-1 · 产品、文案来源");
  assert.equal(display?.sections[0]?.label, "hero · 首屏");
  assert.equal(display?.missingAssets[0]?.detail, "无需补充");
  assert.equal(display?.steps[0]?.kindLabel, "编排 HTML");
  assert.deepEqual(display?.steps[1]?.details, [{ label: "依赖步骤", values: ["compose"] }]);
});

test("legacy controlled plan keeps its existing approval details", () => {
  const display = cloudAgentPlanDisplay({
    schemaVersion: 1,
    intentAnalysisHash: "a".repeat(64),
    intentSummary: "替换背景并保持主体。",
    strategy: "controlled",
    referenceRoles: [{ referenceId: "reference-1", role: "主体" }],
    assumptions: [],
    steps: [{
      id: "generate",
      kind: "direct_generate",
      goal: "生成结果",
      inputs: [],
      modifies: ["背景"],
      preserves: ["主体"],
      excludes: ["原背景"],
      outputRole: "final_result",
      rationale: "一次生成即可",
      estimatedUsage: { generateCalls: 1, understandCalls: 0 },
    }],
  });

  assert.equal(display?.strategyLabel, "一致性控制");
  assert.equal(display?.references[0]?.label, "reference-1 · 主体");
  assert.deepEqual(display?.steps[0]?.details.map((item) => item.label), ["修改", "保持", "排除"]);
});

test("malformed remote proposals fail closed instead of throwing during render", () => {
  assert.equal(cloudAgentPlanDisplay(null), null);
  assert.equal(cloudAgentPlanDisplay({ schemaVersion: 2, title: "缺步骤", summary: "x" }), null);
  assert.doesNotThrow(() => cloudAgentPlanDisplay({
    schemaVersion: 2,
    title: "不完整计划",
    summary: "仍可安全展示",
    steps: [{ id: "finalize", kind: "finalize_output", goal: "完成" }],
  }));
});
