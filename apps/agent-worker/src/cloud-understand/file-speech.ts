import type { WorkerFetch } from "../cloud-generation/runtime.ts";
import { FILE_SPEECH_AUDIO_TOLERANCE_MS, FILE_SPEECH_MAX_RESULT_BYTES } from "../../../cloud/supabase/functions/_shared/file-speech.ts";

const API_ROOT = "https://openspeech.bytedance.com/api/v3/auc/bigmodel";
const RESOURCE_ID = "volc.seedasr.auc";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_RESPONSE_BYTES = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FileSpeechSubmitInput {
  requestId: string;
  audioUrl: string;
}

interface FileSpeechQueryInput {
  requestId: string;
  durationMs: number;
}

type Failed = {
  status: "failed";
  code: "not_configured" | "invalid_provider_request" | "invalid_provider_response" | "provider_failed";
};
type Unknown = { status: "unknown" };

export type FileSpeechSubmitResult = { status: "submitted" } | Unknown | Failed;
export type FileSpeechQueryResult =
  | { status: "pending" }
  | { status: "completed"; resultText: string }
  | { status: "no_speech"; resultText: string }
  | Unknown
  | Failed;

const UNKNOWN: Unknown = { status: "unknown" };
const INVALID_REQUEST: Failed = { status: "failed", code: "invalid_provider_request" };
const INVALID_RESPONSE: Failed = { status: "failed", code: "invalid_provider_response" };
const NO_SPEECH = {
  status: "no_speech",
  resultText: JSON.stringify({ text: "", utterances: [], timingSource: "doubao-speech" }),
} as const;

type HttpResponse = Awaited<ReturnType<WorkerFetch>>;
type TranscriptSegment = { text: string; startMs: number; endMs: number };
const INVALID_AUDIO_CODES = new Set(["45000002", "45000006", "45000130", "45000132", "45000151"]);
const TERMINAL_TASK_CODES = new Set(["55001010", "55001011"]);
const QUEUED_CODES = new Set(["20000001", "20000002"]);

async function post(
  action: "submit" | "query",
  requestId: string,
  apiKey: string,
  body: string,
  fetchImpl: WorkerFetch,
): Promise<HttpResponse | undefined> {
  try {
    return await fetchImpl(`${API_ROOT}/${action}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        "X-Api-Resource-Id": RESOURCE_ID,
        "X-Api-Request-Id": requestId,
        ...(action === "submit" ? { "X-Api-Sequence": "-1" } : {}),
      },
      body,
    });
  } catch {
    // Transport errors can contain sensitive data. The caller reconciles by request ID.
    return undefined;
  }
}

function discardBody(response: HttpResponse): void {
  void response.body?.getReader().cancel().catch(() => {});
}

function isAudioUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export async function submitFileSpeech(
  { requestId, audioUrl }: FileSpeechSubmitInput,
  apiKey: string | undefined,
  fetchImpl: WorkerFetch,
): Promise<FileSpeechSubmitResult> {
  if (!apiKey?.trim()) return { status: "failed", code: "not_configured" };
  if (!UUID.test(requestId) || !isAudioUrl(audioUrl)) return INVALID_REQUEST;

  // The caller obtains this URL from private Storage and persists requestId before submitting.
  const response = await post("submit", requestId, apiKey, JSON.stringify({
    audio: { url: audioUrl, format: "mp3", codec: "raw", rate: 16000, bits: 16, channel: 1 },
    request: { model_name: "bigmodel", show_utterances: true, enable_itn: true, enable_punc: true, enable_ddc: false, vad_segment: true },
  }), fetchImpl);
  if (!response) return UNKNOWN;
  discardBody(response);
  if (response.status === 401 || response.status === 403) return { status: "failed", code: "not_configured" };
  const code = response.headers.get("x-api-status-code") ?? "";
  const echoedId = response.headers.get("x-api-request-id");
  if (echoedId && echoedId.toLowerCase() !== requestId.toLowerCase()) return UNKNOWN;
  if (response.ok && (code === "20000000" || code === "20000003" || QUEUED_CODES.has(code))) {
    return { status: "submitted" };
  }
  if (INVALID_AUDIO_CODES.has(code)) return INVALID_REQUEST;
  // 45000001 can also mean duplicate submission, so it does not prove rejection.
  return UNKNOWN;
}

async function readResultBody(response: HttpResponse): Promise<string | null> {
  if (Number(response.headers.get("content-length")) > MAX_PROVIDER_RESPONSE_BYTES) {
    discardBody(response);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("speech_response_body_missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function normalizeResult(raw: unknown, durationMs: number): FileSpeechQueryResult {
  const result = (raw as { result?: { text?: unknown; utterances?: unknown } } | null)?.result;
  if (!result || typeof result.text !== "string" || !Array.isArray(result.utterances)) return INVALID_RESPONSE;
  if (!result.utterances.length) return result.text.trim() ? INVALID_RESPONSE : NO_SPEECH;
  if (!result.text.trim()) return INVALID_RESPONSE;

  const utterances: TranscriptSegment[] = [];
  let previousEnd = 0;
  for (const value of result.utterances) {
    const segment = value as { text: string; start_time: number; end_time: number } | null;
    if (!segment || typeof segment.text !== "string" || !Number.isSafeInteger(segment.start_time) ||
        !Number.isSafeInteger(segment.end_time) || segment.start_time < previousEnd ||
        segment.end_time <= segment.start_time || segment.end_time > durationMs + FILE_SPEECH_AUDIO_TOLERANCE_MS) {
      return INVALID_RESPONSE;
    }
    previousEnd = segment.end_time;
    utterances.push({ text: segment.text, startMs: segment.start_time, endMs: segment.end_time });
  }
  const resultText = JSON.stringify({ text: result.text, utterances, timingSource: "doubao-speech" });
  if (new TextEncoder().encode(resultText).byteLength > FILE_SPEECH_MAX_RESULT_BYTES) return INVALID_RESPONSE;
  return { status: "completed", resultText };
}

export async function queryFileSpeech(
  { requestId, durationMs }: FileSpeechQueryInput,
  apiKey: string | undefined,
  fetchImpl: WorkerFetch,
): Promise<FileSpeechQueryResult> {
  if (!UUID.test(requestId) || !Number.isSafeInteger(durationMs) || durationMs <= 0) return INVALID_REQUEST;
  // Losing authorization after submission does not establish the original task's outcome.
  if (!apiKey?.trim()) return UNKNOWN;
  const response = await post("query", requestId, apiKey, "{}", fetchImpl);
  if (!response) return UNKNOWN;
  const code = response.headers.get("x-api-status-code") ?? "";
  const echoedId = response.headers.get("x-api-request-id");
  if (echoedId && echoedId.toLowerCase() !== requestId.toLowerCase()) {
    discardBody(response);
    return UNKNOWN;
  }
  if (!response.ok || code !== "20000000") {
    discardBody(response);
    if (response.ok && QUEUED_CODES.has(code)) return { status: "pending" };
    if (response.ok && code === "20000003") return NO_SPEECH;
    if (INVALID_AUDIO_CODES.has(code)) return INVALID_REQUEST;
    if (TERMINAL_TASK_CODES.has(code)) return { status: "failed", code: "provider_failed" };
    // 55000001 includes both failed reads and failed tasks. Keep polling the same ID.
    return UNKNOWN;
  }
  try {
    const body = await readResultBody(response);
    return body === null ? INVALID_RESPONSE : normalizeResult(JSON.parse(body), durationMs);
  } catch {
    return UNKNOWN;
  }
}
