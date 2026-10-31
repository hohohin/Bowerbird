import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DeepSeekBackend, DeepSeekBackendError, deepSeekConfigFromEnv } from "../providers/deepseek/backend.ts";
import { IdlePollBackoff } from "../idle-poll-backoff.ts";
import { chatResult, validateChatInput, type ChatInput } from "../../../cloud/supabase/functions/_shared/chat.ts";

const shared = join(import.meta.dirname, "../../../cloud/supabase/functions/_shared");
const instructions = readFileSync(join(shared, "chat-instructions.txt"), "utf8");
const schema = JSON.parse(readFileSync(join(shared, "chat-card-tool.json"), "utf8"));
const tool = { type: "function", function: { name: schema.name, description: schema.description, parameters: schema.inputSchema } };

export async function completeChatJob(input: ChatInput, model: Pick<DeepSeekBackend, "chat">) {
  const result = await model.chat([{ role: "system", content: `${instructions}\n当前provider为DeepSeek Cloud。你只能阅读文字，任何本机图片别名都不含像素，不能声称看过图片；可使用用户提供的文字描述及本轮图片别名创建卡片。` },
    ...input.messages], input.tools_enabled ? [tool] : [], { aborted: false }, 8192);
  const normalized = chatResult({ message: { role: result.message.role, content: result.message.content ?? null,
    ...(result.message.tool_calls ? { tool_calls: result.message.tool_calls } : {}) },
    usage: { input_tokens: result.usage.promptTokens, output_tokens: result.usage.completionTokens } });
  if (!input.tools_enabled && normalized.message.tool_calls?.length) throw new Error("chat_unexpected_tool_call");
  return normalized;
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error("chat_empty_response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length;
      if (length > limit) { await reader.cancel(); throw new Error("chat_response_too_large"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

type ChatJob = { id: string; lease_id: string; input_hash: string; input_url: string };
export type ChatControl = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
export async function processChatJob(job: ChatJob, control: ChatControl, model: Pick<DeepSeekBackend, "chat">, modelName: string, download: typeof fetch = fetch): Promise<void> {
  let submitted = false;
  let result;
  try {
    const response = await download(job.input_url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("chat_input_unavailable");
    const text = await boundedText(response, 300_000);
    if (createHash("sha256").update(text).digest("hex") !== job.input_hash) throw new Error("chat_input_hash_mismatch");
    const input = validateChatInput(JSON.parse(text));
    submitted = true;
    result = await completeChatJob(input, model);
  } catch (error) {
    const rejected = error instanceof DeepSeekBackendError && error.status !== undefined && error.status >= 400 && error.status < 500;
    await control({ action: "finish", job_id: job.id, lease_id: job.lease_id, status: !submitted || rejected ? "failed" : "outcome_unknown" });
    return;
  }
  // If settlement transport fails, do not submit the model again or overwrite success.
  await control({ action: "finish", job_id: job.id, lease_id: job.lease_id, status: "succeeded", result: { ...result, model: modelName } });
}

export async function runChatWorker(env: Record<string, string | undefined>): Promise<never> {
  const url = env.CHAT_CONTROL_URL?.trim(), token = env.CHAT_WORKER_TOKEN?.trim();
  if (!url || !token || !url.startsWith("https://")) throw new Error("chat_worker_config_missing");
  const workerId = `chat-${randomUUID()}`;
  const control: ChatControl = async body => {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-worker-id": workerId, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("chat_control_failed");
    return JSON.parse(await boundedText(response, 400_000));
  };
  const config = deepSeekConfigFromEnv(env);
  const model = new DeepSeekBackend({ ...config, timeoutMs: 90_000 }, async (endpoint, request) => {
    const response = await fetch(endpoint, { ...request, signal: AbortSignal.timeout(90_000) });
    return { ok: response.ok, status: response.status, json: async () => JSON.parse(await boundedText(response, 400_000)) };
  });
  const backoff = new IdlePollBackoff(1500, 15_000);
  for (;;) {
    try {
      const claim = await control({ action: "claim" });
      if (claim.job) { backoff.reset(); await processChatJob(claim.job as ChatJob, control, model, config.model); continue; }
    } catch { console.error(JSON.stringify({ event: "chat_worker_poll_failed" })); }
    await new Promise<void>(resolve => setTimeout(() => resolve(), backoff.nextDelayMs()));
  }
}
