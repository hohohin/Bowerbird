import { randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ChatModelObservation } from "../../../cloud/supabase/functions/_shared/chat.ts";
import type { DeepSeekConfig } from "../providers/deepseek/backend.ts";
import {
  AgentControlError,
  type PreparedToolCall,
  type RegisteredAgentArtifact,
} from "../control-plane/agent-control-client.ts";
import {
  DurableProviderError,
  DurableToolDispatcher,
  type DurableToolAdapter,
  type DurableToolControl,
} from "../kernel/durable-tool-dispatcher.ts";
import { canonicalJson, sha256Hex } from "../kernel/tool-ledger.ts";

const REQUEST_PATH = "/chat/completions";
const DEFAULT_MAX_MODEL_TURNS = 32;
const MAX_UPSTREAM_ATTEMPTS = 2;
const RETRYABLE_UPSTREAM_STATUSES = new Set([502, 503, 504]);
const DEEPSEEK_CHAT_API_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_CHAT_CONTEXT_TOKENS = 1_048_576;
export const DEEPSEEK_CHAT_MAX_OUTPUT_TOKENS = 393_216;

type JsonRecord = Record<string, unknown>;

export type MeteredDeepSeekProxyControl = DurableToolControl & {
  uploadDiagnostic(args: {
    runId: string;
    leaseId: string;
    sourceCallId: string;
    stepId: string;
    bytes: Uint8Array;
    sha256: string;
  }): Promise<RegisteredAgentArtifact>;
  getArtifactByCall(runId: string, leaseId: string, callId: string): Promise<RegisteredAgentArtifact>;
  downloadVerifiedBytes(url: string, expected: { sha256: string; bytes: number }, maxBytes?: number): Promise<Uint8Array>;
  recordUsage(args: {
    runId: string;
    leaseId: string;
    callId: string;
    kind: "model_tokens";
    provider: "deepseek";
    model: string;
    inputUnits: number;
    outputUnits: number;
    imageCount: 0;
  }): Promise<void>;
};

export type MeteredDeepSeekProxyFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal; redirect?: "error" },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type MeteredDeepSeekProxyOptions = {
  runId: string;
  leaseId: string;
  phase: "compose_plan" | "execute_approved_plan" | "agent_ds_local";
  control: MeteredDeepSeekProxyControl;
  upstream: DeepSeekConfig;
  allowInsecureLoopback?: boolean;
  maxModelTurns?: number;
  signal?: { readonly aborted: boolean };
  allowedToolNames?: readonly string[];
  systemPolicy?: string;
  fetch?: MeteredDeepSeekProxyFetch;
  /** Optional test-only observer for unexpected local persistence/control errors. */
  onUnexpectedError?: (error: unknown, identity: {
    callId: string;
    phase: string;
    toolName: string;
  }) => void;
};

// Chat has its own job/lease and settlement ledger; no Agent Run artifacts are created.
export type ChatModelProxyOptions = Omit<MeteredDeepSeekProxyOptions, "phase" | "control" | "maxModelTurns" | "signal"> & {
  phase: "chat";
  signal?: AbortSignal;
  paidMaxOutputTokens?: number;
  beforeModel(request: Record<string, unknown>): Promise<void>;
  onModelSubmit(callId: string, paidOutputTokens?: number): Promise<void>;
  onModelObservation(callId: string, observation: ChatModelObservation): Promise<void>;
  onUsage(usage: { inputUnits: number; outputUnits: number }): void;
  onModelError(error: unknown): void;
};

type ProxyRequest = JsonRecord;
type ProxyResult = {
  schemaVersion: 1;
  status: 200;
  body: string;
  usage: { inputUnits: number; outputUnits: number };
  providerRequestId?: string;
  providerModel?: string;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  completeChatUsage?: boolean;
};
type PersistedProxyResult = {
  schemaVersion: 2;
  status: 200;
  bodyEncoding: "gzip+base64";
  bodyBytes: number;
  bodySha256: string;
  bodyGzipBase64: string;
  usage: { inputUnits: number; outputUnits: number };
  providerRequestId?: string;
};

class ProxyHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "ProxyHttpError";
    this.status = status;
    this.code = code;
  }
}

