import { arkVideoBody, type VideoInput } from "../../../cloud/supabase/functions/_shared/video-contract.ts";

const BASE = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks";
export interface VideoHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type VideoFetch = (url: string, init: { method: "POST" | "GET"; headers: Record<string, string>; body?: string; redirect?: "error" }) => Promise<VideoHttpResponse>;
export class ArkVideoError extends Error {
  readonly code: string;
  readonly definitive: boolean;
  constructor(code: string, definitive: boolean) { super(code); this.code = code; this.definitive = definitive; }
}
export interface VideoTask {
  id: string;
  model?: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
  videoUrl?: string;
  completionTokens?: number;
  errorCode?: string;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value); }
function parse(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }

/** One POST only. A transport failure or malformed success must never trigger a new submission. */
export class ArkVideoClient {
  private readonly apiKey: string;
  private readonly fetch: VideoFetch;
  constructor(apiKey: string, fetch: VideoFetch) {
    if (!apiKey.trim()) throw new ArkVideoError("video_key_missing", true);
    this.apiKey = apiKey; this.fetch = fetch;
  }
  private headers() { return { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" }; }
  async submit(input: VideoInput, urls: string[] = []): Promise<string> {
    const body = JSON.stringify(arkVideoBody(input, urls));
    let response: VideoHttpResponse;
    try { response = await this.fetch(BASE, { method: "POST", headers: this.headers(), body, redirect: "error" }); }
    catch { throw new ArkVideoError("video_submit_outcome_unknown", false); }
    const value = parse(await response.text().catch(() => ""));
    if (!response.ok) {
      // Only explicit client rejection proves this request did not create a task.
      throw new ArkVideoError(`video_submit_http_${response.status}`, response.status >= 400 && response.status < 500 && response.status !== 408);
    }
    if (!record(value) || !identifier(value.id)) throw new ArkVideoError("video_submit_outcome_unknown", false);
    return value.id;
  }
  async query(id: string): Promise<VideoTask> {
    if (!identifier(id)) throw new ArkVideoError("video_task_id_invalid", false);
    const response = await this.fetch(`${BASE}/${encodeURIComponent(id)}`, { method: "GET", headers: this.headers(), redirect: "error" });
    const value = parse(await response.text());
    if (!response.ok || !record(value)) throw new ArkVideoError(`video_query_http_${response.status}`, false);
    if (value.id !== id || !["queued", "running", "succeeded", "failed", "cancelled", "expired"].includes(String(value.status))) throw new ArkVideoError("video_task_response_invalid", false);
    const task: VideoTask = { id, status: value.status as VideoTask["status"] };
    if (typeof value.model === "string") task.model = value.model;
    if (record(value.error) && typeof value.error.code === "string" && /^[A-Za-z0-9_.-]{1,200}$/.test(value.error.code)) task.errorCode = value.error.code;
    if (task.status === "succeeded") {
      const url = record(value.content) ? value.content.video_url : undefined;
      const tokens = record(value.usage) ? value.usage.completion_tokens : undefined;
      if (typeof url !== "string" || !url.startsWith("https://") || !Number.isSafeInteger(tokens) || Number(tokens) <= 0) throw new ArkVideoError("video_result_invalid", false);
      task.videoUrl = url; task.completionTokens = Number(tokens);
    }
    return task;
  }
  /** Ark DELETE also deletes completed records and has no conditional cancellation.
   * After submission we retain the task, result, and usage; cancelling locally stops waiting only. */
  async inspectAfterLocalCancellation(id: string): Promise<VideoTask> {
    return await this.query(id);
  }
}
