import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createArkAdapter, type GenerateInput, type ImageInput, type MockScenario } from "../_shared/ark.ts";
import { requireUser } from "../_shared/auth.ts";
import {
  confirmCredits,
  holdCredits,
  markPendingSettlement,
  rollbackCredits,
} from "../_shared/billing.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { assertBodySize, assertReferenceImages, corsHeaders, withTimeout } from "../_shared/limits.ts";
import { reserveManagedUsage } from "../_shared/usage.ts";

// A queued remote task is durable in production via the credit_holds.pending_settlement row plus a
// server reconciliation task. This Mock module keeps per-isolate state so dev async flows finish;
// the real Ark adapter MUST persist remote_task_id and settle server-side (deferred, not faked here).
const REMOTE_TASKS = new Map<
  string,
  { status: "queued" | "succeeded"; polls: number; images: ImageInput[] }
>();

interface PollRequest {
  remote_task_id: string;
}

interface GenerateRequest {
  idempotency_key: string;
  media: "image" | "video";
  prompt: string;
  reference_images?: ImageInput[];
  ratio?: string;
  service?: string;
  mock_scenario?: MockScenario;
}

function validate(body: unknown): GenerateRequest {
  if (!body || typeof body !== "object") throw new ApiError("invalid_request", "请求格式错误");
  const value = body as Record<string, unknown>;
  if (typeof value.idempotency_key !== "string" || !value.idempotency_key.trim()) {
    throw new ApiError("invalid_request", "缺少幂等键");
  }
  if (value.media !== "image" && value.media !== "video") {
    throw new ApiError("invalid_request", "media 必须是 image 或 video");
  }
  if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 20_000) {
    throw new ApiError("invalid_request", "prompt 不能为空且最多 20000 字符");
  }
  assertReferenceImages(value.reference_images ?? [], value.media === "image" ? 10 : 1);
  return value as unknown as GenerateRequest;
}

function serviceFor(body: GenerateRequest): string {
  const service = body.service ?? (body.media === "video" ? "video_sd2_5s" : "image_sd");
  const allowed = body.media === "image"
    ? ["image_sd", "image_hd"]
    : ["video_sd2_5s", "video_sd2_15s", "video_sd25_5s", "video_sd25_15s", "video_sd25_30s"];
  if (!allowed.includes(service)) {
    throw new ApiError("invalid_request", "service 与生成媒体类型不匹配");
  }
  return service;
}

Deno.serve(async (request) => {
  const id = requestId(request);
  let cors: HeadersInit = {};
  const started = performance.now();
  let holdId: string | undefined;
  let upstreamSubmitted = false;
  let userId: string | undefined;
  let adminClient: SupabaseClient | undefined;
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    assertBodySize(request);

    const { user, admin } = await requireUser(request);
    adminClient = admin;
    userId = user.id;
    const raw = await request.json();

    // Poll route: settle a previously queued remote task without a new hold.
    if (raw && typeof raw === "object" && "remote_task_id" in raw) {
      const remoteTaskId = String((raw as PollRequest).remote_task_id);
      const pending = REMOTE_TASKS.get(remoteTaskId);
      if (!pending) throw new ApiError("invalid_request", "未知的远端任务");
      if (pending.status === "queued") {
        pending.polls += 1;
        // Deterministic Mock completion on the second poll so bounded desktop polling terminates.
        if (pending.polls >= 2) {
          pending.status = "succeeded";
        } else {
          return jsonResponse({ status: "queued", remote_task_id: remoteTaskId }, 202, cors);
        }
      }
      safeLog({ requestId: id, userId, status: "polled", elapsedMs: performance.now() - started });
      // Settlement of the pending_settlement hold is owned by a dedicated server reconciliation
      // path (real Ark adapter); this Mock poll only hands back the produced media.
      return jsonResponse({
        status: "succeeded",
        images: pending.images,
      }, 200, cors);
    }
    const body = raw as GenerateRequest;
    validate(body);
    const service = serviceFor(body);
    const held = await holdCredits(admin, user.id, body.idempotency_key, service);
    holdId = held.holdId;
    await reserveManagedUsage(admin, user.id, holdId, held.estimated);

    const input: GenerateInput = {
      media: body.media,
      prompt: body.prompt,
      referenceImages: body.reference_images ?? [],
      ratio: body.ratio,
      scenario: body.mock_scenario,
    };
    const result = await withTimeout(createArkAdapter().generate(input));
    upstreamSubmitted = result.status === "queued";

    if (result.status === "queued") {
      REMOTE_TASKS.set(result.remoteTaskId, {
        status: "queued",
        polls: 0,
        images: [{ mime: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }],
      });
      await markPendingSettlement(admin, holdId, `remote_task:${result.remoteTaskId}`);
      safeLog({ requestId: id, userId, service, status: "queued", elapsedMs: performance.now() - started });
      return jsonResponse({
        status: "queued",
        remote_task_id: result.remoteTaskId,
        charge: {
          estimated: held.estimated,
          actual: null,
          transaction_id: holdId,
          pricing_version: held.pricingVersion,
        },
        balance: held.balance,
      }, 202, cors);
    }

    upstreamSubmitted = true;
    const confirmed = await confirmCredits(admin, holdId, result.actualCost);
    safeLog({
      requestId: id,
      userId,
      service,
      status: "succeeded",
      elapsedMs: performance.now() - started,
      credits: result.actualCost,
    });
    return jsonResponse({
      status: "succeeded",
      images: result.images,
      charge: {
        estimated: held.estimated,
        actual: result.actualCost,
        transaction_id: confirmed.transactionId,
        pricing_version: held.pricingVersion,
      },
      balance: confirmed.balance,
    }, 200, cors);
  } catch (error) {
    // A synchronous thrown error means no remote task id was accepted. Rollback is safe. If an
    // adapter later exposes "submitted but result unknown", it must return queued before failing.
    if (holdId && adminClient && !upstreamSubmitted) {
      try {
        await rollbackCredits(adminClient, holdId, error instanceof ApiError ? error.code : "internal_error");
      } catch {
        // Settlement reconciliation will catch stale held rows. Never leak the secondary error.
      }
    }
    safeLog({ requestId: id, userId, status: error instanceof ApiError ? error.code : "internal_error", elapsedMs: performance.now() - started });
    return errorResponse(error, id, cors);
  }
});