function sendJson(response: ServerResponse, status: number, code: string): void {
  const body = JSON.stringify({ error: { code } });
  if (response.headersSent) {
    response.end(`data: ${body}\n\ndata: [DONE]\n\n`);
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(new TextEncoder().encode(body).byteLength),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function durableErrorStatus(error: DurableProviderError): number {
  const match = /^deepseek_http_([1-5]\d\d)$/.exec(error.safeCode);
  if (!match) return 502;
  const status = Number(match[1]);
  return status >= 400 ? status : 502;
}

function authorized(request: IncomingMessage, capability: Uint8Array): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const candidate = new TextEncoder().encode(header.slice("Bearer ".length));
  return candidate.byteLength === capability.byteLength && timingSafeEqual(candidate, capability);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new ProxyHttpError(415, "content_type_invalid");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      total += chunk.byteLength;
      chunks.push(Uint8Array.from(chunk));
    });
    request.on("end", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    request.on("error", () => {
      if (!settled) {
        settled = true;
        reject(new ProxyHttpError(400, "request_invalid"));
      }
    });
  });
  if (!total) throw new ProxyHttpError(400, "request_invalid");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch {
    throw new ProxyHttpError(400, "request_invalid");
  }
}

function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage);
  if (!value || typeof value !== "object") return false;
  const record = value as JsonRecord;
  if (record.type === "image_url" || record.type === "input_image" || "image_url" in record) return true;
  return Object.values(record).some(containsImage);
}

function validateRequest(value: unknown, model: string): ProxyRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProxyHttpError(400, "request_invalid");
  const request = value as ProxyRequest;
  if (request.model !== model || request.stream !== true || !Array.isArray(request.messages) ||
      containsImage(request.messages)) {
    throw new ProxyHttpError(400, "request_invalid");
  }
  return request;
}

function validateUpstream(config: DeepSeekConfig, allowInsecureLoopback: boolean): Required<DeepSeekConfig> {
  const apiKey = config.apiKey.trim();
  const model = config.model.trim();
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 90_000;
  if (!apiKey || !model || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("dsh_model_proxy_config_invalid");
  }
  const parsed = new URL(baseUrl);
  const allowedLoopback = allowInsecureLoopback && parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !allowedLoopback) throw new Error("dsh_model_proxy_upstream_invalid");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("dsh_model_proxy_upstream_invalid");
  return { apiKey, model, baseUrl, timeoutMs };
}

export function isOfficialDeepSeekChatUpstream(baseUrl: string): boolean {
  return baseUrl.trim().replace(/\/+$/, "") === DEEPSEEK_CHAT_API_BASE_URL;
}

function applyPaidOutputLimit(request: ProxyRequest, limit: number): number {
  const requested = request.max_tokens;
  if (request.max_completion_tokens !== undefined || (request.n !== undefined && request.n !== 1) ||
      (requested !== undefined && (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1))) {
    throw new ProxyHttpError(400, "paid_model_request_invalid");
  }
  const effective = typeof requested === "number" ? Math.min(limit, requested) : limit;
  request.max_tokens = effective;
  return effective;
}

