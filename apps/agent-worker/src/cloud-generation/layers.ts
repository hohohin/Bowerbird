import { hasPngAlpha, layerDecompositionOptions, LAYER_MAX_OUTPUTS, LAYER_MODEL, type LayerOptions } from "../../../cloud/supabase/functions/_shared/layer-contract.ts";
import { imageMetadata } from "../../../cloud/supabase/functions/_shared/image-metadata.ts";
import type { WorkerFetch } from "./runtime.ts";
import { Buffer } from "node:buffer";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const LAYER_DOWNLOAD_TIMEOUT_MS = 20_000;
const LAYER_DOWNLOAD_ATTEMPTS = 3;
type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);

export function layerPayload(input: { prompt: string; reference_images: { mime: string; base64: string }[] }, options: LayerOptions): Row {
  const images = input.reference_images.map(image => `data:${image.mime};base64,${image.base64}`);
  const decompose = options.operation === "decompose";
  const userPrompt = input.prompt.trim();
  const prompt = options.operation === "edit" && images.length > 1
    ? `图1是本次要修改的图层，其余图片仅用于参考光影、材质、配色与风格。只输出图1修改后的前景元素，保持透明背景。\n${userPrompt}`
    : userPrompt;
  return {
    model: LAYER_MODEL,
    ...(prompt ? { prompt } : {}),
    ...(images.length === 1 ? { image: images[0] } : images.length ? { image: images } : {}),
    size: !decompose && options.size === "auto" ? "2K" : options.size,
    output_format: "png", response_format: decompose ? "url" : "b64_json", watermark: false,
    ...(decompose
      ? { layer_decomposition: true, layer_decomposition_options: layerDecompositionOptions(options) }
      : { background: "transparent" }),
  };
}

class RetryableLayerDownloadError extends Error {}

async function readLayerDownload(url: string, fetchImpl: WorkerFetch): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LAYER_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal })
      .catch(() => { throw new RetryableLayerDownloadError("layer_download_failed"); });
    if (!response.ok) {
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new RetryableLayerDownloadError("layer_download_failed");
      }
      throw new Error("layer_download_failed");
    }
    if (Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) throw new Error("layer_image_too_large");
    if (!response.body) throw new Error("layer_download_body_missing");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read().catch(() => { throw new RetryableLayerDownloadError("layer_download_failed"); });
        if (next.done) break;
        if (!next.value) continue;
        size += next.value.length;
        if (size > MAX_IMAGE_BYTES) throw new Error("layer_image_too_large");
        chunks.push(next.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function downloadLayer(url: string, fetchImpl: WorkerFetch): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readLayerDownload(url, fetchImpl);
    } catch (error) {
      if (!(error instanceof RetryableLayerDownloadError) || attempt >= LAYER_DOWNLOAD_ATTEMPTS) throw error;
    }
    await new Promise<void>(resolve => setTimeout(() => resolve(), 200 * attempt));
  }
}

async function readLayer(row: Row, fetchImpl: WorkerFetch) {
  let bytes: Uint8Array;
  if (typeof row.b64_json === "string" && row.b64_json.length <= MAX_IMAGE_BYTES * 4 / 3 + 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(row.b64_json)) {
    bytes = Buffer.from(row.b64_json, "base64");
  } else if (typeof row.url === "string") {
    const url = new URL(row.url);
    // Only the official image-storage hosts; no credential-bearing requests or redirects.
    if (url.protocol !== "https:" || url.username || url.password || ![".volces.com", ".volcengine.com", ".byteimg.com", ".ibyteimg.com"].some(suffix => url.hostname.endsWith(suffix))) throw new Error("layer_download_host_invalid");
    bytes = await downloadLayer(row.url, fetchImpl);
  } else throw new Error("layer_image_missing");
  const metadata = imageMetadata(bytes);
  if (!metadata || bytes.length > MAX_IMAGE_BYTES || metadata.width * metadata.height > 36_000_000 || !["image/png", "image/jpeg"].includes(metadata.mime)) throw new Error("layer_image_invalid");
  return { bytes, ...metadata, dataUrl: `data:${metadata.mime};base64,${Buffer.from(bytes).toString("base64")}` };
}

const textStyleFlags = ["bold", "italic", "underline", "strikethrough", "shadow", "translucent"] as const;

function textBounds(value: unknown, width: number, height: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isInteger)) return undefined;
  const [left, top, right, bottom] = value;
  if (left < 0 || top < 0 || right > width || bottom > height || right <= left || bottom <= top) return undefined;
  return value;
}

