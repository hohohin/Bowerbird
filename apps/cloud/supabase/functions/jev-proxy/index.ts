import { requireUser } from "../_shared/auth.ts";
import { ensureDailyCredits } from "../_shared/billing.ts";
import { createArkAdapter } from "../_shared/ark.ts";
import {
  ApiError,
  errorResponse,
  jsonResponse,
  requestId,
  safeLog,
} from "../_shared/errors.ts";
import { corsHeaders } from "../_shared/limits.ts";
import {
  catalogue,
  discoveryResult,
  hash,
  hasMatches,
  jpeg,
  judgeInput,
  readJson,
  text,
} from "./protocol.ts";
import { PROMPT } from "./prompt.ts";

function positive(name: string, fallback?: number): number {
  const value = Number(Deno.env.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ApiError("not_configured", `${name} 尚未配置`);
  }
  return value;
}
function rpcError(error: any): never {
  const detail = error?.details;
  if (detail === "insufficient_credits") {
    throw new ApiError(
      "insufficient_credits",
      "积分不足，分类需预留 1 积分，累计成功 5 张后扣除",
    );
  }
  if (
    detail === "rate_limit_per_minute" || detail === "understand_daily_limit"
  ) throw new ApiError("rate_limited", "分类调用额度已用完，请稍后重试");
  if (detail === "daily_cost_limit") {
    throw new ApiError("cost_limit_reached", "今日云端分类额度已用完");
  }
  if (detail === "classification_conflict") {
    throw new ApiError(
      "invalid_request",
      "分类请求已过期或内容发生变化，请重新分类",
    );
  }
  throw new ApiError("internal_error", "分类计费服务暂时不可用", true);
}
function replay(row: any, action: string): any {
  const response = action === "judge"
    ? row.judge_response
    : row.discovery_response;
  if (!response) {
    throw new ApiError(
      "invalid_request",
      ["judging", "discovering"].includes(row.status)
        ? "分类请求正在处理，请勿重复提交"
        : "分类结果已失效，请重新分类",
    );
  }
  return action === "judge"
    ? { ...response, classification_id: row.id }
    : response;
}

