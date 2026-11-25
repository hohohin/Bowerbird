import { decodeLayerImage, type LayerDocument, type LayerRequest } from "./layerDocument";

const uploadLimit = 10 * 1024 * 1024;
// The Edge JSON request budget is 20 MiB. Reserve space for Base64 and the prompt.
export const layerReferenceBudget = 14 * 1024 * 1024;
const localImageLimit = 30 * 1024 * 1024;
const minimumSplitPixels = 512 * 512;
const maximumPixels = 36_000_000;

export class LayerImageTooLargeError extends Error {
  constructor() {
    super("云端单图上传上限为 10 MB，请压缩后重试");
  }
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function pngBlob(image: HTMLImageElement, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(image, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    canvas.width = canvas.height = 0;
    if (blob) resolve(blob);
    else reject(new Error("无法编码图层图片"));
  }, "image/png"));
}

export function layerReferenceBytes(base64: string) {
  return Math.floor(base64.length * 3 / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
}

export async function prepareLayerReference(url: string, decompose: boolean, compress = false, remainingBytes = uploadLimit): Promise<LayerRequest["reference_images"][number]> {
  const limit = Math.min(remainingBytes, uploadLimit);
  const image = await decodeLayerImage(url);
  const { naturalWidth: width, naturalHeight: height } = image;
  const minimumPixels = decompose ? minimumSplitPixels : 196;
  const validSize = (w: number, h: number) => w * h >= minimumPixels && w * h <= maximumPixels && w / h >= 1 / 16 && w / h <= 16 && (decompose || w > 14 && h > 14);
  if (!validSize(width, height)) throw new Error(decompose ? "拆分图片需为 26 万至 3600 万像素，宽高比在 1:16 至 16:1 之间" : "AI 图层参考图的像素尺寸或宽高比不受支持");
  const original = /^data:(image\/(?:png|jpeg));base64,([\s\S]+)$/.exec(url);
  if (original && layerReferenceBytes(original[2]) <= limit) {
    return { mime: original[1], base64: original[2] };
  }

  let encoded = await pngBlob(image, width, height);
  if (!compress && encoded.size > limit) throw new LayerImageTooLargeError();
  if (encoded.size > limit) {
    let scale = Math.min(.9, .95 * Math.sqrt(limit / encoded.size));
    while (encoded.size > limit) {
      const nextWidth = Math.max(1, Math.round(width * scale));
      const nextHeight = Math.max(1, Math.round(height * scale));
      if (!validSize(nextWidth, nextHeight)) throw new Error("图片压缩后会低于方舟尺寸要求，请先裁剪图片再试");
      encoded = await pngBlob(image, nextWidth, nextHeight);
      scale *= .8;
    }
  }
  return { mime: "image/png", base64: (await readDataUrl(encoded)).split(",")[1] };
}

export async function prepareLocalLayerImage(url: string) {
  const image = await decodeLayerImage(url);
  const { naturalWidth: width, naturalHeight: height } = image;
  if (width * height > maximumPixels) throw new Error("本地图层图片不得超过 3600 万像素");
  const original = /^data:image\/(?:png|jpeg);base64,/.test(url);
  if (original && url.length <= Math.floor(localImageLimit * 4 / 3)) return { width, height, dataUrl: url };
  const blob = await pngBlob(image, width, height);
  if (blob.size > localImageLimit) throw new Error("本地图层图片不得超过 30 MiB");
  return { width, height, dataUrl: await readDataUrl(blob) };
}

export async function verifyLayerImages(layers: LayerDocument["layers"]) {
  for (const { dataUrl } of layers) await decodeLayerImage(dataUrl);
}

export { readDataUrl };