/** OCR is optional. Preserve a valid raster layer even when a model reports incomplete text metadata. */
function parseTextRecognition(value: unknown, width: number, height: number) {
  if (!record(value) || typeof value.text !== "string" || !value.text.trim() || value.text.length > 5000 ||
      !Array.isArray(value.lines) || !value.lines.length || value.lines.length > 200) return undefined;
  const lines = [];
  let runCount = 0;
  let textLength = 0;
  for (const line of value.lines) {
    if (!record(line) || !record(line.bounding_box) || !Array.isArray(line.runs) || !line.runs.length) return undefined;
    runCount += line.runs.length;
    if (runCount > 1000) return undefined;
    const absolute = textBounds(line.bounding_box.absolute, width, height);
    const normalized = textBounds(line.bounding_box.normalized, 1000, 1000);
    if (!absolute && !normalized) return undefined;
    const runs = [];
    for (const run of line.runs) {
      if (!record(run) || typeof run.text !== "string" || !run.text || /[\r\n]/.test(run.text) || !record(run.style)) return undefined;
      textLength += run.text.length;
      if (textLength > 5000) return undefined;
      const upstream = run.style;
      const { similar_font_family, foreground_color } = upstream;
      if (typeof similar_font_family !== "string" || !similar_font_family.trim() || similar_font_family.length > 200 ||
          typeof foreground_color !== "string" || !/^#[0-9a-f]{6}$/i.test(foreground_color) ||
          textStyleFlags.some(flag => typeof upstream[flag] !== "boolean")) return undefined;
      const style = { similar_font_family, foreground_color: foreground_color.toUpperCase(),
        ...Object.fromEntries(textStyleFlags.map(flag => [flag, upstream[flag]])) };
      runs.push({ text: run.text, style });
    }
    lines.push({ bounding_box: { absolute, normalized }, runs });
  }
  return { text: value.text, lines };
}

export async function parseLayerResult(value: unknown, options: LayerOptions, fetchImpl: WorkerFetch): Promise<Uint8Array> {
  if (!record(value) || !Array.isArray(value.data) || !value.data.length || value.data.length > LAYER_MAX_OUTPUTS || !value.data.every(record)) throw new Error("layer_response_invalid");
  const rows = value.data;
  let result: unknown;
  if (options.operation !== "decompose") {
    if (rows.length !== 1) throw new Error("layer_edit_count_invalid");
    const image = await readLayer(rows[0]!, fetchImpl);
    if (!hasPngAlpha(image.bytes)) throw new Error("layer_edit_alpha_missing");
    result = { image: image.dataUrl };
  } else {
    const limits = layerDecompositionOptions(options);
    if (rows.length > limits.max_images) throw new Error("layer_response_invalid");
    if (record(value.usage) && value.usage.generated_images !== undefined && value.usage.generated_images !== rows.length) {
      throw new Error("layer_response_invalid");
    }
    const indices = new Set<number>();
    for (const row of rows) {
      const index = row.z_index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= LAYER_MAX_OUTPUTS ||
          indices.has(index) || row.error != null) throw new Error("layer_order_invalid");
      indices.add(index);
    }
    if (!indices.has(0)) throw new Error("layer_order_invalid");
    const sorted = [...rows].sort((a, b) => Number(a.z_index) - Number(b.z_index));
    const base = await readLayer(sorted[0]!, fetchImpl);
    if (base.width > 6000 || base.height > 6000) throw new Error("layer_base_size_invalid");
    const layers = []; let total = base.dataUrl.length;
    for (const row of sorted) {
      const background = row.z_index === 0;
      const image = background ? base : await readLayer(row, fetchImpl);
      if (!background && !hasPngAlpha(image.bytes)) throw new Error("layer_alpha_missing");
      const box = record(row.bounding_box) ? row.bounding_box : {};
      // Absolute coordinates are authoritative. normalized is only a fallback when absent.
      const normalized = box.normalized;
      const absolute = box.absolute ?? (Array.isArray(normalized) && normalized.length === 4
        ? normalized.map((position, index) => Number(position) / 1000 * (index % 2 === 0 ? base.width : base.height)) : undefined);
      const bounds = background ? [0, 0, base.width, base.height] : absolute;
      if (!Array.isArray(bounds) || bounds.length !== 4 || bounds.some(position => typeof position !== "number" || !Number.isFinite(position)) || bounds[0] < 0 || bounds[1] < 0 || bounds[2] > base.width || bounds[3] > base.height || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw new Error("layer_bounds_invalid");
      total += background ? 0 : image.dataUrl.length;
      if (total > MAX_BUNDLE_BYTES - 1024 * 1024) throw new Error("layer_bundle_too_large");
      const textRecognition = !background && limits.text_recognition
        ? parseTextRecognition(row.text_recognition, base.width, base.height) : undefined;
      layers.push({ id: `layer-${row.z_index}`, name: background ? "底图" : String(row.name ?? `图层 ${row.z_index}`).slice(0, 200), description: String(row.description ?? "").slice(0, 2000), dataUrl: image.dataUrl, x: bounds[0], y: bounds[1], width: bounds[2] - bounds[0], height: bounds[3] - bounds[1], opacity: 1, visible: true, background, textRecognition });
    }
    result = { document: { schemaVersion: 1, width: base.width, height: base.height, layers } };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(result));
  if (bytes.length > MAX_BUNDLE_BYTES) throw new Error("layer_bundle_too_large");
  return bytes;
}
