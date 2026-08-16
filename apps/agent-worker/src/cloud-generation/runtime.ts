import { createHash, randomUUID } from "node:crypto";

type JsonRecord = Record<string, unknown>;

interface HttpHeaders {
  get(name: string): string | null;
}

interface HttpResponse {
  ok: boolean;
  status: number;
  headers: HttpHeaders;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface HttpRequest {
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export type WorkerFetch = (url: string, request?: HttpRequest) => Promise<HttpResponse>;

export interface GenerationWorkerConfig {
  controlUrl: string;
  workerToken: string;
  workerId: string;
  arkApiKey: string;
  arkBaseUrl: string;
  arkImageModel: string;
  arkImageSize: string;
  mock: boolean;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
}

interface ClaimedJob {
  job: null | { id: string; service: string; inputManifestHash: string; inputCount: number; attempt: number };
  lease?: { leaseId: string; leaseSeconds: number };
  inputUrl?: string;
}

interface GenerationInput {
  schema_version: number;
  media: "image";
  prompt: string;
  reference_images: Array<{ mime: "image/jpeg" | "image/png" | "image/webp"; base64: string }>;
  ratio?: string | null;
  mock_scenario?: string | null;
}

interface GeneratedImage {
  mime: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
}

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function defaultFetch(): WorkerFetch {
  const candidate = (globalThis as unknown as { fetch?: WorkerFetch }).fetch;
  if (!candidate) throw new Error("fetch_unavailable");
  return candidate.bind(globalThis);
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name}_missing`);
  return value;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name}_invalid`);
  return parsed;
}

