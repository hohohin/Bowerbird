/**
 * 项目视觉设定契约（v1）—— 依据 AGENT-RUNTIME-PLAN.md §8.3 / §8.5 / §8.8。
 *
 * 三条不可变输入边界（§8.2）：
 *  1. 不上传图片：提炼只用已有 caption 的 sections/dimensions/text/parse_status，
 *     不调用 Vision、不自动补反推。
 *  2. 只分析用户指定的普通文件夹：取「当前项目成员 ∩ folder_id」点击时的反推快照。
 *  3. 只由按钮主动触发：不监听库变化、不自动重算/提示。
 *
 * 本文件只定义数据契约；规范化（caption→evidence）、scope hash、batching 是纯函数
 * 实现（见 src/visual/），不读取图片文件。
 */

/** 视觉语言维度词表（提炼归纳与 capsule 编译都限制在此闭集，§8.4）。 */
export const VISUAL_LANGUAGE_CATEGORIES = [
  "composition",
  "light",
  "palette",
  "mood",
  "material",
  "medium",
  "layout",
] as const;
export type VisualLanguageCategory = (typeof VISUAL_LANGUAGE_CATEGORIES)[number];

/** 规则强度（§8.4）。内容主题默认不成为生成强制元素，避免「常出现茶具→每张必须有」。 */
export type RulePolarity = "must" | "prefer" | "avoid";

/**
 * 规范化的反推证据卡（§8.3）。**不含文件路径、原文件名、图片 URL、缩略图、二进制。**
 * assetId 是本地随机 ID，仅用于 provenance 回链。
 */
export type VisualEvidenceCard = {
  assetId: string;
  captionId: string;
  captionHash: string;
  sections: Array<{ title: string; body: string }>;
  dimensions: Partial<
    Record<"composition" | "light" | "palette" | "action" | "mood", string>
  >;
  textFallback?: string;
  parseStatus: string;
  sourceClass: "imported" | "generated_confirmed" | "generated_other";
};

/** 带证据的事实（用于内容主题等），必须可回链 asset ID。 */
export type EvidenceFact = {
  value: string;
  supportingAssetIds: string[];
  coverage: number;
  confidence: number;
};

/** 多方向数据中的候选方向（§8.4：不强行平均，最多 3 个）。 */
export type CandidateDirection = {
  label: string;
  summary: string;
  supportingAssetIds: string[];
  opposingAssetIds: string[];
};

/** 冲突点（§8.4：视觉语言冲突 / 主题与风格冲突）。 */
export type EvidenceConflict = {
  description: string;
  sideA: { value: string; assetIds: string[] };
  sideB: { value: string; assetIds: string[] };
};

/** 一条视觉规则（draft 内，含证据与用户确认态）。 */
export type VisualRule = {
  category: VisualLanguageCategory;
  value: string;
  polarity: RulePolarity;
  confidence: number;
  supportingAssetIds: string[];
  opposingAssetIds: string[];
  confirmedByUser: boolean;
};

/**
 * 云端返回的未确认 draft（§8.5）。**不得直接成为项目权威**：只有用户
 * 「确认并保存」才在本地落盘为版本化 profile。
 */
export type VisualProfileDraft = {
  schemaVersion: 1;
  sourceScopeHash: string;
  summary: string;
  visualRules: VisualRule[];
  /** 内容主题默认仅作背景信息，不自动转成视觉硬约束（§8.4）。 */
  contentThemes: EvidenceFact[];
  conflicts: EvidenceConflict[];
  candidateDirections?: CandidateDirection[];
};

/** capsule 中一条规则值（已剔除证据细节，注入用，§8.8）。 */
export type VisualRuleValue = {
  category: VisualLanguageCategory;
  value: string;
  polarity: RulePolarity;
};

/**
 * 已确认视觉设定编译成的只读 capsule（§8.8）。
 * 直接生成由 PromptCompiler 注入；智能精修转成 rubric；系列导演合入 CampaignBible。
 * Agent/生成结果无权反写。
 */
export type VisualProfileCapsule = {
  schemaVersion: 1;
  profileId: string;
  version: number;
  sourceScopeHash: string;
  summary: string;
  must: VisualRuleValue[];
  prefer: VisualRuleValue[];
  avoid: VisualRuleValue[];
  /** 默认仅背景信息，不自动转成硬约束。 */
  contentThemes: string[];
  hash: string;
};
