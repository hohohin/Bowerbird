import type { VisualEvidenceCard } from "../contracts/visual-profile.ts";
import { VISUAL_LANGUAGE_CATEGORIES } from "../contracts/visual-profile.ts";

export const DECLARED_PREFIX = "原图明确标注：";
export const REVIEW_PREFIX = "待核对的原图标注：";

/** Preserve labelled standards directly from observations, independently of model voting. */
export function declaredStandards(cards: VisualEvidenceCard[]) {
  const entries = new Map<string, { category: string; label: string; value: string; assetIds: Set<string> }>();
  for (const card of cards) for (const section of card.sections) {
    if (section.title.trim() !== "品牌规范") continue;
    for (const raw of section.body.split(/\r?\n/)) {
      const line = raw.trim().replace(/^[-*]\s+/, "");
      if (!line || line === "无明确标注") continue;
      const match = /^([a-z]+)\s*[|｜]\s*([^|｜]+)\s*[|｜]\s*(.+)$/.exec(line);
      if (!match || !VISUAL_LANGUAGE_CATEGORIES.includes(match[1] as typeof VISUAL_LANGUAGE_CATEGORIES[number])) throw new Error("brand_standard_format_invalid");
      const [, category, name, original] = match;
      const label = name.trim();
      const value = `${label}：${original.trim()}`;
      // Reject oversized evidence rather than silently cutting off colour codes.
      if ([...REVIEW_PREFIX + value].length > 200) throw new Error("brand_standard_too_long");
      const key = `${category}\n${value}`;
      const entry = entries.get(key) ?? { category, label, value, assetIds: new Set<string>() };
      entry.assetIds.add(card.assetId); entries.set(key, entry);
    }
  }
  const all = [...entries.values()];
  return all.map((entry) => {
    const conflict = all.some((other) => other !== entry && other.category === entry.category && other.label === entry.label);
    return {
      category: entry.category, value: (conflict ? REVIEW_PREFIX : DECLARED_PREFIX) + entry.value,
      polarity: conflict ? "prefer" as const : "must" as const,
      confidence: 1, supportingAssetIds: [...entry.assetIds].sort(), opposingAssetIds: [], confirmedByUser: false as const,
    };
  });
}
