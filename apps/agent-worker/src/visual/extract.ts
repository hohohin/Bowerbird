/**
 * 视觉设定 · 确定性提炼（V0）—— 依据 AGENT-RUNTIME-PLAN.md §8.4。
 *
 * V0 用**确定性** map-reduce 把证据卡聚合成 draft（不调模型、不上传图片），
 * 用于验证数据契约、provenance 回链、视觉语言/内容主题分离。
 * 真实模型提炼（分批事实抽取 + 聚合）属于 V2；V0 的确定性逻辑是其可审计基线。
 *
 * 关键不变量：内容主题（主体/内容/题材）只进 contentThemes，绝不变成视觉硬约束；
 * 视觉规则只来自 dimensions + 材质/类型/版式 类 section。
 */

import type {
  CandidateDirection,
  EvidenceConflict,
  EvidenceFact,
  VisualEvidenceCard,
  VisualLanguageCategory,
  VisualProfileDraft,
  VisualRule,
} from "../contracts/visual-profile.ts";
import {
  CONTENT_THEME_SECTION_TITLES,
  SECTION_CATEGORY_ALIASES,
} from "./evidence.ts";
import { sourceScopeHash } from "./scope.ts";

export type ExtractOptions = {
  projectId: string;
  folderId: string;
  minEffective?: number;
  dominantCoverage?: number;
  maxCandidateDirections?: number;
};

export type ExtractResult =
  | { ok: true; draft: VisualProfileDraft; effectiveCount: number; missingCount: number }
  | {
      ok: false;
      reason: "insufficient_coverage";
      effectiveCount: number;
      missingCount: number;
      minRequired: number;
    };

type CardValue = { value: string; assetId: string };

function isEffective(card: VisualEvidenceCard): boolean {
  return card.sections.length > 0 || Object.keys(card.dimensions).length > 0;
}

/** 从一张卡收集 (category → values)。视觉规则来源闭集。 */
function visualValues(card: VisualEvidenceCard): Array<{ category: VisualLanguageCategory; value: string; assetId: string }> {
  const out: Array<{ category: VisualLanguageCategory; value: string; assetId: string }> = [];
  const dims = card.dimensions as Record<string, string>;
  for (const key of ["composition", "light", "palette", "mood"] as const) {
    const v = dims[key];
    if (v && v.trim()) out.push({ category: key, value: v.trim(), assetId: card.assetId });
  }
  for (const sec of card.sections) {
    const mapped = SECTION_CATEGORY_ALIASES[sec.title.trim()];
    if (mapped && sec.body.trim()) {
      out.push({ category: mapped, value: sec.body.trim(), assetId: card.assetId });
    }
  }
  return out;
}

/** 内容主题来源闭集（主体/内容/题材/主题）。 */
function contentValues(card: VisualEvidenceCard): Array<{ value: string; assetId: string }> {
  const out: Array<{ value: string; assetId: string }> = [];
  for (const sec of card.sections) {
    if (CONTENT_THEME_SECTION_TITLES.has(sec.title.trim()) && sec.body.trim()) {
      for (const token of sec.body.split(/[、,，；;]/).map((s) => s.trim()).filter(Boolean)) {
        out.push({ value: token, assetId: card.assetId });
      }
    }
  }
  return out;
}

function aggregate(values: CardValue[]): Array<{ value: string; assetIds: string[]; coverage: number }> {
  const map = new Map<string, string[]>();
  for (const v of values) {
    const arr = map.get(v.value) ?? [];
    arr.push(v.assetId);
    map.set(v.value, arr);
  }
  const total = values.length || 1;
  return [...map.entries()]
    .map(([value, assetIds]) => ({ value, assetIds, coverage: assetIds.length / total }))
    .sort((a, b) => b.assetIds.length - a.assetIds.length);
}

