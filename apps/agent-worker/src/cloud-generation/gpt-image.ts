import { Buffer } from "node:buffer";
import { KnownProviderError, isRecord, parseJson, type GenerationInput, type WorkerFetch } from "./runtime.ts";

// Each billable service has a fixed model and quality. Changing either requires
// reviewing its price; the client cannot supply an arbitrary model or API URL.
export const GPT_IMAGE_MODELS: Readonly<Record<string, string>> = {
  image_gpt25_sunburst: "gpt-image-2.5-sunburst",
  image_gpt25_flare: "gpt-image-2.5-flare",
};

const SIZES: Readonly<Record<string, string>> = {
  "1:1": "1024x1024",
  "3:4": "960x1280",
  "4:3": "1280x960",
  "2:3": "1024x1536",
  "3:2": "1536x1024",
  "16:9": "1536x864",
  "9:16": "864x1536",
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function gptImageRequest(input: GenerationInput, model: string): { url: string; body: string } {
  const size = input.ratio ? SIZES[input.ratio] : "1024x1024";
  if (typeof size !== "string" || input.layer_options || !Object.values(GPT_IMAGE_MODELS).includes(model)) {
    throw new KnownProviderError("invalid_provider_request", "GPT Image 的模型、比例或图层参数无效");
  }
  if (input.reference_images.length > 10 || input.reference_images.some(image =>
    !["image/png", "image/jpeg", "image/webp"].includes(image.mime) || !image.base64 ||
    `data:${image.mime};base64,${image.base64}`.length > 20_971_520)) {
    throw new KnownProviderError("invalid_reference_image", "GPT Image 参考图格式或大小无效");
  }
  const edit = input.reference_images.length > 0;
  return {
    url: `https://api.openai.com/v1/images/${edit ? "edits" : "generations"}`,
    body: JSON.stringify({
      model, prompt: input.prompt, n: 1, size, quality: "high", output_format: "png",
      background: input.transparent ? "transparent" : "opaque",
      ...(edit ? { images: input.reference_images.map(image => ({
        image_url: `data:${image.mime};base64,${image.base64}`,
      })) } : {}),
    }),
  };
}

export async function generateGptImage(
  apiKey: string,
  request: { url: string; body: string },
  fetchImpl: WorkerFetch,
): Promise<{ mime: "image/png"; bytes: Uint8Array }> {
  // One submission only. Transport errors, 5xx/408 and malformed success replies
  // leave the job outcome unknown: they must not cause a retry or a refund.
  let response: Awaited<ReturnType<WorkerFetch>>;
  let value: unknown;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: request.body,
      redirect: "error",
    });
    value = parseJson(await response.text());
  } catch {
    throw new Error("openai_transport_unknown");
  }
  if (!response.ok) {
    const error = isRecord(value) && isRecord(value.error) ? value.error : {};
    if (response.status === 400 && error.code === "moderation_blocked") {
      throw new KnownProviderError("content_moderation", "内容未通过 OpenAI 安全审核");
    }
    if (response.status === 401 || response.status === 403) {
      throw new KnownProviderError("provider_not_authorized", "GPT Image API key 或模型权限不可用，请联系管理员");
    }
    if (response.status === 429) throw new KnownProviderError("provider_busy", "GPT Image 配额或请求速率受限，请稍后重试");
    if ([400, 404, 413, 422].includes(response.status)) {
      throw new KnownProviderError("invalid_provider_request", "OpenAI 拒绝了生成参数，请检查模型权限和参考图");
    }
    throw new Error("openai_outcome_unknown");
  }
  const data = isRecord(value) && Array.isArray(value.data) ? value.data : [];
  const encoded = data.length === 1 && isRecord(data[0]) ? data[0].b64_json : null;
  if (typeof encoded !== "string" || !encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("openai_invalid_image_result");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 24 || bytes.length > MAX_IMAGE_BYTES || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error("openai_invalid_image_result");
  }
  return { mime: "image/png", bytes };
}
