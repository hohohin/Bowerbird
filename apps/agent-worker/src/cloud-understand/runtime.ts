import { createHash, randomUUID } from "node:crypto";

import {
  isRecord,
  KnownProviderError,
  mapArkHttpError,
  parseJson,
  safeErrorKind,
  sleep,
  type WorkerFetch,
} from "../cloud-generation/runtime.ts";

export type { WorkerFetch } from "../cloud-generation/runtime.ts";

type JsonRecord = Record<string, unknown>;

export interface UnderstandWorkerConfig {
  controlUrl: string;
  workerToken: string;
  workerId: string;
  arkApiKey: string;
  arkBaseUrl: string;
  arkVisionModel: string;
  mock: boolean;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  /** RequestBurstTooFast 自动重试上限（0 = 关闭；退避带随机抖动）。 */
  burstRetryMax: number;
  /** 退避基值毫秒（默认 1.5s；测试注入 1 加速）。 */
  burstRetryBaseMs: number;
}

interface ClaimedJob {
  job: null | { id: string; inputManifestHash: string; attempt: number };
  lease?: { leaseId: string; leaseSeconds: number };
  inputUrl?: string;
}

interface UnderstandInput {
  schema_version: number;
  operation: "caption" | "autoname" | "classify";
  /** null = 纯文本调用（生成图维度数据命名），图片不上云；caption/classify 必带一张图。 */
  image: { mime: "image/jpeg" | "image/png" | "image/webp"; base64: string } | null;
  instruction: string | null;
  mock_scenario: string | null;
}

const MOCK_UNDERSTAND_TEXT = "**类型**\nMock 图像描述\n\n**构图**\n居中构图";
const MAX_RESULT_CHARS = 65_536;

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

/** 允许 0（关闭重试）的非负整数。 */
function nonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name}_invalid`);
  return parsed;
}

/** RequestBurstTooFast 退避：base * 2^attempt + [0, 0.5倍) 随机抖动。
 * 默认 1.5s 基值、3 次重试最坏约 15s，远短于租约心跳周期，等待期间租约持续续期。 */
export function burstBackoffMs(
  attempt: number,
  baseMs = 1_500,
  random: () => number = Math.random,
): number {
  const base = baseMs * 2 ** attempt;
  return Math.round(base + base * 0.5 * random());
}

export function configFromEnv(env: Record<string, string | undefined>): UnderstandWorkerConfig {
  const workerId = env.UNDERSTAND_WORKER_ID?.trim() || `understand-${env.HOSTNAME?.trim() || randomUUID()}`;
  if (workerId.length > 120) throw new Error("UNDERSTAND_WORKER_ID_invalid");
  return {
    controlUrl: required(env, "UNDERSTAND_CONTROL_URL"),
    workerToken: required(env, "UNDERSTAND_WORKER_TOKEN"),
    workerId,
    arkApiKey: required(env, "ARK_API_KEY"),
    arkBaseUrl: (env.ARK_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, ""),
    arkVisionModel: required(env, "ARK_VISION_MODEL"),
    mock: (env.BOWERBIRD_CLOUD_MOCK ?? "false") === "true",
    pollIntervalMs: positiveInt(env.UNDERSTAND_POLL_INTERVAL_MS, 2_000, "UNDERSTAND_POLL_INTERVAL_MS"),
    heartbeatIntervalMs: positiveInt(env.UNDERSTAND_HEARTBEAT_INTERVAL_MS, 30_000, "UNDERSTAND_HEARTBEAT_INTERVAL_MS"),
    burstRetryMax: nonNegativeInt(env.UNDERSTAND_BURST_RETRY_MAX, 3, "UNDERSTAND_BURST_RETRY_MAX"),
    burstRetryBaseMs: positiveInt(env.UNDERSTAND_BURST_RETRY_BASE_MS, 1_500, "UNDERSTAND_BURST_RETRY_BASE_MS"),
  };
}

/** 与 Edge _shared/ark.ts visionPrompt 同源的兜底指令；桌面端始终显式传 instruction。 */
export function visionPrompt(input: UnderstandInput): string {
  if (input.instruction?.trim()) return input.instruction.trim();
  if (input.operation === "autoname") {
    return "请看图并严格回复两行：第一行是 8 个汉字以内的图片名称；第二行是图片描述。";
  }
  if (input.operation === "classify") {
    return "请描述图片，并在最后单独输出 [[CAT: 类别1, 类别2]]，最多两个类别。";
  }
  return "请详细分析图片，并按 **维度名** 换行正文的 Markdown 格式输出类型、构图、光影、色调、主体动作、材质、背景、氛围与反推提示词。";
}

class ControlClient {
  private readonly config: UnderstandWorkerConfig;
  private readonly fetch: WorkerFetch;

  constructor(config: UnderstandWorkerConfig, fetchImpl: WorkerFetch) {
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

class ArkVisionClient {
  private readonly config: UnderstandWorkerConfig;
  private readonly fetch: WorkerFetch;

  constructor(config: UnderstandWorkerConfig, fetchImpl: WorkerFetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async understand(input: UnderstandInput): Promise<string> {
    if (this.config.mock) return mockUnderstand(input);
    // RequestBurstTooFast（provider_burst）带抖动退避自动重试：瞬时限流重发即可能成功，
    // 请求被方舟拒绝、未产生费用，重试不构成重复计费。其余错误（含其他 429）立即抛出。
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(input);
      } catch (error) {
        if (
          error instanceof KnownProviderError && error.safeCode === "provider_burst" &&
          attempt < this.config.burstRetryMax
        ) {
          const delayMs = burstBackoffMs(attempt, this.config.burstRetryBaseMs);
          console.warn(JSON.stringify({
            event: "understand_burst_retry",
            attempt: attempt + 1,
            max: this.config.burstRetryMax,
            delay_ms: delayMs,
          }));
          await sleep(delayMs);
          continue;
        }
        throw error;
      }
    }
  }

  private async requestOnce(input: UnderstandInput): Promise<string> {
    const response = await this.fetch(`${this.config.arkBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.arkApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.arkVisionModel,
        messages: [{
          role: "user",
          content: [
            // 纯文本调用（image=null）只发 text 部分——vision 模型同样接受无图消息。
            ...(input.image
              ? [{
                type: "image_url",
                image_url: { url: `data:${input.image.mime};base64,${input.image.base64}` },
              }]
              : []),
            { type: "text", text: visionPrompt(input) },
          ],
        }],
        temperature: 0.2,
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
    const choices = isRecord(value) && Array.isArray(value.choices) ? value.choices : [];
    const message = isRecord(choices[0]) ? choices[0].message : undefined;
    const content = isRecord(message) && typeof message.content === "string" ? message.content.trim() : "";
    if (!content) throw new KnownProviderError("empty_provider_result", "豆包 Vision 未返回文本");
    if (content.length > MAX_RESULT_CHARS) {
      throw new KnownProviderError("invalid_provider_response", "豆包 Vision 返回文本超长");
    }
    return content;
  }
}