function parseSse(body: string): Pick<ProxyResult, "usage" | "providerRequestId" | "providerModel" | "cacheHitTokens" | "cacheMissTokens" | "completeChatUsage"> {
  const lines = body.split(/\r?\n/);
  const doneIndex = lines.findIndex((line) => line === "data: [DONE]");
  if (doneIndex < 0 || lines.slice(doneIndex + 1).some((line) => line.length > 0)) {
    throw new DurableProviderError("unknown", "deepseek_stream_incomplete");
  }
  let inputUnits: number | undefined;
  let outputUnits: number | undefined;
  let providerRequestId: string | undefined;
  let providerModel: string | undefined;
  let cacheHitTokens: number | undefined;
  let cacheMissTokens: number | undefined;
  let finalEventHasUsage = false, conflictedUsage = false;
  let priorUsage: string | undefined;
  for (const line of lines.slice(0, doneIndex)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    finalEventHasUsage = false;
    let event: unknown;
    try { event = JSON.parse(line.slice(6)); } catch { throw new DurableProviderError("unknown", "deepseek_stream_invalid"); }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const record = event as JsonRecord;
    if (typeof record.id === "string" && record.id.length <= 200) {
      if (providerRequestId !== undefined && providerRequestId !== record.id) conflictedUsage = true;
      providerRequestId = record.id;
    }
    if (typeof record.model === "string" && /^[A-Za-z0-9._:/-]{1,120}$/.test(record.model)) {
      if (providerModel !== undefined && providerModel !== record.model) conflictedUsage = true;
      providerModel = record.model;
    }
    if (!record.usage || typeof record.usage !== "object" || Array.isArray(record.usage)) {
      if (record.usage != null) conflictedUsage = true;
      continue;
    }
    const usage = record.usage as JsonRecord;
    const haveInput = Number.isSafeInteger(usage.prompt_tokens) && Number(usage.prompt_tokens) >= 0;
    const haveOutput = Number.isSafeInteger(usage.completion_tokens) && Number(usage.completion_tokens) >= 0;
    if (haveInput) {
      inputUnits = Number(usage.prompt_tokens);
      const cacheCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) &&
        value >= 0 && value <= Number(usage.prompt_tokens) ? value : undefined;
      cacheHitTokens = cacheCount(usage.prompt_cache_hit_tokens ?? (usage.prompt_tokens_details as JsonRecord | undefined)?.cached_tokens);
      cacheMissTokens = cacheCount(usage.prompt_cache_miss_tokens);
      if (cacheHitTokens !== undefined && cacheMissTokens !== undefined && cacheHitTokens + cacheMissTokens !== inputUnits) {
        cacheHitTokens = cacheMissTokens = undefined;
      }
    }
    if (haveOutput) {
      outputUnits = Number(usage.completion_tokens);
    }
    // Keep legacy result parsing compatible. A confirmed token observation requires
    // both counts in the same final SSE event and no conflicting usage events.
    finalEventHasUsage = haveInput && haveOutput;
    if (!finalEventHasUsage) conflictedUsage = true;
    else {
      const signature = JSON.stringify([inputUnits, outputUnits, cacheHitTokens, cacheMissTokens]);
      if (priorUsage !== undefined && priorUsage !== signature) conflictedUsage = true;
      priorUsage = signature;
    }
  }
  if (inputUnits === undefined || outputUnits === undefined || inputUnits > 10_000_000 || outputUnits > 10_000_000) {
    throw new DurableProviderError("unknown", "deepseek_usage_missing");
  }
  return { usage: { inputUnits, outputUnits }, providerRequestId, providerModel, cacheHitTokens, cacheMissTokens,
    completeChatUsage: finalEventHasUsage && !conflictedUsage };
}

function encodePersistedResult(result: ProxyResult): string {
  const bodyBytes = new TextEncoder().encode(result.body);
  const persisted: PersistedProxyResult = {
    schemaVersion: 2,
    status: 200,
    bodyEncoding: "gzip+base64",
    bodyBytes: bodyBytes.byteLength,
    bodySha256: sha256Hex(result.body),
    bodyGzipBase64: Buffer.from(gzipSync(bodyBytes)).toString("base64"),
    usage: result.usage,
    ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
  };
  return canonicalJson(persisted);
}

function decodePersistedResult(value: unknown): ProxyResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dsh_model_proxy_result_invalid");
  }
  const persisted = value as Partial<PersistedProxyResult>;
  if (persisted.schemaVersion !== 2 || persisted.status !== 200 || persisted.bodyEncoding !== "gzip+base64" ||
      !Number.isSafeInteger(persisted.bodyBytes) || Number(persisted.bodyBytes) <= 0 ||
      typeof persisted.bodySha256 !== "string" || !/^[0-9a-f]{64}$/.test(persisted.bodySha256) ||
      typeof persisted.bodyGzipBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(persisted.bodyGzipBase64) ||
      persisted.bodyGzipBase64.length % 4 !== 0 || !persisted.usage || typeof persisted.usage !== "object") {
    throw new Error("dsh_model_proxy_result_invalid");
  }
  const compressed = Buffer.from(persisted.bodyGzipBase64, "base64");
  if (compressed.toString("base64") !== persisted.bodyGzipBase64) {
    throw new Error("dsh_model_proxy_result_invalid");
  }
  let bodyBytes: Uint8Array;
  try {
    bodyBytes = gunzipSync(compressed, { maxOutputLength: Number(persisted.bodyBytes) });
  } catch {
    throw new Error("dsh_model_proxy_result_invalid");
  }
  if (bodyBytes.byteLength !== persisted.bodyBytes) throw new Error("dsh_model_proxy_result_invalid");
  let body: string;
  try { body = new TextDecoder("utf8", { fatal: true }).decode(bodyBytes); } catch {
    throw new Error("dsh_model_proxy_result_invalid");
  }
  if (sha256Hex(body) !== persisted.bodySha256) throw new Error("dsh_model_proxy_result_invalid");
  const verified = parseSse(body);
  if (verified.usage.inputUnits !== persisted.usage.inputUnits || verified.usage.outputUnits !== persisted.usage.outputUnits ||
      verified.providerRequestId !== persisted.providerRequestId) {
    throw new Error("dsh_model_proxy_result_invalid");
  }
  return {
    schemaVersion: 1,
    status: 200,
    body,
    usage: verified.usage,
    ...(verified.providerRequestId ? { providerRequestId: verified.providerRequestId } : {}),
  };
}

