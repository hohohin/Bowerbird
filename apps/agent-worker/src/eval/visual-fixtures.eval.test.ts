/**
 * 视觉设定 fixture eval（V0-T3）—— 5 个纯 caption 场景验证 extract/batch。
 *   1. 单一方向：规则齐全、provenance 回链、无候选方向
 *   2. 多个方向：产出候选方向（不强平均）
 *   3. 内容主题误判：茶具只进 contentThemes，绝不进 visualRules
 *   4. 反推缺失：低于门槛即停止（不偷补反推/不上传图）
 *   5. 超大数据集：分批覆盖全部，不随机抽样
 */

import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import type { VisualEvidenceCard } from "../contracts/visual-profile.ts";
import { extractDraft } from "../visual/extract.ts";
import { batchesCoverAll, planBatches } from "../visual/batch.ts";
import { sourceScopeHash } from "../visual/scope.ts";
import {
  contentThemeMisjudged,
  missingCaption,
  multipleDirections,
  oversized,
  singleDirection,
} from "../fixtures/visual-captions.ts";

const OPTS = { projectId: "proj-1", folderId: "folder-1" };

function assetIdSet(cards: VisualEvidenceCard[]): Set<string> {
  return new Set(cards.map((c) => c.assetId));
}
function provenanceValid(rule: { supportingAssetIds: string[] }, valid: Set<string>): boolean {
  return rule.supportingAssetIds.every((id) => valid.has(id));
}

test("视觉 1/5：单一方向 → 规则齐全、回链有效、无候选方向", () => {
  const cards = singleDirection();
  const res = extractDraft(cards, OPTS);
  equal(res.ok, true);
  if (res.ok) {
    const draft = res.draft;
    ok(draft.visualRules.length > 0, "产出视觉规则");
    const valid = assetIdSet(cards);
    ok(draft.visualRules.every((r) => provenanceValid(r, valid)), "规则 supportingAssetIds 全部回链有效");
    ok(draft.summary.length > 0);
    ok(!draft.candidateDirections || draft.candidateDirections.length === 0, "单一方向无候选");
  }
});

test("视觉 2/5：多个方向 → 候选方向，不强平均", () => {
  const cards = multipleDirections();
  const res = extractDraft(cards, OPTS);
  equal(res.ok, true);
  if (res.ok) {
    const draft = res.draft;
    ok(
      (draft.candidateDirections?.length ?? 0) >= 2 || draft.conflicts.length > 0,
      "多方向产出候选方向或冲突（不强行平均）",
    );
  }
});

test("视觉 3/5：内容主题误判 → 茶具只在 contentThemes，绝不进 visualRules", () => {
  const cards = contentThemeMisjudged();
  const res = extractDraft(cards, OPTS);
  equal(res.ok, true);
  if (res.ok) {
    const draft = res.draft;
    ok(
      draft.contentThemes.some((t) => t.value.includes("茶具")),
      "茶具作为内容主题出现",
    );
    ok(
      !draft.visualRules.some((r) => r.value.includes("茶具")),
      "茶具未被误升为视觉硬约束",
    );
    ok(
      draft.contentThemes.every((t) => provenanceValid(t, assetIdSet(cards))),
      "内容主题 supportingAssetIds 回链有效",
    );
  }
});

test("视觉 4/5：反推缺失 → 低于门槛即停止，不偷补", () => {
  const cards = missingCaption();
  const res = extractDraft(cards, OPTS);
  equal(res.ok, false, "有效反推不足 → 停止");
  if (!res.ok) {
    equal(res.reason, "insufficient_coverage");
    equal(res.effectiveCount, 2);
    equal(res.missingCount, 4);
    equal(res.minRequired, 5);
  }
});

test("视觉 5/5：超大数据集 → 分批覆盖全部，不随机抽样", () => {
  const n = 200;
  const cards = oversized(n);
  const batches = planBatches(cards, 160); // 小批以触发多批
  ok(batches.length > 1, "拆成多批");
  ok(batchesCoverAll(batches, n), "分批覆盖全部 200 张、无遗漏/重复");

  const res = extractDraft(cards, OPTS);
  equal(res.ok, true, "超大数据集仍可提炼");
  if (res.ok) {
    equal(res.effectiveCount, n);
    const valid = assetIdSet(cards);
    ok(
      res.draft.visualRules.every((r) => provenanceValid(r, valid)),
      "超大集合规则仍全部回链有效",
    );
  }
});

test("视觉·确定性：source_scope_hash 稳定且对顺序不敏感", () => {
  const cards = singleDirection();
  const base = {
    projectId: "p",
    folderId: "f",
    entries: cards.map((c) => ({ assetId: c.assetId, captionId: c.captionId, captionHash: c.captionHash })),
  };
  const shuffled = { ...base, entries: [...base.entries].reverse() };
  equal(sourceScopeHash(base), sourceScopeHash(shuffled), "成员顺序不影响 scope hash");
});
