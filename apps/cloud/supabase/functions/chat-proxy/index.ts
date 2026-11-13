import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { requireUser } from "../_shared/auth.ts";
import { ensureDailyCredits } from "../_shared/billing.ts";
import {
  CHAT_SERVICE,
  DSH_CHAT_ENGINE_V2,
  chatFailure,
  ChatInputError,
  parseChatToolReceipt,
  validChatCallId,
  validateChatInput,
} from "../_shared/chat.ts";
import {
  ApiError,
  errorResponse,
  jsonResponse,
  requestId,
} from "../_shared/errors.ts";
import { corsHeaders } from "../_shared/limits.ts";
import { activeTier, accountTestMarker, policyForUser, UNIFIED_AGENT_SKILL } from "../_shared/feature-policy.ts";

type Job = {
  id: string;
  status: string;
  request_object_key: string;
  input_hash: string;
  result_json: Record<string, unknown> | null;
  estimated_credits: number;
  actual_credits: number | null;
  pricing_version: number;
  hold_id: string;
  error_code: string | null;
  content_expires_at: string;
  lease_expires_at: string | null;
  pending_tool?: Record<string, unknown> | null;
};
const BUCKET = "generation-temp";
const enabled = () => Deno.env.get("CHAT_ENABLED") === "true";
const dshEnabled = () => Deno.env.get("CHAT_DSH_VPS_ENABLED") === "true";
const dshV2Enabled = () => dshEnabled() && Deno.env.get("CHAT_DSH_VPS_V2_ENABLED") === "true";
async function skillsAvailable(admin: SupabaseClient, user: { id: string; app_metadata?: unknown }) {
  if (!dshEnabled() || !accountTestMarker(user.app_metadata) ||
      Deno.env.get("AGENT_DSH_RUNTIME_SELECTION_ENABLED")?.trim().toLowerCase() !== "true" ||
      Deno.env.get("AGENT_UNIFIED_DSH_ENABLED")?.trim().toLowerCase() !== "true") return false;
  const account = await admin.from("billing_accounts").select("id").eq("auth_user_id", user.id).maybeSingle();
  if (account.error || !account.data) return false;
  const subscription = await admin.from("subscriptions").select("tier,status,current_period_end").eq("user_id", account.data.id).maybeSingle();
  if (subscription.error) return false;
  const policy = policyForUser(activeTier(subscription.data), user);
  return policy.can_use_agent_runs && policy.allowed_agent_skills.includes(UNIFIED_AGENT_SKILL);
}
const hash = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
const scalar = <T>(value: T | T[]) => Array.isArray(value) ? value[0] : value;

function response(job: Job, cors: HeadersInit, includeTool = false): Response {
  const expired = Date.parse(job.content_expires_at) <= Date.now();
  const error = job.status === "outcome_unknown" || job.status === "failed"
    ? chatFailure(job.status, job.error_code)
    : job.status === "succeeded" && (expired || !job.result_json)
    ? {
      code: "content_expired",
      recoverable: false,
      message: "云端临时回复已过期，本机已保存的历史仍可查看。",
    }
    : undefined;
  return jsonResponse(
    {
      job_id: job.id,
      status: job.status,
      charge: {
        estimated: job.estimated_credits,
        actual: job.actual_credits,
        pricing_version: job.pricing_version,
        transaction_id: job.hold_id,
      },
      ...(job.status === "succeeded" && !expired ? job.result_json : {}),
      ...(includeTool && !expired && job.status === "running" && job.pending_tool &&
        Date.parse(job.lease_expires_at ?? "") > Date.now() ? { pending_tool: job.pending_tool } : {}),
      ...(error ? { error } : {}),
    },
    ["uploading", "queued", "running"].includes(job.status) ? 202 : 200,
    cors,
  );
}

