import type { CanvasRect } from "./canvasLogic";
import type { Asset } from "./types";

export const CANVAS_ARTBOARD_FROM_IMAGE = "bowerbird:canvas-artboard-from-image";
export interface ArtboardImage { nodeId: string; asset: Asset; rect: CanvasRect; order: number }
export interface ArtboardComposition {
  width: number;
  height: number;
  base: Asset | null;
  images: Array<ArtboardImage & { box: CanvasRect; visibleBox: CanvasRect; reference: number }>;
  references: Asset[];
}

export function intersectArtboard(a: CanvasRect, b: CanvasRect): CanvasRect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** Match object-fit:contain, excluding the card's caption and border. */
export function containArtboardImage(rect: CanvasRect, width: number, height: number): CanvasRect {
  const scale = Math.min(rect.width / width, rect.height / height);
  return { x: rect.x + (rect.width - width * scale) / 2, y: rect.y + (rect.height - height * scale) / 2,
    width: width * scale, height: height * scale };
}

export function artboardComposition(rect: CanvasRect, base: Asset | null, images: ArtboardImage[]): ArtboardComposition {
  if (![rect.width, rect.height].every(value => Number.isFinite(value) && value > 0)) throw new Error("画板尺寸无效");
  // Keep original base resolution where practical; cap raster memory at 2048px per side.
  const desiredScale = base?.width && base?.height ? Math.max(base.width / rect.width, base.height / rect.height) : 2;
  const scale = Math.min(desiredScale, 2048 / Math.max(rect.width, rect.height));
  const width = Math.max(1, Math.round(rect.width * scale)), height = Math.max(1, Math.round(rect.height * scale));
  const references: Asset[] = base ? [base] : [];
  const toPixels = (box: CanvasRect): CanvasRect => ({ x: (box.x - rect.x) * width / rect.width,
    y: (box.y - rect.y) * height / rect.height, width: box.width * width / rect.width, height: box.height * height / rect.height });
  const placed = [...images].sort((a, b) => a.order - b.order || a.nodeId.localeCompare(b.nodeId)).flatMap(image => {
    const clipped = intersectArtboard(rect, image.rect);
    if (!clipped) return [];
    let index = references.findIndex(asset => asset.id === image.asset.id);
    if (index < 0) { index = references.length; references.push(image.asset); }
    return [{ ...image, box: toPixels(image.rect), visibleBox: toPixels(clipped), reference: index + 3 }];
  });
  if (!base && !placed.length) throw new Error("请先将图片拖入画板范围，或以图片新建画板");
  if (references.some(asset => !asset.store_path)) throw new Error("画板中有原图不可用的素材，请重新定位或移出后再试");
  if (references.length + 2 > 10) throw new Error("画板合成最多使用 8 张不同原图（含基底）；另有 2 张位置参考图，请减少素材后重试");
  return { width, height, base, images: placed, references };
}

export function artboardCompositionPrompt(composition: ArtboardComposition, instruction: string): string {
  const { width, height, base, images } = composition;
  const box = (value: CanvasRect) => `x=${value.x.toFixed(1)}, y=${value.y.toFixed(1)}, width=${value.width.toFixed(1)}, height=${value.height.toFixed(1)}`;
  return [instruction.trim(), "", "【画板合成约束】",
    `输出构图尺寸为 ${width} × ${height}，保持此宽高比。所有坐标单位为像素，原点在画板左上角，x 向右、y 向下。`,
    "参考图1是画板的实际拼放预览，用于位置、大小和遮挡关系；参考图2是干净基底上的编号红框位置图，只作为编辑指引。",
    base ? "参考图3是未标注的原始基底。保持基底人物身份、姿态及未要求修改的区域；基底在画板内等比居中显示。" : "画板基底为纯白色。",
    "按以下清单把原始素材融入对应位置，尊重透明通道、相对大小和层叠顺序，按用户意图协调光影与遮挡。红框编号只用于定位，最终图中不要出现编号、红框或辅助标记。",
    "超出画板的部分裁切，不把画板外的区域补回。以下从底层到顶层排列；同一原图的多个实例分别放置：",
    ...images.map((image, index) => `元素 ${index + 1}（红框 ${index + 1}）使用参考图${image.reference}「${image.asset.name}」；完整位置尺寸：${box(image.box)}；画板内可见范围：${box(image.visibleBox)}。`),
  ].join("\n");
}
