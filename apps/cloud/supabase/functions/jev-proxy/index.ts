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
  englishMode,
  hash,
  hasMatches,
  jpeg,
  judgeInput,
  readJson,
  text,
} from "./protocol.ts";
import { discoveryPrompt } from "./prompt.ts";
import { recordDiscoveryUsage } from "./usage.ts";
import { translateBatch, translationBatches } from "./translation.ts";

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
      "Bcoin 不足，分类每张预留 1 Bcoin，成功获得标签后扣除",
    );
  }
  if (detail === "understand_daily_limit") {
    throw new ApiError("rate_limited", "今日分类调用额度已用完");
  }
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
      const batches = translationBatches(input.translations);
      // Translation shares the image's charge but each bounded supplier call
      // reserves an additional conservative internal cost budget.
      const cost = positive("JEV_CLASSIFICATION_COST_MICROS") * (1 + batches.length);
      if (!Number.isSafeInteger(cost)) throw new ApiError("not_configured", "分类成本预算配置无效");
      const { error: cleanupError } = await admin.rpc("cleanup_classification");
      if (cleanupError) rpcError(cleanupError);
      await ensureDailyCredits(admin, userId!);
      const { data: claim, error } = await admin.rpc("begin_classification", {
        p_user_id: userId,
        p_key: key,
        p_input_hash: await hash(JSON.stringify(body)),
        p_image_hash: await hash(input.images[0]),
        p_allow_discovery: body.allow_discovery,
        p_cost_micros: cost,
        p_daily_limit: positive("DAILY_COST_LIMIT_CNY", 500) * 1_000_000,
        p_rate_limit: null, // Classification has no Bowerbird per-user frequency limit.
        p_free_limit: null, // Bcoin usage is available to every tier; wallet and global cost limits still apply.
      });
      if (error) rpcError(error);
      if (!claim.claimed && !(batches.length && claim.request.status === "judging")) {
        return jsonResponse(replay(claim.request, "judge"), 200, cors);
      }
      const ticket = claim.request.id;
      let translations = [];
      if (batches.length) {
        const { data: preparation, error: prepareError } = await admin.rpc("claim_classification_preparation", {
          p_user_id: userId, p_id: ticket, p_batch_count: batches.length,
          p_provider: (Deno.env.get("BOWERBIRD_CLOUD_MOCK") ?? "true") === "true" ? "mock" : "ark",
          p_requested_model: Deno.env.get("ARK_VISION_MODEL")?.trim() || null,
        });
        if (prepareError) {
          // Even the first begin caller may lose the preparation claim to a
          // concurrent replay. Only a known operation owner may fail/refund it.
          rpcError(prepareError);
        }
        translations = preparation.translations;
        if (preparation.phase === "busy") return jsonResponse({ preparing: true, retry_after_ms: 1000,
          classification_id: ticket, prompt_language: "en", label_translations: translations }, 200, cors);
        claimedId = ticket;
        if (preparation.phase === "translate") {
          const translated = await translateBatch(admin, userId!, ticket, preparation.batch, batches[preparation.batch]);
          // A lost cache-write acknowledgement must preserve the same ticket:
          // its committed translation can be recovered without paying twice.
          settling = true;
          const { data: saved, error: saveError } = await admin.rpc("finish_classification_preparation", {
            p_user_id: userId, p_id: ticket, p_batch: preparation.batch, p_translations: translated,
          });
          if (saveError) rpcError(saveError);
          return jsonResponse({ preparing: true, retry_after_ms: 0, classification_id: ticket,
            prompt_language: "en", label_translations: saved }, 200, cors);
        }
      } else claimedId = ticket;
      for (const label of translations) {
        const criterion = input.request.questions.labels.criteria[label.key] as Record<string, unknown>;
        criterion.name = label.name;
        criterion.description = label.description;
      }
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
      const success = hasMatches(response, input.count, input.minProbability);
      if (input.english) response = { ...response, prompt_language: "en", label_translations: translations };
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
      const bytes = jpeg(body.image), labels = catalogue(body.labels), english = englishMode(body);
      const instruction = `${discoveryPrompt(english)}\n当前完整词表（JSON）：${
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
      const { data: started, error: usageError } = await admin.rpc("start_classification_usage", {
        p_user_id: userId,
        p_id: ticket,
        p_provider: (Deno.env.get("BOWERBIRD_CLOUD_MOCK") ?? "true") === "true" ? "mock" : "ark",
        p_requested_model: Deno.env.get("ARK_VISION_MODEL")?.trim() || null,
      });
      if (usageError) rpcError(usageError);
      if (!started) throw new ApiError("invalid_request", "补标签请求已开始，请勿重复提交");
      const result = await createArkAdapter().understand({
        operation: "classify",
        image: { mime: "image/jpeg", base64: body.image },
        instruction,
        maxOutputTokens: english ? 6000 : 2000,
      }, (usage) => recordDiscoveryUsage(admin, userId!, ticket, usage));
      const parsed = discoveryResult(result.text, labels, english);
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
