/**
 * 展开合成器 —— 在 harness 内确定性复刻桌面端 serializeDoc 的 unfold 行为，
 * 为 Route B 生成「完整 prompt（模板展开版）」输入，并为评测提供「现状基线」。
 *
 * 复刻的模板（见 apps/desktop/src/components/creation/serialize.ts）：
 *  - `@name 的【维度】` → `@name 的【维度】：正文`
 *  - 裸 `@name`（纯参考引用）原样保留
 *  - 正文缺失时保留 `@name 的【维度】` 不展开
 */

import type { PromptAgentInput } from "../prompt-agent.ts";

export function expandPrompt(
  rawPrompt: string,
  references: PromptAgentInput["references"],
): string {
  const bodyByRef = new Map(
    references.map((reference) => [
      reference.assetId,
      new Map(reference.dimensions.map((dimension) => [dimension.key, dimension.raw])),
    ]),
  );
  const nameToAssetId = new Map(references.map((reference) => [reference.assetId, reference.name ?? reference.assetId]));
  // @name 的【维度】 → 展开
  let out = rawPrompt.replace(
    /@(\S+) 的【([^】]+)】/g,
    (whole, assetId: string, key: string) => {
      const body = bodyByRef.get(assetId)?.get(key) ?? bodyByRef.get(assetId)?.get(key.trim());
      return body ? `${whole}：${body}` : whole;
    },
  );
  // 裸 @assetId（桌面端序列化输出的是 @文件名；fixture 的 rawPrompt 统一用 @assetId 书写，
  // 这里映射回文件名，保持与真实 finalPrompt 同构）。
  // 只匹配后随标点/空白/行尾的 token，避免吞进带维度的引用或 CJK 长串。
  out = out.replace(/@([a-zA-Z0-9-]+)(?=[，。,；;、\s]|$)/g, (whole, assetId: string) => {
    if (!nameToAssetId.has(assetId)) return whole;
    const name = nameToAssetId.get(assetId)!;
    return name === assetId ? whole : `@${name}`;
  });
  return out;
}