async function requestModelStream(request: ProxyRequest, upstream: Required<DeepSeekConfig>, fetchImpl: MeteredDeepSeekProxyFetch,
  signal: AbortSignal, maxAttempts: number, recordUnknown: () => Promise<void>, forbidRedirects = false): Promise<ProxyResult> {
  let response: Awaited<ReturnType<MeteredDeepSeekProxyFetch>> | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      response = await fetchImpl(`${upstream.baseUrl}${REQUEST_PATH}`, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${upstream.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        // Cancellation/lease loss closes this proxy; long output has no wall-clock deadline.
        signal: signal,
        ...(forbidRedirects ? { redirect: "error" } : {}),
      });
    } catch {
      await recordUnknown();
      throw new DurableProviderError("unknown", "deepseek_transport_unknown");
    }
    if (response.ok) break;
    // A received gateway status is a definitive non-success response. Retry
    // 502/503/504 once inside this already-durable logical call; do not retry
    // transport-unknown failures or stable 4xx responses.
    if (!RETRYABLE_UPSTREAM_STATUSES.has(response.status) || attempt === maxAttempts - 1) {
      if (response.status === 400) {
        let detail = "";
        try { detail = await response.text(); } catch { /* preserve the received HTTP failure */ }
        if (/context[_ ]length|context window|maximum context|too many tokens/i.test(detail)) {
          throw new DurableProviderError("terminal", "deepseek_context_limit");
        }
      }
      throw new DurableProviderError("terminal", `deepseek_http_${response.status}`);
    }
  }
  if (!response?.ok) throw new DurableProviderError("terminal", "deepseek_http_502");
  let body: string;
  try {
    body = await response.text();
  } catch {
    await recordUnknown();
    throw new DurableProviderError("unknown", "deepseek_transport_unknown");
  }
  const size = new TextEncoder().encode(body).byteLength;
  if (!size) {
    await recordUnknown();
    throw new DurableProviderError("unknown", "deepseek_response_empty");
  }
  let parsed: Pick<ProxyResult, "usage" | "providerRequestId">;
  try {
    parsed = parseSse(body);
  } catch (error) {
    if (error instanceof DurableProviderError && error.outcome === "unknown") {
      await recordUnknown();
    }
    throw error;
  }
  return { schemaVersion: 1, status: 200, body, ...parsed };
}

async function observeChatRequest(options: ChatModelProxyOptions, callId: string, request: ProxyRequest,
  upstream: Required<DeepSeekConfig>, signal: AbortSignal, paidOutputTokens?: number): Promise<ProxyResult> {
  let result: ProxyResult;
  try {
    result = await requestModelStream(request, upstream, options.fetch ?? fetch, signal, 1, async () => {}, paidOutputTokens !== undefined);
  } catch (error) {
    const code = error instanceof DurableProviderError ? error.safeCode : "";
    const status = code === "deepseek_context_limit" ? "400" : /^deepseek_http_([45][0-9]{2})$/.exec(code)?.[1];
    await options.onModelObservation(callId, status ? { status: "http_error", http_status: Number(status) } : { status: "unknown" });
    throw error;
  }
  await options.onModelObservation(callId, result.completeChatUsage ? {
    status: "observed",
    input_tokens: result.usage.inputUnits,
    output_tokens: result.usage.outputUnits,
    ...(result.cacheHitTokens === undefined ? {} : { cache_hit_tokens: result.cacheHitTokens }),
    ...(result.cacheMissTokens === undefined ? {} : { cache_miss_tokens: result.cacheMissTokens }),
    ...(result.providerModel ? { provider_model: result.providerModel } : {}),
    ...(result.providerRequestId && /^[A-Za-z0-9._:/-]{1,200}$/.test(result.providerRequestId)
      ? { provider_request_id: result.providerRequestId } : {}),
  } : { status: "unknown" });
  if (paidOutputTokens !== undefined && (result.usage.outputUnits > paidOutputTokens ||
      result.usage.inputUnits + result.usage.outputUnits > DEEPSEEK_CHAT_CONTEXT_TOKENS)) {
    throw new DurableProviderError("unknown", "deepseek_paid_usage_outside_authorization");
  }
  return result;
}

