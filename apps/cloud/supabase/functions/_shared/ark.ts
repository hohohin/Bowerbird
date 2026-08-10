import { ApiError } from "./errors.ts";

export type MockScenario = "success" | "async" | "moderation" | "failure" | "timeout";

export interface ImageInput {
  mime: "image/jpeg" | "image/png" | "image/webp";
  base64: string;
}

export interface GenerateInput {
  media: "image" | "video";
  prompt: string;
  referenceImages: ImageInput[];
  ratio?: string;
  scenario?: MockScenario;
}

export type GenerateResult =
  | { status: "succeeded"; images: ImageInput[]; actualCost: number }
  | { status: "queued"; remoteTaskId: string; actualCost?: number };

export interface UnderstandInput {
  operation: "caption" | "autoname" | "classify";
  image: ImageInput;
  instruction?: string;
  scenario?: MockScenario;
}

export interface UnderstandResult {
  text: string;
  sections: Array<{ title: string; body: string }>;
  categories?: string[];
  actualCost: number;
}

export interface ArkAdapter {
  generate(input: GenerateInput): Promise<GenerateResult>;
  understand(input: UnderstandInput): Promise<UnderstandResult>;
}

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const MAX_UPSTREAM_IMAGE_BYTES = 20 * 1024 * 1024;

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new ApiError("not_configured", `${name} 未配置`);
  return value;
}

function upstreamTimeout(): number {
  const value = Number.parseInt(Deno.env.get("UPSTREAM_TIMEOUT_MS") ?? "140000", 10);
  return Number.isFinite(value) && value > 0 ? value : 140_000;
}

