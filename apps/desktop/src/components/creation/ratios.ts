/** 创作板「画面比例」档位（用户确认 7 档常用）。key 既用于显示也用于传参（如 "16:9"）。 */
export interface Ratio {
  /** 显示与传参用，如 "16:9" */
  key: string;
  /** icon 比例宽 */
  w: number;
  /** icon 比例高 */
  h: number;
}

export const RATIOS: Ratio[] = [
  { key: "1:1", w: 1, h: 1 },
  { key: "3:4", w: 3, h: 4 },
  { key: "4:3", w: 4, h: 3 },
  { key: "2:3", w: 2, h: 3 },
  { key: "3:2", w: 3, h: 2 },
  { key: "16:9", w: 16, h: 9 },
  { key: "9:16", w: 9, h: 16 },
];

/**
 * 「自动」比例的解析：取首个带尺寸的参考图，宽高比按对数距离吸附到最近档位
 * （对数尺度衡量比例差异，1:0.9 与 0.9:1 对称）。返回 null = 解析不了（无参考图 /
 * 无尺寸），维持「自动」交引擎默认。背景：即梦 omit `--ratio` 固定回退 16:9，
 * 不会因参考图竖屏而竖切，须前端显式选档下发。
 */
export function autoRatioFromReferences(
  refs: { width?: number | null; height?: number | null }[],
): string | null {
  const first = refs.find(
    (r) =>
      typeof r.width === "number" && typeof r.height === "number" && r.width > 0 && r.height > 0,
  );
  if (!first) return null;
  const target = Math.log(first.width! / first.height!);
  let best: Ratio | null = null;
  let bestDist = Infinity;
  for (const r of RATIOS) {
    const dist = Math.abs(Math.log(r.w / r.h) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = r;
    }
  }
  return best?.key ?? null;
}

/**
 * 把 w:h 等比缩进固定外框（max 边 = box-2，留 1px 边距），返回 icon 内嵌矩形的 px 尺寸。
 * 供 RatioIcon 的 inline style 用，视觉上直观体现比例（16:9 显扁、9:16 显高、1:1 显方）。
 */
export function ratioIconBox(
  ratio: { w: number; h: number },
  box = 16
): { width: number; height: number } {
  const inner = box - 2;
  const scale = inner / Math.max(ratio.w, ratio.h);
  return {
    width: Math.round(ratio.w * scale),
    height: Math.round(ratio.h * scale),
  };
}