class MeteredProxyAdapter implements DurableToolAdapter<ProxyRequest, ProxyResult> {
  private readonly options: MeteredDeepSeekProxyOptions;
  private readonly upstream: Required<DeepSeekConfig>;
  private readonly fetchImpl: MeteredDeepSeekProxyFetch;
  private readonly abortController = new AbortController();

  close(): void { this.abortController.abort(); }

  constructor(options: MeteredDeepSeekProxyOptions, upstream: Required<DeepSeekConfig>) {
    this.options = options;
    this.upstream = upstream;
    this.fetchImpl = options.fetch ?? (fetch as unknown as MeteredDeepSeekProxyFetch);
  }

  async execute(callId: string, request: ProxyRequest): Promise<ProxyResult> {
    return requestModelStream(request, this.upstream, this.fetchImpl, this.abortController.signal, MAX_UPSTREAM_ATTEMPTS,
      () => this.recordUsage(callId, { inputUnits: 0, outputUnits: 0 }));
  }

  async reconcile(callId: string): Promise<ProxyResult | null> {
    try {
      return await this.load(callId);
    } catch (error) {
      if (!(error instanceof AgentControlError) || error.status !== 409) throw error;
      await this.recordUsage(callId, { inputUnits: 0, outputUnits: 0 });
      return null;
    }
  }

  async persist(callId: string, result: ProxyResult) {
    const content = encodePersistedResult(result);
    const bytes = new TextEncoder().encode(content);
    const sha256 = sha256Hex(content);
    if (result.providerRequestId) {
      await this.persistOperation("response_id", () => this.options.control.markToolSubmitted({
        runId: this.options.runId,
        leaseId: this.options.leaseId,
        callId,
        providerRequestId: result.providerRequestId,
      }));
    }
    const artifact = await this.persistOperation("diagnostic", () => this.options.control.uploadDiagnostic({
      runId: this.options.runId,
      leaseId: this.options.leaseId,
      sourceCallId: callId,
      stepId: `model-${this.options.phase}`,
      bytes,
      sha256,
    }));
    await this.persistOperation("usage", () => this.recordUsage(callId, result.usage));
    return { value: result, resultObjectKey: artifact.objectKey, resultHash: sha256 };
  }

  private async persistOperation<T>(stage: string, operation: () => Promise<T>): Promise<T> {
    // These writes already use the same durable callId/hash. Retry only a
    // received transient control/storage status, never the model request.
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        const status = error instanceof AgentControlError ? error.status
          : error instanceof Error ? Number(/^agent_diagnostic_upload_http_(\d{3})$/.exec(error.message)?.[1]) : NaN;
        if (attempt === 0 && [500, 502, 503, 504].includes(status)) continue;
        throw new DurableProviderError("unknown", `deepseek_${stage}_${Number.isInteger(status) ? `http_${status}` : "failed"}`);
      }
    }
  }

  async restore(record: PreparedToolCall): Promise<ProxyResult> {
    return await this.load(record.callId);
  }

  private async recordUsage(callId: string, usage: ProxyResult["usage"]): Promise<void> {
    await this.options.control.recordUsage({
      runId: this.options.runId,
      leaseId: this.options.leaseId,
      callId,
      kind: "model_tokens",
      provider: "deepseek",
      model: this.upstream.model,
      inputUnits: usage.inputUnits,
      outputUnits: usage.outputUnits,
      imageCount: 0,
    });
  }

  private async load(callId: string): Promise<ProxyResult> {
    const artifact = await this.options.control.getArtifactByCall(
      this.options.runId,
      this.options.leaseId,
      callId,
    );
    if (artifact.role !== "diagnostic" || artifact.mime !== "application/json" || !artifact.url) {
      throw new Error("dsh_model_proxy_result_invalid");
    }
    const bytes = await this.options.control.downloadVerifiedBytes(
      artifact.url,
      { sha256: artifact.sha256, bytes: artifact.bytes },
      Infinity,
    );
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)); } catch {
      throw new Error("dsh_model_proxy_result_invalid");
    }
    return decodePersistedResult(parsed);
  }
}