export function extractDraft(
  cards: VisualEvidenceCard[],
  opts: ExtractOptions,
): ExtractResult {
  const minEffective = opts.minEffective ?? 5;
  const dominantCoverage = opts.dominantCoverage ?? 0.6;
  const maxCandidateDirections = opts.maxCandidateDirections ?? 3;

  const effective = cards.filter(isEffective);
  const effectiveCount = effective.length;
  const missingCount = cards.length - effectiveCount;

  if (effectiveCount < minEffective) {
    return { ok: false, reason: "insufficient_coverage", effectiveCount, missingCount, minRequired: minEffective };
  }

  // 视觉规则 / 冲突
  const byCategory = new Map<VisualLanguageCategory, CardValue[]>();
  for (const card of effective) {
    for (const { category, value, assetId } of visualValues(card)) {
      const arr = byCategory.get(category) ?? [];
      arr.push({ value, assetId });
      byCategory.set(category, arr);
    }
  }

  const visualRules: VisualRule[] = [];
  const conflicts: EvidenceConflict[] = [];
  for (const [category, vals] of byCategory) {
    const agg = aggregate(vals);
    const top = agg[0];
    if (!top) continue;
    if (top.coverage >= dominantCoverage) {
      const opposing = agg.slice(1).flatMap((a) => a.assetIds);
      visualRules.push({
        category,
        value: top.value,
        polarity: "prefer",
        confidence: top.coverage,
        supportingAssetIds: top.assetIds,
        opposingAssetIds: opposing,
        confirmedByUser: false,
      });
    } else if (agg.length >= 2 && agg[1]!.assetIds.length / vals.length >= 0.25) {
      // 无主导 + 第二势力显著 → 冲突，不强出规则
      const a = agg[0]!;
      const b = agg[1]!;
      conflicts.push({
        description: `${category}: ${a.value} vs ${b.value}`,
        sideA: { value: a.value, assetIds: a.assetIds },
        sideB: { value: b.value, assetIds: b.assetIds },
      });
    }
  }

  // 内容主题（绝不转视觉硬约束）
  const contentAgg = aggregate(effective.flatMap(contentValues));
  const contentThemes: EvidenceFact[] = contentAgg.map((a) => ({
    value: a.value,
    supportingAssetIds: a.assetIds,
    coverage: a.coverage,
    confidence: a.coverage,
  }));

  // 候选方向：按 palette+mood 签名聚类，≥2 簇才产出
  const clusters = new Map<string, string[]>();
  for (const card of effective) {
    const sig = [card.dimensions.palette ?? "", card.dimensions.mood ?? ""].join("|");
    const arr = clusters.get(sig) ?? [];
    arr.push(card.assetId);
    clusters.set(sig, arr);
  }
  const candidateDirections: CandidateDirection[] = [];
  const sortedClusters = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);
  if (sortedClusters.length >= 2) {
    const total = effective.length;
    for (const [sig, assetIds] of sortedClusters) {
      if (assetIds.length / total < 0.2) continue;
      if (candidateDirections.length >= maxCandidateDirections) break;
      const opposing = sortedClusters
        .filter(([s]) => s !== sig)
        .flatMap(([, ids]) => ids);
      candidateDirections.push({
        label: sig || "default",
        summary: `${assetIds.length} 张素材支持此方向`,
        supportingAssetIds: assetIds,
        opposingAssetIds: opposing,
      });
    }
  }

  const draft: VisualProfileDraft = {
    schemaVersion: 1,
    sourceScopeHash: sourceScopeHash({
      projectId: opts.projectId,
      folderId: opts.folderId,
      entries: cards.map((c) => ({
        assetId: c.assetId,
        captionId: c.captionId,
        captionHash: c.captionHash,
      })),
    }),
    summary: `${effectiveCount} 张有效反推素材；${visualRules.length} 条视觉规则，${conflicts.length} 处冲突，${contentThemes.length} 个内容主题。`,
    visualRules,
    contentThemes,
    conflicts,
    ...(candidateDirections.length ? { candidateDirections } : {}),
  };

  return { ok: true, draft, effectiveCount, missingCount };
}
