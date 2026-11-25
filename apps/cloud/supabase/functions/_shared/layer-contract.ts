import { imageMetadata } from "./image-metadata.ts";

export const LAYER_MODEL = "doubao-seedream-5-5-261028";
export const LAYER_SERVICES = ["image_layer_decompose", "image_layer_edit"] as const;
export const LAYER_MAX_OUTPUTS = 100;
export const LAYER_LEGACY_MAX_OUTPUTS = 17;
const LAYER_DEFAULT_MAX_OUTPUTS = 30;
export const LAYER_SIZES = ["auto", "1K", "1.5K", "2K"] as const;
type LayerSize = typeof LAYER_SIZES[number];
type LayerDecomposeOptions = {
  operation: "decompose";
  size: LayerSize;
  max_images?: number;
  text_recognition?: boolean;
};
export type LayerOptions = LayerDecomposeOptions | {
  operation: "edit" | "generate";
  size: LayerSize;
};

export function validLayerSize(size: unknown): size is LayerSize {
  return LAYER_SIZES.some(candidate => candidate === size);
}

export function validLayerOutputLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= LAYER_MAX_OUTPUTS;
}

export function layerDecompositionOptions(options: LayerDecomposeOptions) {
  // Published desktop versions omit both fields and accept at most 17 output images.
  const legacy = options.max_images === undefined && options.text_recognition === undefined;
  return {
    max_images: options.max_images ?? (legacy ? LAYER_LEGACY_MAX_OUTPUTS : LAYER_DEFAULT_MAX_OUTPUTS),
    text_recognition: options.text_recognition ?? !legacy,
  };
}

export function hasPngAlpha(bytes: Uint8Array): boolean {
  if (imageMetadata(bytes)?.mime !== "image/png") return false;
  if (bytes[25] === 4 || bytes[25] === 6) return true;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    const length = view.getUint32(0);
    if (length > bytes.length - offset - 12) return false;
    if (String.fromCharCode(...bytes.slice(offset + 4, offset + 8)) === "tRNS") return true;
    offset += 12 + length;
  }
  return false;
}

/** Both Edge (before a hold) and Worker (before submitted) enforce the same input contract. */
export function validateLayerRequest(value: Record<string, unknown>, service: string): LayerOptions | null {
  const dedicated = LAYER_SERVICES.includes(service as typeof LAYER_SERVICES[number]);
  if (!dedicated && value.layer_options === undefined) return null;
  if (!dedicated || value.media !== "image" || !value.layer_options ||
      typeof value.layer_options !== "object" || Array.isArray(value.layer_options)) throw new Error("分层操作与服务档位不匹配");
  const options = value.layer_options as Record<string, unknown>;
  const { operation, size, max_images, text_recognition } = options;
  if (!validLayerSize(size) ||
      (service === "image_layer_decompose" ? operation !== "decompose" : operation !== "edit" && operation !== "generate")) {
    throw new Error("分层操作与服务档位不匹配");
  }
  if (operation === "decompose") {
    if (max_images !== undefined && !validLayerOutputLimit(max_images)) throw new Error("拆分输出总数须为 2–100 的整数");
    if (text_recognition !== undefined && typeof text_recognition !== "boolean") throw new Error("拆分文字识别参数无效");
  } else {
    if (max_images !== undefined || text_recognition !== undefined) throw new Error("透明图层任务不能携带拆分参数");
    if (typeof value.prompt !== "string" || !value.prompt.trim()) throw new Error("透明图层任务需要有效提示词");
  }
  if (!Array.isArray(value.reference_images)) throw new Error("分层输入图片列表无效");
  const inputs = value.reference_images;
  if (operation === "decompose" && inputs.length !== 1) throw new Error("拆分需要一张输入图片");
  if (operation === "edit" && (inputs.length < 1 || inputs.length > 10)) throw new Error("修改需要选中图层，可附带最多 9 张上下文参考图");
  if (operation === "generate" && inputs.length !== 0) throw new Error("文生透明图层不接收参考图");
  for (const input of inputs) {
    if (!input || !["image/png", "image/jpeg"].includes(input.mime) || typeof input.base64 !== "string" || input.base64.length > 14 * 1024 * 1024) {
      throw new Error("分层输入仅支持 10 MB 以内的 PNG/JPEG");
    }
    let bytes: Uint8Array;
    try {
      const decode = (globalThis as unknown as { atob: (value: string) => string }).atob;
      bytes = Uint8Array.from(decode(input.base64), character => character.charCodeAt(0));
    } catch { throw new Error("图片编码无效"); }
    const metadata = imageMetadata(bytes);
    if (!metadata || metadata.mime !== input.mime || bytes.length > 10 * 1024 * 1024) throw new Error("图片格式或大小无效");
    const pixels = metadata.width * metadata.height;
    const ratio = metadata.width / metadata.height;
    if (pixels > 36_000_000 || ratio < 1 / 16 || ratio > 16 ||
        (operation === "decompose" ? pixels < 262144 : metadata.width <= 14 || metadata.height <= 14)) {
      throw new Error("图片像素或宽高比超出模型限制");
    }
  }
  return options as LayerOptions;
}