export class MeteredDeepSeekProxy {
  lastErrorCode?: string;
  private closed = false;
  private readonly server: Server;
  private readonly baseUrl: string;
  private readonly capability: string;
  private readonly deactivate: () => void;
  private readonly waitForIdle: () => Promise<void>;

  constructor(
    server: Server,
    baseUrl: string,
    capability: string,
    deactivate: () => void,
    waitForIdle: () => Promise<void>,
  ) {
    this.server = server;
    this.baseUrl = baseUrl;
    this.capability = capability;
    this.deactivate = deactivate;
    this.waitForIdle = waitForIdle;
  }

  childEnvironment(): Readonly<Record<string, string>> {
    if (this.closed) throw new Error("dsh_model_proxy_closed");
    return Object.freeze({
      DEEPSEEK_API_KEY: this.capability,
      DEEPSEEK_BASE_URL: this.baseUrl,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.deactivate();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error?: Error) => error ? reject(error) : resolve());
    });
    await this.waitForIdle();
  }
}

export async function startMeteredDeepSeekProxy(options: MeteredDeepSeekProxyOptions | ChatModelProxyOptions): Promise<MeteredDeepSeekProxy> {
  const upstream = validateUpstream(options.upstream, options.allowInsecureLoopback === true);
  const paidMaxOutputTokens = options.phase === "chat" ? options.paidMaxOutputTokens : undefined;
  if (paidMaxOutputTokens !== undefined && (!Number.isSafeInteger(paidMaxOutputTokens) || paidMaxOutputTokens < 1 ||
      paidMaxOutputTokens > DEEPSEEK_CHAT_MAX_OUTPUT_TOKENS || !isOfficialDeepSeekChatUpstream(upstream.baseUrl) ||
      (upstream.model !== "deepseek-flash" && upstream.model !== "deepseek-v4-pro"))) {
    throw new Error("dsh_paid_model_proxy_config_invalid");
  }
  const maxModelTurns = options.phase === "chat" ? 12 : options.maxModelTurns ?? DEFAULT_MAX_MODEL_TURNS;
  if (!Number.isSafeInteger(maxModelTurns) || maxModelTurns < 1 || maxModelTurns > 128) {
    throw new Error("dsh_model_proxy_turn_limit_invalid");
  }
  const capabilityValue = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const capability = new TextEncoder().encode(capabilityValue);
  const adapter = options.phase === "chat" ? undefined : new MeteredProxyAdapter(options, upstream);
  const dispatcher = options.phase !== "chat" && adapter ? new DurableToolDispatcher(options.control, adapter, {
    onUnexpectedError: options.onUnexpectedError,
  }) : undefined;
  const chatAbort = new AbortController();
  const chatSignal = options.phase === "chat" && options.signal
    ? AbortSignal.any([chatAbort.signal, options.signal]) : chatAbort.signal;
  let active = true;
  let inFlight = false;
  const distinctCalls = new Set<string>();
  const activeRequests = new Set<Promise<void>>();
  let cancellation: ReturnType<typeof setInterval> | undefined;
  let proxy: MeteredDeepSeekProxy;

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!active) return sendJson(response, 410, "proxy_closed");
    if (request.method !== "POST" || request.url !== REQUEST_PATH) return sendJson(response, 404, "route_not_found");
    if (!authorized(request, capability)) return sendJson(response, 401, "capability_invalid");
    if (inFlight) return sendJson(response, 409, "request_in_flight");
    inFlight = true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      if (options.signal?.aborted) throw new ProxyHttpError(409, "agent_run_cancelled");
      const modelRequest = validateRequest(await readJson(request), upstream.model);
      if (options.allowedToolNames && Array.isArray(modelRequest.tools)) {
        modelRequest.tools = modelRequest.tools.filter((tool) => {
          const name = (tool as { function?: { name?: string } })?.function?.name;
          return typeof name === "string" && options.allowedToolNames!.includes(name);
        });
      }
      if (options.phase === "chat") await options.beforeModel(modelRequest);
      else if (options.systemPolicy) {
        modelRequest.messages = [{ role: "system", content: options.systemPolicy }, ...(modelRequest.messages as unknown[])];
      }
      const paidOutputTokens = paidMaxOutputTokens === undefined ? undefined : applyPaidOutputLimit(modelRequest, paidMaxOutputTokens);
      const requestHash = sha256Hex(canonicalJson(modelRequest));
      const callId = sha256Hex(canonicalJson({
        schemaVersion: 1,
        runId: options.runId,
        phase: options.phase,
        requestHash,
      }));
      if (options.phase === "chat" && distinctCalls.has(callId)) throw new ProxyHttpError(409, "duplicate_model_call");
      if (!distinctCalls.has(callId)) {
        if (distinctCalls.size >= maxModelTurns) throw new ProxyHttpError(429, "model_turn_budget_exhausted");
        distinctCalls.add(callId);
      }
      if (options.phase === "chat") {
        if (chatSignal.aborted) throw new ProxyHttpError(409, "agent_run_cancelled");
        await options.onModelSubmit(callId, paidOutputTokens);
        if (chatSignal.aborted) throw new ProxyHttpError(409, "agent_run_cancelled");
      }
      // Keep DSH's idle watchdog alive while the complete result is durably saved.
      heartbeat = setInterval(() => {
        if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        response.write(": keep-alive\n\n");
      }, 15_000);
      const result = options.phase === "chat" ? await observeChatRequest(options, callId, modelRequest, upstream, chatSignal, paidOutputTokens) : await dispatcher!.dispatch({
        runId: options.runId,
        leaseId: options.leaseId,
        callId,
        phase: options.phase,
        toolName: "model_turn",
      }, modelRequest);
      if (options.phase === "chat") options.onUsage(result.usage);
      // A provider-truncated answer must never become a successful text result.
      // The durable response and usage above remain available without resubmission.
      if (result.body.split(/\r?\n/).some(line => {
        if (!line.startsWith("data: ") || line === "data: [DONE]") return false;
        try { return JSON.parse(line.slice(6)).choices?.some((choice: { finish_reason?: string }) => choice.finish_reason === "length"); }
        catch { return false; }
      })) throw new ProxyHttpError(422, "deepseek_output_limit");
      if (!response.headersSent) response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/event-stream",
        "x-content-type-options": "nosniff",
      });
      response.end(result.body);
      proxy.lastErrorCode = undefined;
    } catch (error) {
      if (options.phase === "chat") options.onModelError(error);
      proxy.lastErrorCode = error instanceof ProxyHttpError ? error.code
        : error instanceof DurableProviderError ? error.safeCode : "model_proxy_failed";
      if (error instanceof ProxyHttpError) sendJson(response, error.status, error.code);
      else if (error instanceof DurableProviderError) sendJson(response, durableErrorStatus(error), error.safeCode);
      else sendJson(response, 502, "model_proxy_failed");
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      inFlight = false;
    }
  };
  const server = createServer((request, response) => {
    const activeRequest = handleRequest(request, response);
    activeRequests.add(activeRequest);
    void activeRequest.then(
      () => activeRequests.delete(activeRequest),
      () => activeRequests.delete(activeRequest),
    );
  });
  const deactivate = () => {
    active = false;
    if (cancellation) clearInterval(cancellation);
    capability.fill(0);
    adapter?.close();
    chatAbort.abort();
  };
  server.on("close", deactivate);
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new Error("dsh_model_proxy_listen_failed")));
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close(() => undefined);
    throw new Error("dsh_model_proxy_address_invalid");
  }
  if (adapter && options.signal) cancellation = setInterval(() => {
    if (options.signal?.aborted) adapter.close();
  }, 250);
  const waitForIdle = async (): Promise<void> => {
    while (activeRequests.size > 0) {
      await Promise.allSettled([...activeRequests]);
    }
  };
  proxy = new MeteredDeepSeekProxy(
    server,
    `http://127.0.0.1:${address.port}`,
    capabilityValue,
    deactivate,
    waitForIdle,
  );
  return proxy;
}
