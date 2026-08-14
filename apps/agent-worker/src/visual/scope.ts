/**
 * 视觉设定 · 来源 scope hash 与查询语义（V0）—— 依据 AGENT-RUNTIME-PLAN.md §8.2 / §8.3。
 *
 * 纯函数。source_scope_hash 冻结「点击瞬间 project ∩ folder ∩ 有最新有效 caption」的输入快照，
 * 用于 draft 输入去重与一致性校验；**不用于持续监听**（§8.2：不监听素材变化）。
 */

import { sha256Hex } from "../kernel/tool-ledger.ts";

export type ScopeEntry = {
  assetId: string;
  captionId: string;
  captionHash: string;
};

export type ScopeInput = {
  projectId: string;
  folderId: string;
  entries: ScopeEntry[];
};

/**
 * 计算 source_scope_hash：覆盖 project、folder、排序后的 asset_id+caption_id+caption_hash。
 * 用户中途移动素材不改变本次输入（开始 Run 时已快照）。
 */
export function sourceScopeHash(input: ScopeInput): string {
  const fingerprint = input.entries
    .map((e) => `${e.assetId}:${e.captionId}:${e.captionHash}`)
    .sort()
    .join("|");
  return sha256Hex(`scope|${input.projectId}|${input.folderId}|${fingerprint}`);
}

/**
 * 「当前项目 ∩ 指定普通文件夹 ∩ 有最新有效 caption」的唯一查询语义（§8.3）。
 * 纯函数：给定项目成员集合、文件夹成员集合、每资产的最新 caption（已由桌面查好），
 * 返回可参与提炼的 assetId 列表 + 缺失/损坏统计。桌面侧负责实际 SQL。
 */
export type CoverageReport = {
  effective: string[];
  missingCaption: string[];
  inFolder: number;
};

export function computeCoverage(input: {
  projectMemberIds: Set<string>;
  folderMemberIds: Set<string>;
  latestCaptionByAsset: Map<string, { effective: boolean }>;
}): CoverageReport {
  const inFolderIds = [...input.folderMemberIds].filter((id) => input.projectMemberIds.has(id));
  const effective: string[] = [];
  const missingCaption: string[] = [];
  for (const id of inFolderIds) {
    const cap = input.latestCaptionByAsset.get(id);
    if (cap && cap.effective) effective.push(id);
    else missingCaption.push(id);
  }
  return { effective, missingCaption, inFolder: inFolderIds.length };
}
