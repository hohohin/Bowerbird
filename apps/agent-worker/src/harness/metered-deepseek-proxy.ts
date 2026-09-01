import { randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gunzipSync, gzipSync } from "node:zlib";
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
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_PLANNING_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_HTML_EXECUTION_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_ARTIFACT_BYTES = 64 * 1024;
const DEFAULT_MAX_MODEL_TURNS = 8;
const MAX_UPSTREAM_ATTEMPTS = 2;
const RETRYABLE_UPSTREAM_STATUSES = new Set([502, 503, 504]);

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
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type MeteredDeepSeekProxyOptions = {
  runId: string;
  leaseId: string;
  phase: "compose_plan" | "execute_approved_plan";
  control: MeteredDeepSeekProxyControl;
  upstream: DeepSeekConfig;
  allowInsecureLoopback?: boolean;
  maxModelTurns?: number;
  fetch?: MeteredDeepSeekProxyFetch;
};

type ProxyRequest = JsonRecord;
type ProxyResult = {
  schemaVersion: 1;
  status: 200;
  body: string;
  usage: { inputUnits: number; outputUnits: number };
  providerRequestId?: string;
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

function maxResponseBytes(phase: MeteredDeepSeekProxyOptions["phase"]): number {
  // Tool-call SSE framing can grow much larger than the final structured arguments.
  // Both routes remain bounded again by their action schema and the 64 KiB compressed
  // durable-result cap; HTML needs the larger raw transport allowance.
  return phase === "execute_approved_plan"
    ? MAX_HTML_EXECUTION_RESPONSE_BYTES
    : MAX_PLANNING_RESPONSE_BYTES;
}

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
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new ProxyHttpError(413, "request_too_large");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        settled = true;
        reject(new ProxyHttpError(413, "request_too_large"));
        return;
      }
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
  if (request.model !== model || request.stream !== true || !Array.isArray(request.messages) || containsImage(request.messages)) {
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

function parseSse(body: string): Pick<ProxyResult, "usage" | "providerRequestId"> {
  const lines = body.split(/\r?\n/);
  const doneIndex = lines.findIndex((line) => line === "data: [DONE]");
  if (doneIndex < 0 || lines.slice(doneIndex + 1).some((line) => line.length > 0)) {
    throw new DurableProviderError("unknown", "deepseek_stream_incomplete");
  }
  let inputUnits: number | undefined;
  let outputUnits: number | undefined;
  let providerRequestId: string | undefined;
  for (const line of lines.slice(0, doneIndex)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    let event: unknown;
    try { event = JSON.parse(line.slice(6)); } catch { throw new DurableProviderError("unknown", "deepseek_stream_invalid"); }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const record = event as JsonRecord;
    if (typeof record.id === "string" && record.id.length <= 200) providerRequestId = record.id;
    if (!record.usage || typeof record.usage !== "object" || Array.isArray(record.usage)) continue;
    const usage = record.usage as JsonRecord;
    if (Number.isSafeInteger(usage.prompt_tokens) && Number(usage.prompt_tokens) >= 0) {
      inputUnits = Number(usage.prompt_tokens);
    }
    if (Number.isSafeInteger(usage.completion_tokens) && Number(usage.completion_tokens) >= 0) {
      outputUnits = Number(usage.completion_tokens);
    }
  }
  if (inputUnits === undefined || outputUnits === undefined || inputUnits > 10_000_000 || outputUnits > 10_000_000) {
    throw new DurableProviderError("unknown", "deepseek_usage_missing");
  }
  return { usage: { inputUnits, outputUnits }, ...(providerRequestId ? { providerRequestId } : {}) };
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

function decodePersistedResult(value: unknown, responseLimit: number): ProxyResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dsh_model_proxy_result_invalid");
  }
  const persisted = value as Partial<PersistedProxyResult>;
  if (persisted.schemaVersion !== 2 || persisted.status !== 200 || persisted.bodyEncoding !== "gzip+base64" ||
      !Number.isSafeInteger(persisted.bodyBytes) || Number(persisted.bodyBytes) <= 0 || Number(persisted.bodyBytes) > responseLimit ||
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
    bodyBytes = gunzipSync(compressed, { maxOutputLength: responseLimit });
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

class MeteredProxyAdapter implements DurableToolAdapter<ProxyRequest, ProxyResult> {
  private readonly options: MeteredDeepSeekProxyOptions;
  private readonly upstream: Required<DeepSeekConfig>;
  private readonly fetchImpl: MeteredDeepSeekProxyFetch;

  constructor(options: MeteredDeepSeekProxyOptions, upstream: Required<DeepSeekConfig>) {
    this.options = options;
    this.upstream = upstream;
    this.fetchImpl = options.fetch ?? (fetch as unknown as MeteredDeepSeekProxyFetch);
  }

  async execute(callId: string, request: ProxyRequest): Promise<ProxyResult> {
    let response: Awaited<ReturnType<MeteredDeepSeekProxyFetch>> | undefined;
    for (let attempt = 0; attempt < MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
      try {
        response = await this.fetchImpl(`${this.upstream.baseUrl}${REQUEST_PATH}`, {
          method: "POST",
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${this.upstream.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
        });
      } catch {
        await this.recordUsage(callId, { inputUnits: 0, outputUnits: 0 });
        throw new DurableProviderError("unknown", "deepseek_transport_unknown");
      }
      if (response.ok) break;
      // A received gateway status is a definitive non-success response. Retry
      // 502/503/504 once inside this already-durable logical call; do not retry
      // transport-unknown failures or stable 4xx responses.
      if (!RETRYABLE_UPSTREAM_STATUSES.has(response.status) || attempt === MAX_UPSTREAM_ATTEMPTS - 1) {
        throw new DurableProviderError("terminal", `deepseek_http_${response.status}`);
      }
    }
    if (!response?.ok) throw new DurableProviderError("terminal", "deepseek_http_502");
    let body: string;
    try {
      body = await response.text();
    } catch {
      await this.recordUsage(callId, { inputUnits: 0, outputUnits: 0 });
      throw new DurableProviderError("unknown", "deepseek_transport_unknown");
    }
    const size = new TextEncoder().encode(body).byteLength;
    if (!size) {
      await this.recordUsage(callId, { inputUnits: 0, outputUnits: 0 });
      throw new DurableProviderError("unknown", "deepseek_response_empty");
    }
    if (size > maxResponseBytes(this.options.phase)) {
      await this.recordUsage(callId, { inputUnits: 0, outputUnits: 0 });
      throw new DurableProviderError("unknown", "deepseek_response_too_large");
    }
    let parsed: Pick<ProxyResult, "usage" | "providerRequestId">;
    try {
      parsed = parseSse(body);
    } catch (error) {
      if (error instanceof DurableProviderError && error.outcome === "unknown") {
        await this.recordUsage(callId, { inputUnits: 0, outputUnits: 0 });
      }
      throw error;
    }
    return { schemaVersion: 1, status: 200, body, ...parsed };
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
    if (!bytes.byteLength || bytes.byteLength > MAX_RESULT_ARTIFACT_BYTES) {
      throw new DurableProviderError("terminal", "deepseek_result_too_large");
    }
    const sha256 = sha256Hex(content);
    if (result.providerRequestId) {
      await this.options.control.markToolSubmitted({
        runId: this.options.runId,
        leaseId: this.options.leaseId,
        callId,
        providerRequestId: result.providerRequestId,
      });
    }
    const artifact = await this.options.control.uploadDiagnostic({
      runId: this.options.runId,
      leaseId: this.options.leaseId,
      sourceCallId: callId,
      stepId: `model-${this.options.phase}`,
      bytes,
      sha256,
    });
    await this.recordUsage(callId, result.usage);
    return { value: result, resultObjectKey: artifact.objectKey, resultHash: sha256 };
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
      MAX_RESULT_ARTIFACT_BYTES,
    );
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)); } catch {
      throw new Error("dsh_model_proxy_result_invalid");
    }
    return decodePersistedResult(parsed, maxResponseBytes(this.options.phase));
  }
}

