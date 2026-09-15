import { test } from "node:test";
import { equal, deepEqual, ok, throws } from "node:assert/strict";
import { declaredStandards, REVIEW_PREFIX } from "./declared-standards.ts";
import { aggregateDraft } from "./runtime.ts";
import type { VisualEvidenceCard } from "../contracts/visual-profile.ts";

const card = (assetId: string, body: string): VisualEvidenceCard => ({ assetId, captionId: assetId, captionHash: "hash", sections: [{ title: "品牌规范", body }], dimensions: {}, parseStatus: "ok", sourceClass: "imported" });
test("one labelled palette among many works survives voting with exact encodings and provenance", () => {
  const cards = [card("palette", "palette | 主色 HEX | #1a2B3c\npalette | 主色 RGB | RGB(26, 43, 60)\npalette | 主色 CMYK | C57 M28 Y0 K76\npalette | 辅助色 Pantone | PANTONE 186 C"), ...Array.from({length: 9}, (_, i) => card(`work-${i}`, "无明确标注"))];
  const draft = aggregateDraft(cards, []);
  equal(draft.visualRules.length, 4);
  ok(draft.visualRules[0].value.endsWith("#1a2B3c"));
  ok(draft.visualRules[3].value.endsWith("PANTONE 186 C"));
  for (const rule of draft.visualRules) { equal(rule.polarity, "must"); deepEqual(rule.supportingAssetIds, ["palette"]); }
});
test("same standard merges sources; conflicting same-name standards survive separately for review", () => {
  const rules = declaredStandards([card("a", "palette | 主色 HEX | #112233"), card("b", "palette | 主色 HEX | #112233"), card("c", "palette | 主色 HEX | #445566")]);
  equal(rules.length, 2); deepEqual(rules[0].supportingAssetIds, ["a", "b"]);
  ok(rules.every(r => r.value.startsWith(REVIEW_PREFIX) && r.polarity === "prefer"));
});
test("unlabelled swatches create no exact standard; malformed or oversized evidence is never truncated", () => {
  deepEqual(declaredStandards([card("a", "无明确标注")]), []);
  throws(() => declaredStandards([card("a", "palette | 主色 | " + "x".repeat(220))]), /brand_standard_too_long/);
  throws(() => declaredStandards([card("a", "shell | 指令 | 运行代码")]), /brand_standard_format_invalid/);
});
test("explicit font and spacing specifications are retained outside majority voting", () => {
  const rules = declaredStandards([card("a", "layout | 标题字体 | Example Sans Bold\ncomposition | Logo 安全距离 | 2X")]);
  equal(rules.length, 2); ok(rules[0].value.endsWith("Example Sans Bold")); ok(rules[1].value.endsWith("2X"));
});