/** mock 场景与 Edge MockArkAdapter 对齐：moderation/failure 抛错、timeout 悬挂（E2E 验证租约心跳与对账）。 */
async function mockUnderstand(input: UnderstandInput): Promise<string> {
  const scenario = input.mock_scenario;
  if (scenario === "moderation") {
    throw new KnownProviderError("content_moderation", "内容未通过安全审核");
  }
  if (scenario === "failure") throw new KnownProviderError("provider_failed", "上游理解失败");
  if (scenario === "timeout") await new Promise<never>(() => {});
  return MOCK_UNDERSTAND_TEXT;
}

function parseInput(value: unknown): UnderstandInput {
  if (!isRecord(value) || value.schema_version !== 1 ||
      !["caption", "autoname", "classify"].includes(String(value.operation))) {
    throw new Error("invalid_understand_input");
  }
  // image=null 合法（纯文本命名）；带图时校验结构与编码。
  const imageOk = value.image == null ||
    (isRecord(value.image) && typeof value.image.base64 === "string" && !!value.image.base64 &&
      ["image/jpeg", "image/png", "image/webp"].includes(String(value.image.mime)));
  if (!imageOk) throw new Error("invalid_understand_input");
  return value as unknown as UnderstandInput;
}

async function fetchInput(fetchImpl: WorkerFetch, url: string, expectedHash: string): Promise<UnderstandInput> {
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
      console.error(JSON.stringify({ event: "understand_heartbeat_failed", job_id: jobId, error: safeErrorKind(error) }));
    }
  }
}

async function executeClaim(
  config: UnderstandWorkerConfig,
  control: ControlClient,
  ark: ArkVisionClient,
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
    const resultText = await ark.understand(input);
    await control.post({ action: "finish", jobId, leaseId, resultText });
    console.log(JSON.stringify({
      event: "understand_succeeded",
      job_id: jobId,
      operation: input.operation,
      chars: resultText.length,
    }));
  } catch (error) {
    const known = error instanceof KnownProviderError;
    const action = known || !submitted ? "fail" : "outcome_unknown";
    const safeErrorCode = known ? error.safeCode : safeErrorKind(error);
    const safeMessage = known
      ? error.safeMessage
      : submitted ? "请求已提交方舟，但 Worker 与上游或控制面连接中断，结果状态暂时无法确认" : "理解任务启动失败";
    try {
      await control.post({ action, jobId, leaseId, safeErrorCode, safeMessage });
    } catch (settlementError) {
      console.error(JSON.stringify({ event: "understand_settlement_failed", job_id: jobId, error: safeErrorKind(settlementError) }));
    }
    console.error(JSON.stringify({ event: `understand_${action}`, job_id: jobId, error: safeErrorCode }));
  } finally {
    heartbeatState.stopped = true;
  }
}

export async function runUnderstandWorker(
  config: UnderstandWorkerConfig,
  fetchImpl: WorkerFetch = defaultFetch(),
  stop: { requested: boolean } = { requested: false },
): Promise<void> {
  const control = new ControlClient(config, fetchImpl);
  const ark = new ArkVisionClient(config, fetchImpl);
  console.log(JSON.stringify({ event: "understand_worker_started", worker_id: config.workerId }));
  while (!stop.requested) {
    try {
      const claimed = await control.post({ action: "claim" }) as unknown as ClaimedJob;
      if (claimed.job) await executeClaim(config, control, ark, fetchImpl, claimed);
      else await sleep(config.pollIntervalMs);
    } catch (error) {
      console.error(JSON.stringify({ event: "understand_claim_failed", error: safeErrorKind(error) }));
      await sleep(Math.max(config.pollIntervalMs, 5_000));
    }
  }
}