async function create(
  admin: SupabaseClient,
  user: { id: string; app_metadata?: unknown },
  raw: Record<string, unknown>,
  cors: HeadersInit,
): Promise<Response> {
  const userId = user.id;
  if (
    Object.keys(raw).some((key) =>
      !["action", "idempotency_key", "messages", "tools_enabled", "engine", "conversation_id", "skill"].includes(key)
    ) ||
    typeof raw.idempotency_key !== "string" || !raw.idempotency_key.trim() ||
    raw.idempotency_key.length > 200
  ) throw new ApiError("invalid_request", "对话请求格式无效");
  const input = validateChatInput({
    messages: raw.messages,
    engine: raw.engine,
    conversation_id: raw.conversation_id,
    skill: raw.skill,
    ...(raw.tools_enabled === undefined
      ? {}
      : { tools_enabled: raw.tools_enabled }),
  });
  const body = JSON.stringify(input), digest = await hash(body);
  if (input.engine !== DSH_CHAT_ENGINE_V2) {
    // Old clients can finish an interrupted upload or retrieve their exact original order.
    const existing = await admin.from("chat_completion_jobs").select(
      "id,status,input_hash,request_object_key,actual_credits,estimated_credits,pricing_version,hold_id,error_code,content_expires_at,lease_expires_at,result_json,dsh_tools_enabled",
    ).eq("user_id", userId).eq("idempotency_key", raw.idempotency_key).maybeSingle();
    if (existing.error) throw new ApiError("internal_error", "云端对话暂时无法读取", true);
    if (!existing.data) throw new ApiError("invalid_request", "云端对话已统一为 DSH · Cloud，请更新 Bowerbird 桌面端后再发送。", false, 426);
    if (existing.data.input_hash !== digest) {
      throw new ApiError("invalid_request", "此请求已用于其他对话内容", false, 409);
    }
    return enqueueIfUploading(admin, existing.data as Job, body, digest, cors);
  }
  if (!dshV2Enabled()) throw new ApiError("not_configured", "云端 DSH 尚未开放");
  if (input.skill && !await skillsAvailable(admin, user)) throw new ApiError("upgrade_required", "当前账号暂不可使用该 Agent 技能");
  await ensureDailyCredits(admin, userId);
  const daily = Number(Deno.env.get("DAILY_COST_LIMIT_CNY") ?? 500) * 1_000_000;
  const rate = Number(Deno.env.get("RATE_LIMIT_PER_USER_PER_MIN") ?? 10);
  if (
    !Number.isSafeInteger(daily) || daily <= 0 || !Number.isSafeInteger(rate) ||
    rate <= 0
  ) throw new ApiError("not_configured", "云端对话额度配置无效");
  const begun = await admin.rpc("begin_chat_session_turn", {
    p_conversation: input.conversation_id,
    p_dsh_tools: input.tools_enabled,
    p_user_id: userId,
    p_key: raw.idempotency_key,
    p_hash: digest,
    p_object_key: `chat/${userId}/${await hash(
      raw.idempotency_key,
    )}/request.json`,
    p_daily_cost_limit: daily,
    p_per_minute: rate,
  });
  if (begun.error) {
    if (begun.error.details === "chat_session_busy") {
      throw new ApiError("invalid_request", "这段云端对话仍在处理上一轮，请稍后继续", false, 409);
    }
    if (begun.error.message.includes("test price")) {
      throw new ApiError(
        "not_configured",
        "对话价格已调整，请更新客户端后再试",
      );
    }
    if (begun.error.message.includes("different content")) {
      throw new ApiError(
        "invalid_request",
        "此请求已用于其他对话内容",
        false,
        409,
      );
    }
    if (begun.error.details === "rate_limit_per_minute") {
      throw new ApiError("rate_limited", "请求过于频繁，请稍后再试", true);
    }
    if (begun.error.details === "daily_cost_limit") {
      throw new ApiError("cost_limit_reached", "云端今日成本额度已用完", true);
    }
    throw new ApiError("internal_error", "云端对话暂时无法创建", true);
  }
  return enqueueIfUploading(admin, scalar(begun.data) as Job, body, digest, cors);
}

