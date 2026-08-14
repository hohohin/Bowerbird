/**
 * 视觉设定 · 反推证据规范化（V0）—— 依据 AGENT-RUNTIME-PLAN.md §8.3。
 *
 * 纯函数：把已有 caption payload 规范化为 VisualEvidenceCard。
 * **不读取图片文件、不调用 Vision、不自动补反推**（§8.2 三条不可变边界）。
 * 规范化结果不含文件路径、原文件名、URL、缩略图、二进制。
 */

import type { VisualEvidenceCard } from "../contracts/visual-profile.ts";
import { canonicalJson, sha256Hex } from "../kernel/tool-ledger.ts";

/** 桌面端 caption payload 形状（PROJECT.md §10 / caption.rs）。兼容旧 {text}。 */
export type CaptionPayload = {
  schema_version?: number;
  text?: string;
  instruction?: string;
  session_id?: string;
  sections?: Array<{ title: string; body: string }>;
  dimensions?: Partial<
    Record<"composition" | "light" | "palette" | "action" | "mood", string>
  >;
  parse_status?: string;
};

export type NormalizedCaption = {
  sections: Array<{ title: string; body: string }>;
  dimensions: Partial<Record<"composition" | "light" | "palette" | "action" | "mood", string>>;
  textFallback?: string;
  parseStatus: string;
  /** caption 整体内容 hash（provenance/去重用）。 */
  hash: string;
  /** 是否为可参与提炼的有效反推。 */
  effective: boolean;
};

export function normalizeCaption(raw: CaptionPayload): NormalizedCaption {
  const sections = raw.sections ?? [];
  const dimensions = raw.dimensions ?? {};
  const parseStatus = raw.parse_status ?? (sections.length ? "ok" : "raw_fallback");
  const textFallback = raw.text;
  const hash = sha256Hex(canonicalJson({ s: sections, d: dimensions, t: textFallback ?? "" }));
  const effective = sections.length > 0 || Object.keys(dimensions).length > 0;
  return { sections, dimensions, textFallback, parseStatus, hash, effective };
}

/**
 * 把规范化 caption 包成证据卡。sourceClass 由调用方按资产来源标注：
 * 采集图=imported；用户确认过的生成图=generated_confirmed；其余生成图=generated_other。
 */
export function toEvidenceCard(input: {
  assetId: string;
  captionId: string;
  caption: CaptionPayload;
  sourceClass: VisualEvidenceCard["sourceClass"];
}): VisualEvidenceCard {
  const n = normalizeCaption(input.caption);
  return {
    assetId: input.assetId,
    captionId: input.captionId,
    captionHash: n.hash,
    sections: n.sections,
    dimensions: n.dimensions,
    textFallback: n.textFallback,
    parseStatus: n.parseStatus,
    sourceClass: input.sourceClass,
  };
}

/** section 标题 → 视觉语言类别 别名（提炼归纳用，闭集受控）。 */
export const SECTION_CATEGORY_ALIASES: Readonly<Record<string, "material" | "medium" | "layout">> = {
  材质: "material",
  笔触: "material",
  类型: "medium",
  媒介: "medium",
  版式: "layout",
};

/** 内容主题类 section 标题（默认仅背景信息，不转视觉硬约束，§8.4）。 */
export const CONTENT_THEME_SECTION_TITLES = new Set([
  "主体",
  "内容",
  "题材",
  "主题",
  "内容主题",
]);