export async function handler(req: Request): Promise<Response> {
  const id = requestId(req);
  let cors: HeadersInit = {};
  let userId: string | undefined;
  let admin: any;
  let claimedId: string | undefined;
  // Once a valid upstream result exists, a failed DB settlement is NOT converted
  // to a failure/refund. The same request is left pending for reconciliation/expiry.
  let settling = false;
  try {
    cors = corsHeaders(req);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (req.method !== "POST") {
      throw new ApiError("invalid_request", "仅支持 POST");
    }
    const auth = await requireUser(req);
    admin = auth.admin;
    userId = auth.user.id;
    const body = await readJson(req);
    const advance = async (
      action: string,
      extra: Record<string, unknown> = {},
    ) => {
      const { data, error } = await admin.rpc("advance_classification", {
        p_user_id: userId,
        p_id: claimedId,
        p_action: action,
        ...extra,
      });
      if (error) rpcError(error);
      return data;
    };
    if (body.action === "judge") {
      const key = text(body.idempotency_key, 100), input = judgeInput(body);
      if (typeof body.allow_discovery !== "boolean") {
        throw new ApiError("invalid_request", "缺少分类模式");
      }
      const apiKey = Deno.env.get("JEV_API_KEY")?.trim();
      if (!apiKey) throw new ApiError("not_configured", "云端 Jev 尚未配置");
      const cost = positive("JEV_CLASSIFICATION_COST_MICROS"); // Includes possible Cloud fallback; conservative reservation.
      const { error: cleanupError } = await admin.rpc("cleanup_classification");
      if (cleanupError) rpcError(cleanupError);
      await ensureDailyCredits(admin, userId!);
      const { data: tier, error: tierError } = await admin.from("subscriptions")
        .select("tier,status,current_period_end").eq("user_id", userId)
        .maybeSingle();
      if (tierError) rpcError(tierError);
      const paid = tier && tier.tier !== "free" && tier.status === "active" &&
        (!tier.current_period_end ||
          Date.parse(tier.current_period_end) > Date.now());
      const { data: claim, error } = await admin.rpc("begin_classification", {
        p_user_id: userId,
        p_key: key,
        p_input_hash: await hash(JSON.stringify(body)),
        p_image_hash: await hash(input.images[0]),
        p_allow_discovery: body.allow_discovery,
        p_cost_micros: cost,
        p_daily_limit: positive("DAILY_COST_LIMIT_CNY", 500) * 1_000_000,
        p_rate_limit: positive("RATE_LIMIT_PER_USER_PER_MIN", 10),
        p_free_limit: paid ? null : positive("FREE_CAPTION_DAILY_LIMIT", 10),
      });
      if (error) rpcError(error);
      if (!claim.claimed) {
        return jsonResponse(replay(claim.request, "judge"), 200, cors);
      }
      claimedId = claim.request.id;
      let response: any;
      if (input.count === 0) {
        response = {
          model: "jev-latest",
          answers: {
            labels: {
              type: "choice",
              confidence: 1,
              choice: "no_match",
              probabilities: { no_match: 1 },
            },
          },
        };
      } else {
        const form = new FormData();
        form.append(
          "request",
          new Blob([JSON.stringify(input.request)], {
            type: "application/json",
          }),
        );
        input.images.forEach((bytes, i) =>
          form.append(
            `image${i}`,
            new Blob([bytes as Uint8Array<ArrayBuffer>], {
              type: "image/jpeg",
            }),
            `image${i}.jpg`,
          )
        );
        let upstream: Response;
        try {
          upstream = await fetch("https://api.typesafe.ai/v1/systemone", {
            method: "POST",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "TypeSafe-Danger-Zone-Images": "true",
            },
            body: form,
            signal: AbortSignal.timeout(110_000),
          });
        } catch {
          throw new ApiError("upstream_timeout", "Jev 请求未完成，此图不计费");
        }
        if (!upstream.ok) {
          await upstream.body?.cancel();
          throw new ApiError(
            "upstream_failed",
            `Jev 暂时无法分类（HTTP ${upstream.status}），此图不计费`,
          );
        }
        response = await readJson(upstream, 512 * 1024);
      }
      const success = hasMatches(response, input.count);
      settling = true;
      const row = await advance(
        !success && body.allow_discovery ? "await_discovery" : "judge_done",
        { p_response: response, p_success: success },
      );
      return jsonResponse(replay(row, "judge"), 200, cors);
    }
    if (body.action === "discover") {
      const ticket = text(body.classification_id, 36);
      if (!/^[0-9a-f-]{36}$/i.test(ticket)) {
        throw new ApiError("invalid_request", "分类凭据无效");
      }
      const bytes = jpeg(body.image), labels = catalogue(body.labels);
      const instruction = `${PROMPT}\n当前完整词表（JSON）：${
        JSON.stringify(labels)
      }`;
      if (instruction.length > 20_000) {
        throw new ApiError(
          "invalid_request",
          "完整分类词表超过 20000 字符，请精简说明",
        );
      }
      const { data: claim, error } = await admin.rpc("advance_classification", {
        p_user_id: userId,
        p_id: ticket,
        p_action: "claim_discovery",
        p_image_hash: await hash(bytes),
        p_hash: await hash(JSON.stringify(body)),
      });
      if (error) rpcError(error);
      if (!claim.claimed) {
        return jsonResponse(replay(claim.request, "discover"), 200, cors);
      }
      claimedId = ticket;
      const result = await createArkAdapter().understand({
        operation: "classify",
        image: { mime: "image/jpeg", base64: body.image },
        instruction,
      });
      const parsed = discoveryResult(result.text, labels);
      settling = true;
      const row = await advance("discovery_done", {
        p_response: parsed.value,
        p_success: parsed.success,
      });
      return jsonResponse(replay(row, "discover"), 200, cors);
    }
    throw new ApiError("invalid_request", "未知分类操作");
  } catch (error) {
    if (admin && claimedId && !settling) {
      const { error: rollback } = await admin.rpc("advance_classification", {
        p_user_id: userId,
        p_id: claimedId,
        p_action: "fail",
      });
      if (rollback) {
        safeLog({
          requestId: id,
          userId,
          service: "classification",
          status: "rollback_pending",
        });
      }
    }
    safeLog({
      requestId: id,
      userId,
      service: "classification",
      status: error instanceof ApiError ? error.code : "failed",
    });
    return errorResponse(error, id, cors);
  }
}
if (import.meta.main) Deno.serve(handler);
