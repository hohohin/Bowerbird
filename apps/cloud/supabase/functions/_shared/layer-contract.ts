import { imageMetadata } from "./image-metadata.ts";

export const LAYER_MODEL = "doubao-seedream-5-0-pro-260628";
export const LAYER_SERVICES = ["image_layer_decompose", "image_layer_edit"] as const;
export interface LayerOptions { operation: "decompose" | "edit"; size: "auto" | "1K" | "1.5K" | "2K" }

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
  const options = value.layer_options as LayerOptions | undefined;
  if (!dedicated || value.media !== "image" || !options || !["auto", "1K", "1.5K", "2K"].includes(options.size) ||
      service !== (options.operation === "decompose" ? "image_layer_decompose" : options.operation === "edit" ? "image_layer_edit" : "")) throw new Error("分层操作与服务档位不匹配");
  if (!Array.isArray(value.reference_images) || value.reference_images.length !== 1) throw new Error("分层操作仅支持一张输入图片");
  const input = value.reference_images[0];
  if (!input || !["image/png", "image/jpeg"].includes(input.mime) || typeof input.base64 !== "string" || input.base64.length > 14 * 1024 * 1024) throw new Error("分层输入仅支持 10 MB 以内的 PNG/JPEG");
  let bytes: Uint8Array;
  try {
    const decode = (globalThis as unknown as { atob: (value: string) => string }).atob;
    bytes = Uint8Array.from(decode(input.base64), character => character.charCodeAt(0));
  } catch { throw new Error("图片编码无效"); }
  const metadata = imageMetadata(bytes);
  if (!metadata || metadata.mime !== input.mime || bytes.length > 10 * 1024 * 1024) throw new Error("图片格式或大小无效");
  const pixels = metadata.width * metadata.height;
  const ratio = metadata.width / metadata.height;
  if (pixels > 36_000_000 || ratio < 1 / 16 || ratio > 16 || pixels < (options.operation === "decompose" ? 262144 : 196)) throw new Error("图片像素或宽高比超出模型限制");
  if (options.operation === "edit" && (!hasPngAlpha(bytes) || metadata.width <= 14 || metadata.height <= 14 || options.size === "auto" || typeof value.prompt !== "string" || !value.prompt.trim())) throw new Error("单图层修改需要透明 PNG、有效提示词及指定输出尺寸");
  return options;
}
