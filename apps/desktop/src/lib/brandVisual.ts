import type { VisualProfileDetail, VisualProfileScopePreview } from "./types";

/** VPS resolves this task identifier to the maintained observation prompt. */
export const BRAND_OBSERVATION_TASK = "bowerbird:brand-visual-observation:v2";

export function sameBrandImages(a: readonly string[], b: readonly string[]) {
  const right = new Set(b);
  return a.length === b.length && a.every((id) => right.has(id));
}

export async function summarizeBrandImages({ scope, preview, describe, extract, signal, onProgress }: {
  scope: VisualProfileScopePreview;
  preview: () => Promise<VisualProfileScopePreview>;
  describe: (assetId: string, signal: AbortSignal) => Promise<void>;
  extract: (assetIds: string[]) => Promise<VisualProfileDetail>;
  signal: AbortSignal;
  onProgress: (label: string) => void;
}): Promise<VisualProfileDetail> {
  const check = () => signal.throwIfAborted();
  check();
  if (scope.inFolder < scope.minRequired) throw new Error(`请添加至少 ${scope.minRequired} 张品牌图片`);
  if (scope.inFolder > 500) throw new Error("一次最多总结 500 张图片，请将品牌图片分组后再试");
  if (!scope.assetIds?.length || scope.assetIds.length !== scope.inFolder) throw new Error("图片列表尚未准备好，请重新打开后再试");
  const expected = [...scope.assetIds];
  const fresh = await preview();
  check();
  if (!sameBrandImages(expected, fresh.assetIds)) throw new Error("品牌图片已发生变化，请重新查看后再总结");
  // Use saved observations when available. Stop on failure; never blindly resubmit a charged call.
  for (const [index, item] of fresh.missing.entries()) {
    check();
    onProgress(`正在了解图片 ${index + 1} / ${fresh.missing.length}`);
    await describe(item.assetId, signal);
    check();
    const current = await preview();
    check();
    if (!sameBrandImages(expected, current.assetIds)) throw new Error("品牌图片已发生变化，请重新查看后再总结");
    if (current.missing.some((m) => m.assetId === item.assetId)) throw new Error("有一张图片暂时无法读懂，请更换图片后重试。已完成的分析会保留。");
  }
  check();
  onProgress("正在总结品牌的视觉风格…");
  return extract(expected);
}

export function brandOverview(detail: VisualProfileDetail) {
  // Older versions stored diagnostic counts as their summary. Do not present that as brand prose.
  if (detail.summary && !detail.rules.some((rule) => rule.confirmedByUser) && !/有效反推|条视觉规则|处冲突|个内容主题|主导视觉规则/.test(detail.summary)) return detail.summary;
  const selected = ["mood", "palette", "composition", "light"].flatMap((category) =>
    detail.rules.filter((rule) => rule.category === category && rule.polarity !== "avoid").slice(0, 1).map((rule) => rule.value.replace(/[。；;]+$/, "")),
  );
  return selected.length ? `${selected.join("；")}。` : "这些图片呈现了不同的视觉方向，可在下方选择更接近品牌的一种。";
}
