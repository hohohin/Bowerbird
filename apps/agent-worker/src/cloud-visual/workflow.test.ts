import { test } from "node:test";
import { equal, deepEqual, rejects } from "node:assert/strict";
import { aggregateDraft, applyVisualRequirements } from "./runtime.ts";
import type { VisualEvidenceCard } from "../contracts/visual-profile.ts";

test("text-only visual rules preserve prohibitions without fabricated image evidence", async () => {
  const draft = await applyVisualRequirements([], aggregateDraft([], []), "蓝色，避免渐变", async request => {
    equal(JSON.parse(request).requirements, "蓝色，避免渐变");
    return JSON.stringify({ summary: "蓝色平涂", visualRules: [{ category: "palette", value: "避免渐变", polarity: "avoid", supportingAssetIds: [] }] });
  });
  equal(draft.visualRules[0].polarity, "avoid");
  deepEqual(draft.visualRules[0].supportingAssetIds, []);
});

test("mixed input retains exact declared standards and rejects invented provenance", async () => {
  const cards: VisualEvidenceCard[] = [{ assetId: "a", captionId: "c", captionHash: "h", dimensions: {}, parseStatus: "structured", sourceClass: "imported", sections: [{ title: "品牌规范", body: "palette | 主色 HEX | #123456" }] }];
  const draft = await applyVisualRequirements(cards, aggregateDraft(cards, []), "宽松留白", async () => JSON.stringify({ summary: "宽松留白", visualRules: [{ category: "composition", value: "宽松留白", polarity: "must", supportingAssetIds: [] }] }));
  equal(draft.visualRules[0].value, "原图明确标注：主色 HEX：#123456");
  equal(draft.visualRules.length, 2);
  await rejects(() => applyVisualRequirements(cards, draft, "要求", async () => JSON.stringify({ summary: "test", visualRules: [{ category: "palette", value: "蓝色", polarity: "must", supportingAssetIds: ["unknown"] }] })), /rule_invalid/);
  await rejects(() => applyVisualRequirements([], aggregateDraft([], []), "要求", async () => JSON.stringify({ summary: "test", visualRules: [{ category: "palette", value: "长".repeat(201), polarity: "must", supportingAssetIds: [] }] })), /rule_invalid/);
});
