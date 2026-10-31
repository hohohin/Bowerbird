import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { chatResult } from "../_shared/chat.ts";
import {
  ApiError,
  errorResponse,
  jsonResponse,
  requestId,
} from "../_shared/errors.ts";

const BUCKET = "generation-temp";
const required = (name: string) => {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new ApiError("not_configured", `${name} 未配置`);
  return value;
};
function secretKey(): string {
  const direct = Deno.env.get("SUPABASE_SECRET_KEY")?.trim();
  if (direct) return direct;
  const object = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (object) {
    const key = JSON.parse(object).default;
    if (typeof key === "string" && key) return key;
  }
  return required("SUPABASE_SERVICE_ROLE_KEY");
}
function authorize(request: Request): SupabaseClient {
  const expected = required("CHAT_WORKER_TOKEN"),
    actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      "";
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ (actual.charCodeAt(i) || 0);
  }
  if (diff) throw new ApiError("unauthorized", "Worker 认证失败");
  return createClient(required("SUPABASE_URL"), secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
async function cleanup(admin: SupabaseClient): Promise<void> {
  const rows = await admin.from("chat_completion_jobs").select(
    "id,request_object_key",
  ).lt("content_expires_at", new Date().toISOString())
    .in("status", ["succeeded", "failed", "outcome_unknown"]).is(
      "content_deleted_at",
      null,
    ).limit(100);
  if (rows.error) {
    throw new ApiError("internal_error", "对话临时内容清理失败", true);
  }
  if (!rows.data?.length) return;
  const removed = await admin.storage.from(BUCKET).remove(
    rows.data.map((row) => row.request_object_key),
  );
  if (removed.error) {
    throw new ApiError("internal_error", "对话临时内容清理失败", true);
  }
  const cleared = await admin.from("chat_completion_jobs").update({
    result_json: null,
    content_deleted_at: new Date().toISOString(),
  }).in("id", rows.data.map((row) => row.id));
  if (cleared.error) {
    throw new ApiError("internal_error", "对话临时内容清理失败", true);
  }
}

Deno.serve(async (request: Request) => {
  const id = requestId(request);
  try {
    if (request.method !== "POST") {
      throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    }
    const admin = authorize(request), raw = await request.json();
    if (raw.action === "claim") {
      const worker = request.headers.get("x-worker-id") ?? "";
      await cleanup(admin);
      const result = await admin.rpc("claim_chat_completion", {
        p_worker: worker,
      });
      if (result.error) {
        throw new ApiError("internal_error", "领取对话请求失败", true);
      }
      const job = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!job?.id) return jsonResponse({ job: null });
      const signed = await admin.storage.from(BUCKET).createSignedUrl(
        job.request_object_key,
        180,
      );
      if (signed.error) {
        await admin.rpc("finish_chat_completion", {
          p_id: job.id,
          p_lease: job.lease_id,
          p_status: "failed",
          p_result: null,
          p_error: "chat_input_unavailable",
        });
        throw new ApiError("internal_error", "读取对话输入失败", true);
      }
      return jsonResponse({
        job: {
          id: job.id,
          lease_id: job.lease_id,
          input_hash: job.input_hash,
          input_url: signed.data.signedUrl,
        },
      });
    }
    if (raw.action === "finish") {
      if (
        typeof raw.job_id !== "string" || typeof raw.lease_id !== "string" ||
        !["succeeded", "failed", "outcome_unknown"].includes(raw.status)
      ) throw new ApiError("invalid_request", "对话完成信息无效");
      const result = raw.status === "succeeded" ? chatResult(raw.result) : null;
      if (
        result &&
        (typeof raw.result.model !== "string" || !raw.result.model.trim() ||
          raw.result.model.length > 120)
      ) throw new ApiError("invalid_request", "模型计量身份无效");
      const finished = await admin.rpc("finish_chat_completion", {
        p_id: raw.job_id,
        p_lease: raw.lease_id,
        p_status: raw.status,
        p_result: result ? { ...result, model: raw.result.model } : null,
        p_error: raw.status === "failed"
          ? "chat_upstream_rejected"
          : "chat_outcome_unknown",
      });
      if (finished.error) {
        throw new ApiError(
          "invalid_request",
          "对话租约已失效或结果无效",
          false,
          409,
        );
      }
      return jsonResponse({ ok: true });
    }
    throw new ApiError("invalid_request", "未知 Worker 操作");
  } catch (error) {
    return errorResponse(error, id);
  }
});
