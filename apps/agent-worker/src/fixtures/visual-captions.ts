/**
 * 视觉设定 · 纯 caption fixture（V0-T3）—— 5 个场景的合成反推数据。
 *
 * 这些是**反推结构化数据**，不含图片字节/路径/URL。覆盖：
 *   单一方向 / 多个方向 / 内容主题误判 / 反推缺失 / 超大数据集。
 * 用于验证 extract/batch 的确定性、provenance 回链与视觉/内容分离。
 */

import type { VisualEvidenceCard } from "../contracts/visual-profile.ts";
import type { CaptionPayload } from "../visual/evidence.ts";
import { toEvidenceCard } from "../visual/evidence.ts";

type SourceClass = VisualEvidenceCard["sourceClass"];

function makeCard(input: {
  i: number;
  prefix?: string;
  dims?: CaptionPayload["dimensions"];
  sections?: Array<{ title: string; body: string }>;
  sourceClass?: SourceClass;
  raw?: boolean;
}): VisualEvidenceCard {
  const prefix = input.prefix ?? "a";
  const caption: CaptionPayload = input.raw
    ? { text: "无维度反推", parse_status: "raw_fallback" }
    : {
        schema_version: 2,
        parse_status: "ok",
        sections: input.sections ?? [],
        dimensions: input.dims ?? {},
      };
  return toEvidenceCard({
    assetId: `${prefix}-${input.i}`,
    captionId: `cap-${prefix}-${input.i}`,
    caption,
    sourceClass: input.sourceClass ?? "imported",
  });
}

/** 场景 1：单一方向（6 张高度一致）。 */
export function singleDirection(): VisualEvidenceCard[] {
  const dims = { composition: "居中", light: "柔光", palette: "暖色调", mood: "宁静" };
  const sections = [
    { title: "类型", body: "插画" },
    { title: "材质", body: "水彩" },
  ];
  return [1, 2, 3, 4, 5, 6].map((i) =>
    makeCard({ i, dims, sections, sourceClass: "imported" }),
  );
}

/** 场景 2：多个方向（8 张，两簇冲突）。 */
export function multipleDirections(): VisualEvidenceCard[] {
  const warm = [1, 2, 3, 4].map((i) =>
    makeCard({
      i,
      dims: { composition: "居中", palette: "暖色调", mood: "宁静" },
      sections: [{ title: "类型", body: "插画" }],
    }),
  );
  const cool = [5, 6, 7, 8].map((i) =>
    makeCard({
      i,
      dims: { composition: "对称", palette: "冷色调", mood: "冷峻" },
      sections: [{ title: "类型", body: "摄影" }],
    }),
  );
  return [...warm, ...cool];
}

/**
 * 场景 3：内容主题误判（6 张都画「茶具」，但茶具只是内容主题，
 * 视觉风格（palette/mood）一致）。验证：茶具进 contentThemes，绝不进 visualRules。
 */
export function contentThemeMisjudged(): VisualEvidenceCard[] {
  const dims = { palette: "暖色调", mood: "宁静", composition: "居中" };
  const sections = [
    { title: "主体", body: "茶具" },
    { title: "类型", body: "插画" },
  ];
  return [1, 2, 3, 4, 5, 6].map((i) => makeCard({ i, dims, sections }));
}

/** 场景 4：反推缺失（6 张里仅 2 张有效）。 */
export function missingCaption(): VisualEvidenceCard[] {
  const effective = [1, 2].map((i) =>
    makeCard({
      i,
      dims: { palette: "暖色调", mood: "宁静" },
      sections: [{ title: "类型", body: "插画" }],
    }),
  );
  const missing = [3, 4, 5, 6].map((i) => makeCard({ i, raw: true }));
  return [...effective, ...missing];
}

/** 场景 5：超大数据集（n 张一致，默认 200）。 */
export function oversized(n = 200): VisualEvidenceCard[] {
  const dims = { composition: "居中", palette: "暖色调", mood: "宁静" };
  const sections = [
    { title: "类型", body: "插画" },
    { title: "材质", body: "水彩" },
    { title: "主体", body: "茶具" },
  ];
  return Array.from({ length: n }, (_, k) => makeCard({ i: k + 1, dims, sections }));
}
