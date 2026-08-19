import { supportsAnnotationCoordinates } from "./genProviders";

/**
 * 创作板把图片标注序列化成 `@图名 的【标注】：<bbox>...`。
 * 正式发送时按 provider 能力改写：
 * - 即梦 / Cloud Pro：保留坐标，改成 `@图名 <bbox>...`；
 * - 其他 provider：删除坐标，只保留 `@图名的标记位置`。
 * 编辑器原文和 rawPrompt 不变。
 */
const ANNOTATION_WITH_BODY = /@([^@\n]+?)\s*的【(?:标注|标记)】：/g;
const ANNOTATION_WITHOUT_BODY = /@([^@\n]+?)\s*的【(?:标注|标记)】/g;
const ANNOTATION_TOKEN = "(?:<bbox>[^<]*</bbox>|<point>[^<]*</point>)";
const FALLBACK_WITH_BODY = new RegExp(
  `@([^@\\n]+?)\\s*的【(?:标注|标记)】：${ANNOTATION_TOKEN}(?:\\s*、\\s*${ANNOTATION_TOKEN})*`,
  "g"
);

export function normalizeAnnotationPrompt(prompt: string, provider: string): string {
  if (supportsAnnotationCoordinates(provider)) {
    return prompt
      .replace(ANNOTATION_WITH_BODY, "@$1 ")
      .replace(ANNOTATION_WITHOUT_BODY, "@$1 ");
  }

  return prompt
    .replace(FALLBACK_WITH_BODY, "@$1的标记位置")
    .replace(ANNOTATION_WITH_BODY, "@$1的标记位置")
    .replace(ANNOTATION_WITHOUT_BODY, "@$1的标记位置");
}