export class MeteredDeepSeekProxy {
  private closed = false;
  private readonly server: Server;
  private readonly baseUrl: string;
  private readonly capability: string;

  constructor(server: Server, baseUrl: string, capability: string) {
    this.server = server;
    this.baseUrl = baseUrl;
    this.capability = capability;
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
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error?: Error) => error ? reject(error) : resolve());
    });
  }
}

export async function startMeteredDeepSeekProxy(options: MeteredDeepSeekProxyOptions): Promise<MeteredDeepSeekProxy> {
  const upstream = validateUpstream(options.upstream, options.allowInsecureLoopback === true);
  const maxModelTurns = options.maxModelTurns ?? DEFAULT_MAX_MODEL_TURNS;
  if (!Number.isSafeInteger(maxModelTurns) || maxModelTurns < 1 || maxModelTurns > 16) {
    throw new Error("dsh_model_proxy_turn_limit_invalid");
  }
  const capabilityValue = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const capability = new TextEncoder().encode(capabilityValue);
  const adapter = new MeteredProxyAdapter(options, upstream);
  const dispatcher = new DurableToolDispatcher(options.control, adapter);
  let active = true;
  let inFlight = false;
  const distinctCalls = new Set<string>();

  const server = createServer(async (request, response) => {
    if (!active) return sendJson(response, 410, "proxy_closed");
    if (request.method !== "POST" || request.url !== REQUEST_PATH) return sendJson(response, 404, "route_not_found");
    if (!authorized(request, capability)) return sendJson(response, 401, "capability_invalid");
    if (inFlight) return sendJson(response, 409, "request_in_flight");
    inFlight = true;
    try {
      const modelRequest = validateRequest(await readJson(request), upstream.model);
      const requestHash = sha256Hex(canonicalJson(modelRequest));
      const callId = sha256Hex(canonicalJson({
        schemaVersion: 1,
        runId: options.runId,
        phase: options.phase,
        requestHash,
      }));
      if (!distinctCalls.has(callId)) {
        if (distinctCalls.size >= maxModelTurns) throw new ProxyHttpError(429, "model_turn_budget_exhausted");
        distinctCalls.add(callId);
      }
      const result = await dispatcher.dispatch({
        runId: options.runId,
        leaseId: options.leaseId,
        callId,
        phase: options.phase,
        toolName: "model_turn",
      }, modelRequest);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/event-stream",
        "x-content-type-options": "nosniff",
      });
      response.end(result.body);
    } catch (error) {
      if (error instanceof ProxyHttpError) sendJson(response, error.status, error.code);
      else if (error instanceof DurableProviderError) sendJson(response, durableErrorStatus(error), error.safeCode);
      else sendJson(response, 502, "model_proxy_failed");
    } finally {
      inFlight = false;
    }
  });
  server.on("close", () => {
    active = false;
    capability.fill(0);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new Error("dsh_model_proxy_listen_failed")));
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close(() => undefined);
    throw new Error("dsh_model_proxy_address_invalid");
  }
  return new MeteredDeepSeekProxy(server, `http://127.0.0.1:${address.port}`, capabilityValue);
}
