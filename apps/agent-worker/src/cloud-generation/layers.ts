import { hasPngAlpha, LAYER_MODEL, type LayerOptions } from "../../../cloud/supabase/functions/_shared/layer-contract.ts";
import { imageMetadata } from "../../../cloud/supabase/functions/_shared/image-metadata.ts";
import type { WorkerFetch } from "./runtime.ts";
import { Buffer } from "node:buffer";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);

export function layerPayload(input: { prompt: string; reference_images: { mime: string; base64: string }[] }, options: LayerOptions) {
  const image = input.reference_images[0]!;
  return {
    model: LAYER_MODEL,
    ...(input.prompt.trim() ? { prompt: input.prompt.trim() } : {}),
    image: `data:${image.mime};base64,${image.base64}`,
    size: options.size, output_format: "png", response_format: "b64_json", watermark: false,
    ...(options.operation === "decompose" ? { layer_decomposition: true } : { background: "transparent" }),
  };
}

async function readLayer(row: Row, fetchImpl: WorkerFetch) {
  let bytes: Uint8Array;
  if (typeof row.b64_json === "string" && row.b64_json.length <= MAX_IMAGE_BYTES * 4 / 3 + 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(row.b64_json)) {
    bytes = Buffer.from(row.b64_json, "base64");
  } else if (typeof row.url === "string") {
    const url = new URL(row.url);
    // Only the official image-storage hosts; no credential-bearing requests or redirects.
    if (url.protocol !== "https:" || url.username || url.password || ![".volces.com", ".volcengine.com", ".byteimg.com", ".ibyteimg.com"].some(suffix => url.hostname.endsWith(suffix))) throw new Error("layer_download_host_invalid");
    const response = await fetchImpl(row.url, { method: "GET", redirect: "error" });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) throw new Error("layer_download_failed");
    if (!response.body) throw new Error("layer_download_body_missing");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const next = await reader.read(); if (next.done) break; if (!next.value) continue; size += next.value.length; if (size > MAX_IMAGE_BYTES) throw new Error("layer_image_too_large"); chunks.push(next.value); }
    } finally { await reader.cancel(); }
    bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  } else throw new Error("layer_image_missing");
  const metadata = imageMetadata(bytes);
  if (!metadata || bytes.length > MAX_IMAGE_BYTES || metadata.width * metadata.height > 36_000_000 || !["image/png", "image/jpeg"].includes(metadata.mime)) throw new Error("layer_image_invalid");
  return { bytes, ...metadata, dataUrl: `data:${metadata.mime};base64,${Buffer.from(bytes).toString("base64")}` };
}

export async function parseLayerResult(value: unknown, options: LayerOptions, fetchImpl: WorkerFetch): Promise<Uint8Array> {
  if (!record(value) || !Array.isArray(value.data) || !value.data.length || value.data.length > 17 || !value.data.every(record)) throw new Error("layer_response_invalid");
  const rows = value.data;
  let result: unknown;
  if (options.operation === "edit") {
    if (rows.length !== 1) throw new Error("layer_edit_count_invalid");
    const image = await readLayer(rows[0]!, fetchImpl);
    if (!hasPngAlpha(image.bytes)) throw new Error("layer_edit_alpha_missing");
    result = { image: image.dataUrl };
  } else {
    const indices = rows.map(row => row.z_index);
    if (indices.some(index => !Number.isInteger(index) || Number(index) < 0 || Number(index) > 16) || new Set(indices).size !== rows.length || !indices.includes(0)) throw new Error("layer_order_invalid");
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
      layers.push({ id: `layer-${row.z_index}`, name: background ? "底图" : String(row.name ?? `图层 ${row.z_index}`).slice(0, 200), description: String(row.description ?? "").slice(0, 2000), dataUrl: image.dataUrl, x: bounds[0], y: bounds[1], width: bounds[2] - bounds[0], height: bounds[3] - bounds[1], opacity: 1, visible: true, background });
    }
    result = { document: { schemaVersion: 1, width: base.width, height: base.height, layers } };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(result));
  if (bytes.length > MAX_BUNDLE_BYTES) throw new Error("layer_bundle_too_large");
  return bytes;
}