async function enqueueIfUploading(admin: SupabaseClient, job: Job, body: string, digest: string, cors: HeadersInit) {
  if (job.status !== "uploading") return response(job, cors);
  const uploaded = await admin.storage.from(BUCKET).upload(
    job.request_object_key,
    new TextEncoder().encode(body),
    { contentType: "application/json", upsert: true },
  );
  const queued = await admin.rpc("enqueue_chat_completion", {
    p_id: job.id,
    p_hash: digest,
    p_success: !uploaded.error,
  });
  if (queued.error) {
    throw new ApiError(
      "internal_error",
      "云端对话排队状态待确认，请稍后查看",
      true,
    );
  }
  return response(scalar(queued.data) as Job, cors);
}

Deno.serve(async (request: Request) => {
  const cors = corsHeaders(request), id = requestId(request);
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  try {
    if (request.method !== "POST") {
      throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    }
    const { user, admin } = await requireUser(request);
    const body = await request.text();
    const raw = JSON.parse(body) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError("invalid_request", "请求格式无效");
    }
    if (raw.action === "quote") {
      const price = await admin.from("service_costs").select(
        "unit_cost,pricing_version,active",
      ).eq("service", CHAT_SERVICE).maybeSingle();
      if (price.error) {
        throw new ApiError("internal_error", "对话报价暂时不可用", true);
      }
      const available = enabled() && dshV2Enabled() && price.data?.active === true && price.data?.unit_cost === 0;
      return jsonResponse(
        {
          provider: "dsh-cloud",
          service: CHAT_SERVICE,
          currency: "Bcoin",
          unit_cost: price.data?.unit_cost ?? null,
          pricing_version: price.data?.pricing_version ?? null,
          available,
          dsh_vps_available: false,
          dsh_vps_v2_available: available,
          dsh_vps_skills_available: available && await skillsAvailable(admin, user),
        },
        200,
        cors,
      );
    }
    if (raw.action === "tool_result") {
      if (typeof raw.job_id !== "string" || !validChatCallId(raw.call_id))
        throw new ApiError("invalid_request", "工具回执身份无效");
      const ack = await admin.rpc("ack_chat_dsh", { p_user: user.id, p_id: raw.job_id,
        p_call: raw.call_id, p_result: parseChatToolReceipt(raw.result) });
      if (ack.error || ack.data !== true) throw new ApiError("invalid_request", "这次工具请求已失效或回执不匹配", false, 409);
      return jsonResponse({ ok: true }, 200, cors);
    }
    if (raw.action === "get" || raw.action === "cancel") {
      const byId = typeof raw.job_id === "string",
        byKey = typeof raw.idempotency_key === "string";
      if (byId === byKey) {
        throw new ApiError("invalid_request", "请选择一种对话请求身份");
      }
      if (raw.action === "cancel") {
        const stopped = await admin.rpc("cancel_chat_dsh", { p_user: user.id, p_id: byId ? raw.job_id : null, p_key: byKey ? raw.idempotency_key : null });
        if (stopped.error) throw new ApiError("internal_error", "停止云端对话暂未确认", true);
        const job = scalar(stopped.data) as Job | null;
        if (!job?.id) throw new ApiError("invalid_request", "找不到可停止的云端 DSH 请求", false, 404);
        return response(job, cors);
      }
      const result = await admin.from("chat_completion_jobs").select(
        "id,status,actual_credits,estimated_credits,pricing_version,hold_id,error_code,content_expires_at,lease_expires_at,result_json,pending_tool",
      ).eq(
        byId ? "id" : "idempotency_key",
        byId ? raw.job_id : raw.idempotency_key,
      ).eq("user_id", user.id).maybeSingle();
      if (result.error) {
        throw new ApiError("internal_error", "对话结果暂时无法读取", true);
      }
      if (!result.data) {
        throw new ApiError("invalid_request", "对话请求不存在", false, 404);
      }
      return response(result.data as Job, cors, true);
    }
    if (raw.action !== "create") {
      throw new ApiError("invalid_request", "未知对话操作");
    }
    if (!enabled()) throw new ApiError("not_configured", "云端对话尚未开放");
    return await create(admin, user, raw, cors);
  } catch (error) {
    return errorResponse(
      error instanceof ChatInputError
        ? new ApiError("invalid_request", error.message)
        : error,
      id,
      cors,
    );
  }
});
