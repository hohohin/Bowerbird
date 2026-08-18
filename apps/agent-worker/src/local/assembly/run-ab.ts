/**
 * A/B 实跑脚本：真实 DeepSeek 上对比 Route A（子句挑选）× Route B（skill 审查修复）× 基线（模板展开直发）。
 *
 * 运行：npm run ab:prompt  （= node --env-file=../cloud/.env src/local/assembly/run-ab.ts）
 * 输出：artifacts/assembly-ab-report.{json,md} —— 确定性指标汇总 + 逐 fixture prompt 全文 + 人工评分表。
 *
 * 确定性指标（及格线，两路线同一把尺子）：
 *  - bindingOk 率（@token 完整、无未知 token）
 *  - 泄漏率（forbidden 词出现在正向行）
 *  - 意图覆盖（required 词缺失）
 *  - 成本（token / attempts）与稳定性（3 轮结果一致率）
 * 意图保真/可读性人工 1–5 分在报告的人工评分表里填。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DeepSeekBackend, deepSeekConfigFromEnv } from "../../providers/deepseek/backend.ts";
import { compilePromptWithAgent } from "../prompt-agent.ts";
import { expandPrompt } from "./expand.ts";
import { FIXTURES, type AssemblyFixture } from "./fixtures.ts";
import { scorePrompt, type PromptScore } from "./score.ts";
import { reviewWithSkill } from "./review-agent.ts";
import { loadPromptReviewSkill } from "./skill-loader.ts";

const RUNS = Number.parseInt(process.env.AB_RUNS ?? "3", 10) || 3;
const ARTIFACTS_DIR = join(import.meta.dirname, "..", "..", "..", "artifacts");

type RouteName = "baseline" | "routeA" | "routeB";

type RunRecord = {
  route: RouteName;
  run: number;
  ok: boolean;
  error?: string;
  prompt: string;
  attempts: number;
  promptTokens: number;
  completionTokens: number;
  score: PromptScore;
  decisionPoints?: string[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(() => resolve(), ms));
}

async function runOnce(
  fixture: AssemblyFixture,
  route: RouteName,
  model: DeepSeekBackend,
  run: number,
): Promise<RunRecord> {
  const base = {
    route,
    run,
    attempts: 0,
    promptTokens: 0,
    completionTokens: 0,
    decisionPoints: [] as string[] | undefined,
  };
  try {
    if (route === "routeA") {
      const result = await compilePromptWithAgent(fixture.input, model, `ab-a-${fixture.id}-${run}`);
      return {
        ...base,
        ok: true,
        prompt: result.prompt,
        attempts: result.attempts,
        promptTokens: result.providerUsage.promptTokens ?? 0,
        completionTokens: result.providerUsage.completionTokens ?? 0,
        score: scorePrompt(fixture, result.prompt),
      };
    }
    if (route === "routeB") {
      const result = await reviewWithSkill(
        {
          intentPrompt: fixture.input.originalPrompt,
          expandedPrompt: expandPrompt(fixture.input.originalPrompt, fixture.input.references),
          references: fixture.input.references,
          output: fixture.input.output,
        },
        model,
        `ab-b-${fixture.id}-${run}`,
      );
      return {
        ...base,
        ok: true,
        prompt: result.prompt,
        attempts: result.attempts,
        promptTokens: result.providerUsage.promptTokens ?? 0,
        completionTokens: result.providerUsage.completionTokens ?? 0,
        score: scorePrompt(fixture, result.prompt),
        decisionPoints: result.decisionPoints,
      };
    }
    const prompt = expandPrompt(fixture.input.originalPrompt, fixture.input.references);
    return { ...base, ok: true, prompt, score: scorePrompt(fixture, prompt) };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      prompt: "",
      score: scorePrompt(fixture, ""),
    };
  }
}

function summarize(records: RunRecord[]): string {
  const ok = records.filter((record) => record.ok);
  if (!ok.length) return "全部失败";
  const binding = ok.filter((record) => record.score.bindingOk).length;
  const leakFree = ok.filter((record) => record.score.leakedTerms.length === 0).length;
  const intentCovered = ok.filter((record) => record.score.missingIntentTerms.length === 0).length;
  const avgTokens = Math.round(ok.reduce((sum, record) => sum + record.promptTokens + record.completionTokens, 0) / ok.length);
  const avgAttempts = (ok.reduce((sum, record) => sum + record.attempts, 0) / ok.length).toFixed(2);
  const identical =
    new Set(ok.map((record) => record.prompt)).size === 1 && ok.length === records.length ? "一致" : "有差异";
  return `成功 ${ok.length}/${records.length}；binding ${binding}/${ok.length}；无泄漏 ${leakFree}/${ok.length}；意图覆盖 ${intentCovered}/${ok.length}；平均 token ${avgTokens}；平均回合 ${avgAttempts}；${RUNS} 轮文本${identical}`;
}

function buildReport(all: Map<string, Map<RouteName, RunRecord[]>>): string {
  const lines: string[] = [
    "# A/B 路线对比报告（生成图 prompt 组装）",
    "",
    `- 模型：DeepSeek（deepseek-chat）；轮次：每 fixture × ${RUNS} 轮`,
    `- Route A = 确定性子句挑选（\`prompt-agent.ts\`）；Route B = skill 审查修复（\`.agents/skills/bowerbird-prompt/SKILL.md\`）；基线 = 现有模板展开直发`,
    `- 生成时间：${new Date().toISOString()}`,
    "",
    "## 确定性指标汇总",
    "",
    "| fixture | 路线 | 结果 |",
    "|---|---|---|",
  ];
  for (const [fixtureId, routes] of all) {
    for (const route of ["baseline", "routeA", "routeB"] as RouteName[]) {
      lines.push(`| ${fixtureId} | ${route} | ${summarize(routes.get(route) ?? [])} |`);
    }
  }
  lines.push("", "## 逐 fixture prompt 全文（人工评审用）", "");
  for (const fixture of FIXTURES) {
    const routes = all.get(fixture.id)!;
    lines.push(`### ${fixture.id} —— ${fixture.description}`, "");
    lines.push(`**意图原文**：${fixture.input.originalPrompt}`, "");
    lines.push(`**职责真值**：${fixture.truth.ownership.map((item) => `${item.assetId}→${item.owns.join("/")}`).join("；")}`, "");
    for (const route of ["baseline", "routeA", "routeB"] as RouteName[]) {
      const records = routes.get(route) ?? [];
      const first = records.find((record) => record.ok);
      lines.push(`#### ${route}`);
      if (!first) {
        lines.push("```", records[0]?.error ?? "无记录", "```", "");
        continue;
      }
      const flags = [
        first.score.bindingOk ? "" : `binding❌(${[...first.score.missingReferences, ...first.score.unknownTokens].join("|")})`,
        first.score.leakedTerms.length ? `泄漏❌(${first.score.leakedTerms.join("|")})` : "",
        first.score.missingIntentTerms.length ? `意图缺❌(${first.score.missingIntentTerms.join("|")})` : "",
      ].filter(Boolean).join(" ");
      lines.push(flags ? `硬指标：${flags}` : "硬指标：全部通过");
      if (first.decisionPoints?.length) {
        lines.push(`决策点（已按默认规则裁决）：${first.decisionPoints.join("；")}`);
      }
      lines.push("```text", first.prompt, "```", "");
    }
  }
  lines.push("## 人工评分表（1–5 分，填完决定留哪条路线）", "");
  lines.push("| fixture | 路线 | 意图保真 | 可读性/融合 | 备注 |");
  lines.push("|---|---|---|---|---|");
  for (const fixture of FIXTURES) {
    for (const route of ["baseline", "routeA", "routeB"] as RouteName[]) {
      lines.push(`| ${fixture.id} | ${route} | | | |`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY || !process.env.DEEPSEEK_MODEL) {
    throw new Error("ab_runner_missing_deepseek_env");
  }
  const model = new DeepSeekBackend(deepSeekConfigFromEnv(process.env));
  loadPromptReviewSkill(); // 哈希校验前置：skill 文件被改动则拒绝开跑
  const all = new Map<string, Map<RouteName, RunRecord[]>>();
  for (const fixture of FIXTURES) {
    const routes = new Map<RouteName, RunRecord[]>();
    routes.set("baseline", [await runOnce(fixture, "baseline", model, 1)]);
    for (const route of ["routeA", "routeB"] as RouteName[]) {
      const records: RunRecord[] = [];
      for (let run = 1; run <= RUNS; run++) {
        const record = await runOnce(fixture, route, model, run);
        records.push(record);
        console.log(
          `[${fixture.id}] ${route} #${run} ${record.ok ? "ok" : `FAIL ${record.error}`}` +
            (record.ok
              ? ` binding=${record.score.bindingOk} leak=${record.score.leakedTerms.join("|") || "-"} intent=${record.score.missingIntentTerms.join("|") || "-"}`
              : ""),
        );
        await sleep(300);
      }
      routes.set(route, records);
    }
    all.set(fixture.id, routes);
  }
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const reportId = `ab-${randomUUID().slice(0, 8)}`;
  const json = JSON.stringify(
    [...all.entries()].map(([fixtureId, routes]) => ({
      fixtureId,
      runs: Object.fromEntries([...routes.entries()].map(([route, records]) => [route, records])),
    })),
    null,
    2,
  );
  writeFileSync(join(ARTIFACTS_DIR, `assembly-ab-report.json`), json, "utf8");
  writeFileSync(join(ARTIFACTS_DIR, `assembly-ab-report.md`), buildReport(all), "utf8");
  console.log(`report: ${join(ARTIFACTS_DIR, "assembly-ab-report.md")} (${reportId})`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
