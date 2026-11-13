import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DeepSeekBackend, DeepSeekBackendError, deepSeekConfigFromEnv, type DeepSeekFetch } from "../providers/deepseek/backend.ts";
import { dshDeepSeekConfig } from "../providers/deepseek/dsh-config.ts";
import { IdlePollBackoff } from "../idle-poll-backoff.ts";
import { ChatInputError, chatResult, DSH_CHAT_ENGINE, DSH_CHAT_ENGINE_V2, isDshChatEngine, validateChatInput, type ChatInput, type DshChatEngine } from "../../../cloud/supabase/functions/_shared/chat.ts";
import { DshChatDeadline, DshChatLeaseLost, runDshChat, type DshChatOptions } from "./dsh.ts";

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
  if (!input.tools_enabled && normalized.message.tool_calls?.length) throw new ChatInputError("chat_unexpected_tool_call");
  return normalized;
}

type ChatJob = { id: string; lease_id: string; input_hash: string; input_url: string; engine?: DshChatEngine; session_key?: string; previous_job_id?: string | null };
export type ChatControl = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

function upstreamFailure(error: unknown): string {
  if (error instanceof DshChatDeadline) return "chat_dsh_deadline";
  if (error instanceof ChatInputError) return "chat_reply_format";
  if (error instanceof DeepSeekBackendError) {
    if (error.status !== undefined) return `chat_upstream_http_${error.status}`;
    switch (error.safeCode) {
      case "deepseek_timeout": return "chat_upstream_timeout";
      case "deepseek_network_error": return "chat_upstream_connection";
      case "deepseek_invalid_json": return "chat_reply_json";
      case "deepseek_invalid_tool_arguments": return "chat_reply_tool_arguments";
      case "deepseek_invalid_response": return "chat_reply_format";
    }
  }
  return "chat_worker_error";
}
export async function processChatJob(job: ChatJob, control: ChatControl, model: Pick<DeepSeekBackend, "chat">, modelName: string, download: typeof fetch = fetch, dsh?: DshChatOptions): Promise<void> {
  let submissions = 0;
  let result;
  try {
    const response = await download(job.input_url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("chat_input_unavailable");
    const text = await response.text();
    if (createHash("sha256").update(text).digest("hex") !== job.input_hash) throw new Error("chat_input_hash_mismatch");
    const input = validateChatInput(JSON.parse(text));
    if (input.engine !== job.engine) throw new Error("chat_engine_identity_mismatch");
    if (isDshChatEngine(input.engine)) {
      if (!dsh) throw new Error("dsh_chat_worker_unavailable");
      modelName = dsh.upstream.model;
      result = await runDshChat(input, { job_id: job.id, lease_id: job.lease_id }, control, dsh, () => { submissions++; },
        job.session_key && job.previous_job_id !== undefined ? {session_key:job.session_key, previous_job_id:job.previous_job_id} : undefined);
    } else {
      submissions++;
      result = await completeChatJob(input, model);
    }
  } catch (error) {
    if (error instanceof DshChatLeaseLost) return; // Cancellation/lease expiry owns settlement.
    const rejected = submissions === 1 && error instanceof DeepSeekBackendError && error.status !== undefined && error.status >= 400 && error.status < 500;
    const code = submissions || error instanceof DshChatDeadline ? upstreamFailure(error) : "chat_input_unavailable";
    const status = !submissions || rejected ? "failed" : "outcome_unknown";
    console.warn(JSON.stringify({ event: "chat_job_failed", job_id: job.id, status, error_code: code }));
    await control({ action: "finish", job_id: job.id, lease_id: job.lease_id, ...(job.engine ? { engine: job.engine } : {}), status, error_code: code });
    return;
  }
  // If settlement transport fails, do not submit the model again or overwrite success.
  await control({ action: "finish", job_id: job.id, lease_id: job.lease_id, ...(job.engine ? { engine: job.engine } : {}),
    status: "succeeded", result: { ...result, model: modelName } });
}

export function chatUpstreamFetch(download: typeof fetch = fetch): DeepSeekFetch {
  return async (endpoint, request) => {
    const signal = AbortSignal.timeout(90_000);
    const connectionError = () => new DeepSeekBackendError(signal.aborted ? "deepseek_timeout" : "deepseek_network_error");
    const response = await download(endpoint, { ...request, signal }).catch(() => { throw connectionError(); });
    if (!response.ok) {
      void response.body?.getReader().cancel().catch(() => {});
      throw new DeepSeekBackendError("deepseek_http_error", { status: response.status });
    }
    return { ok: true, status: response.status, json: async () => {
      const body = await response.text().catch(() => { throw connectionError(); });
      try { return JSON.parse(body); } catch { throw new DeepSeekBackendError("deepseek_invalid_json"); }
    } };
  };
}

export async function consumeChatQueues(control: ChatControl, run: (job: ChatJob) => Promise<void>, dshEngine: DshChatEngine | false, signal?: AbortSignal) {
  async function consume(engine?: DshChatEngine) {
    const backoff = new IdlePollBackoff(1500, 15_000);
    while (!signal?.aborted) {
      try {
        const claim = await control({ action: "claim", ...(engine ? { engine } : {}) });
        if (claim.job) { backoff.reset(); await run(claim.job as ChatJob); continue; }
      } catch { console.error(JSON.stringify({ event: "chat_worker_poll_failed" })); }
      await new Promise<void>(resolve => setTimeout(resolve, backoff.nextDelayMs()));
    }
  }
  await Promise.all([consume(), ...(dshEngine ? [consume(dshEngine)] : [])]);
}

export async function runChatWorker(env: Record<string, string | undefined>): Promise<void> {
  const url = env.CHAT_CONTROL_URL?.trim(), token = env.CHAT_WORKER_TOKEN?.trim();
  if (!url || !token || !url.startsWith("https://")) throw new Error("chat_worker_config_missing");
  const workerId = `chat-${randomUUID()}`;
  const control: ChatControl = async body => {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-worker-id": workerId, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("chat_control_failed");
    return JSON.parse(await response.text());
  };
  const config = deepSeekConfigFromEnv(env);
  const dsh = env.BOWERBIRD_DSH_PROFILE_TEMPLATE && env.BOWERBIRD_DSH_RUNTIME_ROOT ? {
    profileTemplateDir: env.BOWERBIRD_DSH_PROFILE_TEMPLATE, runtimeRoot: env.BOWERBIRD_DSH_RUNTIME_ROOT,
    skillDir: env.BOWERBIRD_TEXT_SKILL_DIR, upstream: dshDeepSeekConfig(env, config), sessionRoot: env.BOWERBIRD_DSH_SESSION_ROOT,
  } : undefined;
  const model = new DeepSeekBackend({ ...config, timeoutMs: 90_000 }, chatUpstreamFetch());
  await consumeChatQueues(control, job => processChatJob(job, control, model, config.model, fetch, dsh), dsh ? dsh.sessionRoot ? DSH_CHAT_ENGINE_V2 : DSH_CHAT_ENGINE : false);
}
