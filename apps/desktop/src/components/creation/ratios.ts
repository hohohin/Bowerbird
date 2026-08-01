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
