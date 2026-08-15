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
export const DEFAULT_IMAGE_UPSTREAM_TIMEOUT_MS = 135_000;

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new ApiError("not_configured", `${name} 未配置`);
  return value;
}

function upstreamTimeout(): number {
  const value = Number.parseInt(
    Deno.env.get("ARK_IMAGE_TIMEOUT_MS") ?? String(DEFAULT_IMAGE_UPSTREAM_TIMEOUT_MS),
    10,
  );
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_IMAGE_UPSTREAM_TIMEOUT_MS;
}

function understandUpstreamTimeout(): number {
  const value = Number.parseInt(Deno.env.get("UNDERSTAND_UPSTREAM_TIMEOUT_MS") ?? "110000", 10);
  return Number.isFinite(value) && value > 0 ? value : 110_000;
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

interface ArkErrorInfo {
  code?: string;
  requestId?: string;
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(trimmed) ? trimmed : undefined;
}

function arkErrorInfo(body: string, headerRequestId?: string | null): ArkErrorInfo {
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // 非 JSON 上游响应不进入用户提示，避免泄漏未知正文。
  }
  const nested = value.error && typeof value.error === "object"
    ? value.error as Record<string, unknown>
    : {};
  return {
    code: safeIdentifier(nested.code) ?? safeIdentifier(value.code),
    requestId: safeIdentifier(nested.request_id) ?? safeIdentifier(value.request_id) ??
      safeIdentifier(headerRequestId),
  };
}

function arkErrorSuffix(info: ArkErrorInfo): string {
  const parts = [
    info.code ? `方舟错误码：${info.code}` : undefined,
    info.requestId ? `请求 ID：${info.requestId}` : undefined,
  ].filter(Boolean);
  return parts.length ? `（${parts.join("；")}）` : "";
}

export function upstreamError(
  status: number,
  body = "",
  headerRequestId?: string | null,
): ApiError {
  const info = arkErrorInfo(body, headerRequestId);
  const code = info.code?.toLowerCase() ?? "";
  const suffix = arkErrorSuffix(info);
  if (status === 400 || status === 422) {
    if (code.includes("sensitive") || code.includes("moderation")) {
      let subject = "生成结果";
      if (code.includes("inputtext")) subject = "提示词";
      else if (code.includes("inputimage")) subject = "参考图";
      return new ApiError("upstream_failed", `${subject}未通过方舟安全审核${suffix}`, false, 422);
    }
    if (
      code.includes("image") &&
      ["invalid", "decode", "format", "size", "resolution", "ratio", "unsupported"]
        .some((marker) => code.includes(marker))
    ) {
      return new ApiError(
        "upstream_failed",
        `参考图无法被方舟读取，请检查格式、尺寸与宽高比${suffix}`,
        false,
        422,
      );
    }
    return new ApiError("upstream_failed", `方舟拒绝了生成参数${suffix}`, false, 422);
  }
  if (status === 408 || status === 504) {
    return new ApiError("upstream_timeout", `方舟处理超时${suffix}`, true, 504);
  }
  if (status === 429) {
    return new ApiError("upstream_failed", `方舟请求繁忙，请稍后重试${suffix}`, true, 502);
  }
  return new ApiError("upstream_failed", `方舟服务暂时不可用${suffix}`, status >= 500, 502);
}

type ArkTransportKind =
  | "timeout"
  | "dns"
  | "tls"
  | "connection_reset"
  | "connection_refused"
  | "network_unreachable"
  | "transport";

function arkTransportKind(error: unknown, elapsedMs: number, timeoutMs: number): ArkTransportKind {
  const cause = error instanceof Error && "cause" in error ? error.cause : undefined;
  const text = [
    error instanceof Error ? error.name : "",
    error instanceof Error ? error.message : String(error),
    cause instanceof Error ? cause.name : "",
    cause instanceof Error ? cause.message : String(cause ?? ""),
    cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "",
  ].join(" ").toLowerCase();
  if (
    text.includes("timeouterror") || text.includes("aborterror") ||
    elapsedMs >= timeoutMs - 1_000
  ) return "timeout";
  if (/(dns|name or service not known|failed to lookup|enotfound)/.test(text)) return "dns";
  if (/(tls|certificate|ssl)/.test(text)) return "tls";
  if (/(connection reset|econnreset)/.test(text)) return "connection_reset";
  if (/(connection refused|econnrefused)/.test(text)) return "connection_refused";
  if (/(network is unreachable|enetunreach)/.test(text)) return "network_unreachable";
  return "transport";
}

export function arkTransportError(
  error: unknown,
  elapsedMs: number,
  timeoutMs: number,
): { error: ApiError; kind: ArkTransportKind } {
  const kind = arkTransportKind(error, elapsedMs, timeoutMs);
  if (kind === "timeout") {
    return { error: new ApiError("upstream_timeout", "方舟处理超时，请重试", true, 504), kind };
  }
  const detail: Record<Exclude<ArkTransportKind, "timeout">, string> = {
    dns: "DNS 解析失败",
    tls: "TLS 握手失败",
    connection_reset: "连接被重置",
    connection_refused: "连接被拒绝",
    network_unreachable: "网络不可达",
    transport: "网络传输失败",
  };
  return {
    error: new ApiError("upstream_failed", `无法连接方舟服务（${detail[kind]}）`, true, 502),
    kind,
  };
}

async function arkFetchJson(
  baseUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
  timeoutMs = upstreamTimeout(),
): Promise<Record<string, unknown>> {
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const elapsedMs = performance.now() - started;
    const mapped = arkTransportError(error, elapsedMs, timeoutMs);
    console.warn(JSON.stringify({
      event: "ark_transport_error",
      kind: mapped.kind,
      elapsed_ms: Math.round(elapsedMs),
    }));
    throw mapped.error;
  }
  const responseBody = await response.text();
  if (!response.ok) {
    throw upstreamError(
      response.status,
      responseBody,
      response.headers.get("x-request-id") ?? response.headers.get("x-tt-logid"),
    );
  }
  try {
    return JSON.parse(responseBody) as Record<string, unknown>;
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
    }, understandUpstreamTimeout());
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
