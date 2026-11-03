import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { requireUser } from "../_shared/auth.ts";
import { ensureDailyCredits } from "../_shared/billing.ts";
import {
  CHAT_SERVICE,
  ChatInputError,
  validateChatInput,
} from "../_shared/chat.ts";
import {
  ApiError,
  errorResponse,
  jsonResponse,
  requestId,
} from "../_shared/errors.ts";
import { corsHeaders } from "../_shared/limits.ts";

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
};
const BUCKET = "generation-temp";
const enabled = () => Deno.env.get("CHAT_ENABLED") === "true";
const hash = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
const scalar = <T>(value: T | T[]) => Array.isArray(value) ? value[0] : value;

function response(job: Job, cors: HeadersInit): Response {
  const expired = Date.parse(job.content_expires_at) <= Date.now();
  const error = job.status === "outcome_unknown"
    ? {
      code: "chat_outcome_unknown",
      message: "本次云端回复结果尚未确认，请稍后查看；不会自动重新提交。",
    }
    : job.status === "failed"
    ? {
      code: job.error_code ?? "chat_failed",
      message: "云端回复未完成，请重新发送。",
    }
    : job.status === "succeeded" && (expired || !job.result_json)
    ? {
      code: "content_expired",
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
      ...(error ? { error } : {}),
    },
    ["uploading", "queued", "running"].includes(job.status) ? 202 : 200,
    cors,
  );
}

async function create(
  admin: SupabaseClient,
  userId: string,
  raw: Record<string, unknown>,
  cors: HeadersInit,
): Promise<Response> {
  if (
    Object.keys(raw).some((key) =>
      !["action", "idempotency_key", "messages", "tools_enabled"].includes(key)
    ) ||
    typeof raw.idempotency_key !== "string" || !raw.idempotency_key.trim() ||
    raw.idempotency_key.length > 200
  ) throw new ApiError("invalid_request", "对话请求格式无效");
  const input = validateChatInput({
    messages: raw.messages,
    ...(raw.tools_enabled === undefined
      ? {}
      : { tools_enabled: raw.tools_enabled }),
  });
  const body = JSON.stringify(input), digest = await hash(body);
  await ensureDailyCredits(admin, userId);
  const daily = Number(Deno.env.get("DAILY_COST_LIMIT_CNY") ?? 500) * 1_000_000;
  const rate = Number(Deno.env.get("RATE_LIMIT_PER_USER_PER_MIN") ?? 10);
  if (
    !Number.isSafeInteger(daily) || daily <= 0 || !Number.isSafeInteger(rate) ||
    rate <= 0
  ) throw new ApiError("not_configured", "云端对话额度配置无效");
  const begun = await admin.rpc("begin_chat_completion", {
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
  let job = scalar(begun.data) as Job;
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
  job = scalar(queued.data) as Job;
  return response(job, cors);
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
    if (new TextEncoder().encode(body).length > 320_000) {
      throw new ApiError("payload_too_large", "对话上下文过长，请新建对话");
    }
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
      return jsonResponse(
        {
          provider: "deepseek-cloud",
          service: CHAT_SERVICE,
          currency: "Bcoin",
          unit_cost: price.data?.unit_cost ?? null,
          pricing_version: price.data?.pricing_version ?? null,
          available: enabled() && price.data?.active === true &&
            price.data?.unit_cost === 0,
        },
        200,
        cors,
      );
    }
    if (raw.action === "get") {
      const byId = typeof raw.job_id === "string",
        byKey = typeof raw.idempotency_key === "string";
      if (byId === byKey) {
        throw new ApiError("invalid_request", "请选择一种对话请求身份");
      }
      const result = await admin.from("chat_completion_jobs").select("*").eq(
        byId ? "id" : "idempotency_key",
        byId ? raw.job_id : raw.idempotency_key,
      ).eq("user_id", user.id).maybeSingle();
      if (result.error) {
        throw new ApiError("internal_error", "对话结果暂时无法读取", true);
      }
      if (!result.data) {
        throw new ApiError("invalid_request", "对话请求不存在", false, 404);
      }
      return response(result.data as Job, cors);
    }
    if (raw.action !== "create") {
      throw new ApiError("invalid_request", "未知对话操作");
    }
    if (!enabled()) throw new ApiError("not_configured", "云端对话尚未开放");
    return await create(admin, user.id, raw, cors);
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
