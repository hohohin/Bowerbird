import { ArrowUpRight, Circle, Droplets, Eraser, Grid2X2, Highlighter, Minus, Pencil, Square, Type } from "lucide-react";
import type { AnnotationTool } from "../lib/annotation";

const TOOLS = [
  ["rect", "矩形", Square], ["ellipse", "椭圆", Circle], ["line", "直线／折线", Minus],
  ["arrow", "箭头", ArrowUpRight], ["pencil", "画笔", Pencil], ["marker", "荧光笔", Highlighter],
  ["text", "文字", Type], ["mosaic", "马赛克", Grid2X2], ["blur", "高斯模糊", Droplets], ["eraser", "橡皮擦", Eraser],
] as const;
const HINTS: Partial<Record<AnnotationTool, string>> = {
  rect: "Shift 画正方形，悬停滚轮调整粗细", ellipse: "Shift 画正圆，悬停滚轮调整粗细",
  line: "拖动画直线，连续点击画折线，右键完成", arrow: "Shift 约束方向，悬停滚轮调整粗细",
  pencil: "悬停滚轮调整粗细", marker: "悬停滚轮调整粗细",
};

/** The hosts own toolbar placement and output actions; drawing tools stay identical. */
export function AnnotationTools({ tool, onChange, disabled, className, iconSize = 18, labels = {} }: {
  tool: string; onChange: (tool: AnnotationTool) => void; disabled?: boolean;
  className: (active: boolean) => string; iconSize?: number; labels?: Partial<Record<AnnotationTool, string>>;
}) {
  return TOOLS.map(([value, name, Icon]) => {
    const label = labels[value] ?? name;
    return <button key={value} type="button" title={HINTS[value] ? `${label}：${HINTS[value]}` : label} aria-label={label} aria-pressed={tool === value}
      disabled={disabled} className={className(tool === value)} onClick={() => onChange(value)}><Icon size={iconSize} aria-hidden="true" /></button>;
  });
}