export function configFromEnv(env: Record<string, string | undefined>): GenerationWorkerConfig {
  const workerId = env.GENERATION_WORKER_ID?.trim() || `generation-${env.HOSTNAME?.trim() || randomUUID()}`;
  if (workerId.length > 120) throw new Error("GENERATION_WORKER_ID_invalid");
  return {
    controlUrl: required(env, "GENERATION_CONTROL_URL"),
    workerToken: required(env, "GENERATION_WORKER_TOKEN"),
    workerId,
    arkApiKey: required(env, "ARK_API_KEY"),
    arkBaseUrl: (env.ARK_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, ""),
    arkImageModel: required(env, "ARK_IMAGE_MODEL"),
    arkImageSize: env.ARK_IMAGE_SIZE?.trim() || "2K",
    mock: (env.BOWERBIRD_CLOUD_MOCK ?? "false") === "true",
    pollIntervalMs: positiveInt(env.GENERATION_POLL_INTERVAL_MS, 2_000, "GENERATION_POLL_INTERVAL_MS"),
    heartbeatIntervalMs: positiveInt(env.GENERATION_HEARTBEAT_INTERVAL_MS, 30_000, "GENERATION_HEARTBEAT_INTERVAL_MS"),
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.trim())
    ? value.trim()
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function bytesFromBase64(value: string): Uint8Array {
  const decode = (globalThis as unknown as { atob?: (input: string) => string }).atob;
  if (!decode) throw new KnownProviderError("invalid_provider_response", "方舟图片解码失败");
  const binary = decode(value);
  if (!binary.length || binary.length > MAX_IMAGE_BYTES) {
    throw new KnownProviderError("invalid_provider_response", "方舟生成图片大小无效");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function imageMime(contentType: string | null): GeneratedImage["mime"] {
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "image/jpeg" || mime === "image/webp") return mime;
  return "image/png";
}

export class KnownProviderError extends Error {
  readonly safeCode: string;
  readonly safeMessage: string;

  constructor(safeCode: string, safeMessage: string) {
    super(safeCode);
    this.name = "KnownProviderError";
    this.safeCode = safeCode;
    this.safeMessage = safeMessage;
  }
}

export function mapArkHttpError(status: number, body: string, requestIdHeader?: string | null): KnownProviderError {
  const value = parseJson(body);
  const record = isRecord(value) ? value : {};
  const nested = isRecord(record.error) ? record.error : {};
  const code = safeIdentifier(nested.code) ?? safeIdentifier(record.code);
  const requestId = safeIdentifier(nested.request_id) ?? safeIdentifier(record.request_id) ?? safeIdentifier(requestIdHeader);
  const suffix = [code ? `方舟错误码：${code}` : "", requestId ? `请求 ID：${requestId}` : ""]
    .filter(Boolean).join("；");
  const detail = suffix ? `（${suffix}）` : "";
  const lowered = code?.toLowerCase() ?? "";
  if (status === 400 || status === 422) {
    if (lowered.includes("sensitive") || lowered.includes("moderation")) {
      const subject = lowered.includes("inputtext") ? "提示词" : lowered.includes("inputimage") ? "参考图" : "生成结果";
      return new KnownProviderError("content_moderation", `${subject}未通过方舟安全审核${detail}`);
    }
    if (lowered.includes("image") && ["invalid", "decode", "format", "size", "resolution", "ratio", "unsupported"].some((part) => lowered.includes(part))) {
      return new KnownProviderError("invalid_reference_image", `参考图无法被方舟读取，请检查格式、尺寸与宽高比${detail}`);
    }
    return new KnownProviderError("invalid_provider_request", `方舟拒绝了生成参数${detail}`);
  }
  if (status === 408 || status === 504) return new KnownProviderError("provider_timeout", `方舟服务返回处理超时${detail}`);
  if (status === 429) return new KnownProviderError("provider_busy", `方舟请求繁忙，请稍后重试${detail}`);
  return new KnownProviderError("provider_failed", `方舟服务暂时不可用${detail}`);
}

class ControlClient {
  private readonly config: GenerationWorkerConfig;
  private readonly fetch: WorkerFetch;

  constructor(config: GenerationWorkerConfig, fetchImpl: WorkerFetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async post(body: JsonRecord): Promise<JsonRecord> {
    const response = await this.fetch(this.config.controlUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.workerToken}`,
        "content-type": "application/json",
        "x-worker-id": this.config.workerId,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const value = parseJson(text);
    if (!response.ok || !isRecord(value)) throw new Error(`control_http_${response.status}`);
    return value;
  }
}

class ArkImageClient {
  private readonly config: GenerationWorkerConfig;
  private readonly fetch: WorkerFetch;

  constructor(config: GenerationWorkerConfig, fetchImpl: WorkerFetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async generate(input: GenerationInput): Promise<GeneratedImage> {
    if (this.config.mock) return { mime: "image/png", bytes: bytesFromBase64(ONE_PIXEL_PNG) };
    const response = await this.fetch(`${this.config.arkBaseUrl}/images/generations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.arkApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.arkImageModel,
        prompt: input.prompt,
        ...(input.reference_images.length
          ? { image: input.reference_images.map((image) => `data:${image.mime};base64,${image.base64}`) }
          : {}),
        size: this.config.arkImageSize,
        response_format: "b64_json",
        watermark: false,
      }),
      // Deliberately no AbortSignal timeout. The durable lease heartbeat, not
      // an Edge wall-clock deadline, owns liveness while Ark is still waiting.
    });
    const text = await response.text();
    if (!response.ok) {
      throw mapArkHttpError(
        response.status,
        text,
        response.headers.get("x-request-id") ?? response.headers.get("x-tt-logid"),
      );
    }
    const value = parseJson(text);
    const data = isRecord(value) && Array.isArray(value.data) ? value.data : [];
    const first = data.find(isRecord);
    if (!first) throw new KnownProviderError("empty_provider_result", "Seedream 未返回图片");
    if (typeof first.b64_json === "string" && first.b64_json) {
      return { mime: "image/png", bytes: bytesFromBase64(first.b64_json) };
    }
    if (typeof first.url === "string" && first.url.startsWith("https://")) {
      return await this.download(first.url);
    }
    throw new KnownProviderError("invalid_provider_response", "方舟返回的图片格式无效");
  }

  private async download(url: string): Promise<GeneratedImage> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.fetch(url, { method: "GET" });
        if (!response.ok) throw new Error(`image_download_http_${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("image_download_size");
        return { mime: imageMime(response.headers.get("content-type")), bytes };
      } catch (error) {
        lastError = error;
        if (attempt < 2) await sleep(2_000 * (attempt + 1));
      }
    }
    throw new KnownProviderError("provider_result_download_failed", `方舟已返回结果，但图片下载失败：${safeErrorKind(lastError)}`);
  }
}

function safeErrorKind(error: unknown): string {
  if (error instanceof KnownProviderError) return error.safeCode;
  if (error instanceof Error && /^[A-Za-z0-9._:-]{1,80}$/.test(error.message)) return error.message;
  return "network_error";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function parseInput(value: unknown): GenerationInput {
  if (!isRecord(value) || value.schema_version !== 1 || value.media !== "image" ||
      typeof value.prompt !== "string" || !Array.isArray(value.reference_images)) {
    throw new Error("invalid_generation_input");
  }
  return value as unknown as GenerationInput;
}

async function fetchInput(fetchImpl: WorkerFetch, url: string, expectedHash: string): Promise<GenerationInput> {
  const response = await fetchImpl(url, { method: "GET" });
  if (!response.ok) throw new Error(`input_http_${response.status}`);
  const text = await response.text();
  const actualHash = createHash("sha256").update(text).digest("hex");
  if (actualHash !== expectedHash) throw new Error("input_manifest_hash_mismatch");
  return parseInput(parseJson(text));
}

async function heartbeatLoop(control: ControlClient, jobId: string, leaseId: string, intervalMs: number, state: { stopped: boolean }): Promise<void> {
  while (!state.stopped) {
    await sleep(intervalMs);
    if (state.stopped) return;
    try {
      await control.post({ action: "heartbeat", jobId, leaseId });
    } catch (error) {
      console.error(JSON.stringify({ event: "generation_heartbeat_failed", job_id: jobId, error: safeErrorKind(error) }));
    }
  }
}

async function executeClaim(
  config: GenerationWorkerConfig,
  control: ControlClient,
  ark: ArkImageClient,
  fetchImpl: WorkerFetch,
  claimed: ClaimedJob,
): Promise<void> {
  if (!claimed.job || !claimed.lease?.leaseId || !claimed.inputUrl) throw new Error("invalid_claim_response");
  const { id: jobId, inputManifestHash } = claimed.job;
  const leaseId = claimed.lease.leaseId;
  const heartbeatState = { stopped: false };
  void heartbeatLoop(control, jobId, leaseId, config.heartbeatIntervalMs, heartbeatState);
  let submitted = false;
  try {
    const input = await fetchInput(fetchImpl, claimed.inputUrl, inputManifestHash);
    await control.post({ action: "submitted", jobId, leaseId });
    submitted = true;
    const image = await ark.generate(input);
    const upload = await control.post({ action: "output_upload", jobId, leaseId, mime: image.mime });
    if (typeof upload.uploadUrl !== "string" || typeof upload.objectKey !== "string") {
      throw new Error("invalid_upload_response");
    }
    const uploaded = await fetchImpl(upload.uploadUrl, {
      method: "PUT",
      headers: { "content-type": image.mime, "x-upsert": "true" },
      body: image.bytes,
    });
    if (!uploaded.ok) throw new Error(`output_upload_http_${uploaded.status}`);
    await control.post({
      action: "finish",
      jobId,
      leaseId,
      objectKey: upload.objectKey,
      mime: image.mime,
      bytes: image.bytes.byteLength,
      sha256: sha256(image.bytes),
    });
    console.log(JSON.stringify({ event: "generation_succeeded", job_id: jobId, bytes: image.bytes.byteLength }));
  } catch (error) {
    const known = error instanceof KnownProviderError;
    const action = known || !submitted ? "fail" : "outcome_unknown";
    const safeErrorCode = known ? error.safeCode : safeErrorKind(error);
    const safeMessage = known
      ? error.safeMessage
      : submitted ? "请求已提交方舟，但 Worker 与上游或控制面连接中断，结果状态暂时无法确认" : "生成任务启动失败";
    try {
      await control.post({ action, jobId, leaseId, safeErrorCode, safeMessage });
    } catch (settlementError) {
      console.error(JSON.stringify({ event: "generation_settlement_failed", job_id: jobId, error: safeErrorKind(settlementError) }));
    }
    console.error(JSON.stringify({ event: `generation_${action}`, job_id: jobId, error: safeErrorCode }));
  } finally {
    heartbeatState.stopped = true;
  }
}

export async function runGenerationWorker(
  config: GenerationWorkerConfig,
  fetchImpl: WorkerFetch = defaultFetch(),
  stop: { requested: boolean } = { requested: false },
): Promise<void> {
  const control = new ControlClient(config, fetchImpl);
  const ark = new ArkImageClient(config, fetchImpl);
  console.log(JSON.stringify({ event: "generation_worker_started", worker_id: config.workerId }));
  while (!stop.requested) {
    try {
      const claimed = await control.post({ action: "claim" }) as unknown as ClaimedJob;
      if (claimed.job) await executeClaim(config, control, ark, fetchImpl, claimed);
      else await sleep(config.pollIntervalMs);
    } catch (error) {
      console.error(JSON.stringify({ event: "generation_claim_failed", error: safeErrorKind(error) }));
      await sleep(Math.max(config.pollIntervalMs, 5_000));
    }
  }
}