function dataUri(image: ImageInput): string {
  return `data:${image.mime};base64,${image.base64}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function imageMime(contentType: string | null): ImageInput["mime"] {
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "image/jpeg" || mime === "image/webp") return mime;
  return "image/png";
}

function upstreamError(status: number): ApiError {
  if (status === 400 || status === 422) {
    return new ApiError("upstream_failed", "内容未通过模型校验或请求参数无效", false, 422);
  }
  if (status === 408 || status === 504) {
    return new ApiError("upstream_timeout", "方舟处理超时", true, 504);
  }
  if (status === 429) {
    return new ApiError("upstream_failed", "方舟请求繁忙，请稍后重试", true, 502);
  }
  return new ApiError("upstream_failed", "方舟服务暂时不可用", status >= 500, 502);
}

async function arkFetchJson(
  baseUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(upstreamTimeout()),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ApiError("upstream_timeout", "方舟处理超时", true, 504);
    }
    throw new ApiError("upstream_failed", "无法连接方舟服务", true, 502);
  }
  if (!response.ok) throw upstreamError(response.status);
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new ApiError("upstream_failed", "方舟返回格式无效", true, 502);
  }
}

async function imageFromUrl(url: string): Promise<ImageInput> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError("upstream_failed", "方舟返回的图片地址无效", true, 502);
  }
  if (parsed.protocol !== "https:") {
    throw new ApiError("upstream_failed", "方舟返回的图片地址不安全", true, 502);
  }
  const response = await fetch(parsed, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new ApiError("upstream_failed", "下载方舟生成图片失败", true, 502);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_UPSTREAM_IMAGE_BYTES) {
    throw new ApiError("upstream_failed", "方舟生成图片大小无效", true, 502);
  }
  return { mime: imageMime(response.headers.get("content-type")), base64: bytesToBase64(bytes) };
}

function sectionLines(text: string): Array<{ title: string; body: string }> {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections: Array<{ title: string; body: string }> = [];
  let title: string | null = null;
  let body: string[] = [];
  const flush = () => {
    const value = body.join("\n").trim();
    if (title && value) sections.push({ title, body: value });
    body = [];
  };
  for (const line of lines) {
    const heading = line.trim().match(/^(?:[-*]\s*)?\*\*([^*]{1,40})\*\*\s*[:：]?\s*(.*)$/) ??
      line.trim().match(/^#{1,4}\s+(.{1,40})$/);
    if (heading) {
      flush();
      title = heading[1].trim();
      if (heading[2]?.trim()) body.push(heading[2].trim());
    } else if (title) {
      body.push(line);
    }
  }
  flush();
  return sections;
}

function categoryMarkers(text: string): string[] | undefined {
  const match = text.match(/\[\[CAT:\s*([^\]]+)\]\]/i);
  if (!match) return undefined;
  const values = match[1]
    .split(/[,，、]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 2);
  return values.length ? values : undefined;
}

function visionPrompt(input: UnderstandInput): string {
  if (input.instruction?.trim()) return input.instruction.trim();
  if (input.operation === "autoname") {
    return "请看图并严格回复两行：第一行是 8 个汉字以内的图片名称；第二行是图片描述。";
  }
  if (input.operation === "classify") {
    return "请描述图片，并在最后单独输出 [[CAT: 类别1, 类别2]]，最多两个类别。";
  }
  return "请详细分析图片，并按 **维度名** 换行正文的 Markdown 格式输出类型、构图、光影、色调、主体动作、材质、背景、氛围与反推提示词。";
}

export class MockArkAdapter implements ArkAdapter {
  private scenario(inputScenario?: MockScenario): MockScenario {
    return inputScenario ?? (Deno.env.get("MOCK_ARK_SCENARIO") as MockScenario | undefined) ?? "success";
  }

  private async applyScenario(scenario: MockScenario): Promise<void> {
    if (scenario === "moderation") {
      throw new ApiError("upstream_failed", "内容未通过安全审核", false, 422);
    }
    if (scenario === "failure") throw new ApiError("upstream_failed", "上游生成失败", true);
    if (scenario === "timeout") await new Promise(() => {});
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const scenario = this.scenario(input.scenario);
    await this.applyScenario(scenario);
    if (scenario === "async" || input.media === "video") {
      return { status: "queued", remoteTaskId: `mock-${crypto.randomUUID()}` };
    }
    return {
      status: "succeeded",
      images: [{ mime: "image/png", base64: ONE_PIXEL_PNG }],
      actualCost: 5,
    };
  }

  async understand(input: UnderstandInput): Promise<UnderstandResult> {
    const scenario = this.scenario(input.scenario);
    await this.applyScenario(scenario);
    return {
      text: "**类型**\nMock 图像描述\n\n**构图**\n居中构图",
      sections: [
        { title: "类型", body: "Mock 图像描述" },
        { title: "构图", body: "居中构图" },
      ],
      categories: input.operation === "classify" ? ["插画"] : undefined,
      actualCost: 1,
    };
  }
}

export class VolcArkAdapter implements ArkAdapter {
  private readonly apiKey = requiredEnv("ARK_API_KEY");
  private readonly baseUrl = (Deno.env.get("ARK_BASE_URL")?.trim() || DEFAULT_ARK_BASE_URL)
    .replace(/\/+$/, "");

  async generate(input: GenerateInput): Promise<GenerateResult> {
    if (input.media === "video") {
      const model = Deno.env.get("ARK_VIDEO_MODEL")?.trim();
      if (!model || model.includes("x-x")) {
        throw new ApiError("not_configured", "Seedance 视频模型尚未配置");
      }
      throw new ApiError("not_configured", "Seedance 异步任务 adapter 尚待真实模型联调");
    }

    const model = requiredEnv("ARK_IMAGE_MODEL");
    const payload = await arkFetchJson(this.baseUrl, this.apiKey, "/images/generations", {
      model,
      prompt: input.prompt,
      ...(input.referenceImages.length ? { image: input.referenceImages.map(dataUri) } : {}),
      size: Deno.env.get("ARK_IMAGE_SIZE")?.trim() || "2K",
      response_format: "b64_json",
      watermark: false,
    });
    const data = Array.isArray(payload.data) ? payload.data as Array<Record<string, unknown>> : [];
    const images: ImageInput[] = [];
    for (const item of data) {
      if (typeof item.b64_json === "string" && item.b64_json) {
        images.push({ mime: "image/png", base64: item.b64_json });
      } else if (typeof item.url === "string" && item.url) {
        images.push(await imageFromUrl(item.url));
      }
    }
    if (!images.length) throw new ApiError("upstream_failed", "Seedream 未返回图片", true, 502);
    return { status: "succeeded", images, actualCost: 5 };
  }

  async understand(input: UnderstandInput): Promise<UnderstandResult> {
    const model = requiredEnv("ARK_VISION_MODEL");
    const payload = await arkFetchJson(this.baseUrl, this.apiKey, "/chat/completions", {
      model,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUri(input.image) } },
          { type: "text", text: visionPrompt(input) },
        ],
      }],
      temperature: 0.2,
    });
    const choices = Array.isArray(payload.choices) ? payload.choices as Array<Record<string, unknown>> : [];
    const message = choices[0]?.message as Record<string, unknown> | undefined;
    const text = typeof message?.content === "string" ? message.content.trim() : "";
    if (!text) throw new ApiError("upstream_failed", "豆包 Vision 未返回文本", true, 502);
    return {
      text,
      sections: sectionLines(text),
      categories: categoryMarkers(text),
      actualCost: 1,
    };
  }
}

export function createArkAdapter(): ArkAdapter {
  if ((Deno.env.get("BOWERBIRD_CLOUD_MOCK") ?? "true") === "true") {
    return new MockArkAdapter();
  }
  return new VolcArkAdapter();
}
