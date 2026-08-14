/**
 * 视觉设定 · 分批（V0 map-reduce）—— 依据 AGENT-RUNTIME-PLAN.md §8.3。
 *
 * 有效数据很多时，确定性 batching 处理 token 上限：按估算文本体积分批，
 * **不随机抽图冒充「分析全部」**。所有卡都被覆盖，无遗漏。
 */

import type { VisualEvidenceCard } from "../contracts/visual-profile.ts";

/** 估算一张卡的文本体积（section body 字符数，粗略 token 代理）。 */
export function estimateCardChars(card: VisualEvidenceCard): number {
  const sections = card.sections.reduce((sum, s) => sum + s.body.length + s.title.length, 0);
  const dims = Object.values(card.dimensions).reduce((sum, v) => sum + (v?.length ?? 0), 0);
  return sections + dims + (card.textFallback?.length ?? 0);
}

/**
 * 贪心分批：按顺序填入，单批不超过 maxCharsPerBatch；单卡超限时自占一批。
 * 返回 batch 数组（顺序保留，覆盖全部卡）。
 */
export function planBatches(
  cards: VisualEvidenceCard[],
  maxCharsPerBatch: number,
): VisualEvidenceCard[][] {
  const batches: VisualEvidenceCard[][] = [];
  let current: VisualEvidenceCard[] = [];
  let used = 0;
  for (const card of cards) {
    const size = estimateCardChars(card);
    if (current.length > 0 && used + size > maxCharsPerBatch) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(card);
    used += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 校验：分批覆盖全部卡、无遗漏/重复（eval 断言用）。 */
export function batchesCoverAll(
  batches: VisualEvidenceCard[][],
  totalCards: number,
): boolean {
  const seen = new Set<string>();
  let count = 0;
  for (const batch of batches) {
    for (const card of batch) {
      if (seen.has(card.assetId)) return false;
      seen.add(card.assetId);
      count++;
    }
  }
  return count === totalCards;
}
