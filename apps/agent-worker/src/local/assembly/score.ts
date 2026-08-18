/**
 * 确定性评分器 —— A/B/基线三者在同一 fixture 上跑同一套硬指标。
 *
 * 硬指标（及格线）：
 *  - bindingOk：所有 requiredReferenceNames 原样出现，且不出现任何未知 @token
 *    （未知 token = 既不属于任何参考文件名，通常是模型改写/截断了绑定 token）。
 *  - leakedTerms 为空：forbidden 词不得出现在「正向描述行」（排除行除外）。
 *  - missingIntentTerms 为空：意图关键词（含 "/" 备选写法）至少命中一个。
 *
 * 排除行是启发式（含 不要/不得/忽略/仅参考 等标记的行）；改写式泄漏（同义替换）
 * 确定性检查抓不到，交给人工评分。这也是 A/B 两路线共用的同一把尺子。
 */

import type { AssemblyFixture } from "./fixtures.ts";

const EXCLUSION_LINE = /不要|不得|不复制|禁止|忽略|排除|仅参考|不要复制/;
const TOKEN = /@([^\s，。,；;、）)】：:]+)["'”」]?/g;

export type PromptScore = {
  bindingOk: boolean;
  missingReferences: string[];
  unknownTokens: string[];
  leakedTerms: string[];
  missingIntentTerms: string[];
  lengthChars: number;
};

function containsTerm(haystack: string, term: string): boolean {
  return haystack.toLowerCase().includes(term.toLowerCase());
}

export function scorePrompt(fixture: AssemblyFixture, finalPrompt: string): PromptScore {
  const names = fixture.input.references.map((reference) => reference.name ?? reference.assetId);
  const nameSet = new Set(names);

  const missingReferences = fixture.truth.requiredReferenceNames.filter(
    (name) => !finalPrompt.includes(name),
  );

  const unknownTokens: string[] = [];
  for (const match of finalPrompt.matchAll(TOKEN)) {
    const token = match[1] ?? "";
    if (token && !nameSet.has(token)) unknownTokens.push(token);
  }

  const positiveLines = finalPrompt
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !EXCLUSION_LINE.test(line));
  const positiveText = positiveLines.join("\n");
  const leakedTerms = fixture.truth.forbiddenPositiveTerms.filter((term) =>
    containsTerm(positiveText, term),
  );

  const missingIntentTerms = fixture.truth.requiredIntentTerms.filter((term) =>
    !term.split("/").some((variant) => containsTerm(finalPrompt, variant)),
  );

  return {
    bindingOk: missingReferences.length === 0 && unknownTokens.length === 0,
    missingReferences,
    unknownTokens,
    leakedTerms,
    missingIntentTerms,
    lengthChars: finalPrompt.length,
  };
}
