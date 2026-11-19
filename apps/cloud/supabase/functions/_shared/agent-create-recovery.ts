import type { AuthContext } from "./auth.ts";
import { ApiError } from "./errors.ts";

// Lookup only: no hold, reservation, queue transition or provider submission.
export async function recoverAgentCreate(admin: AuthContext["admin"], authUserId: string, body: Record<string, unknown>) {
  const key = body.idempotencyKey;
  if (typeof key !== "string" || key.length < 8 || key.length > 128 || !/^[0-9a-f]{64}$/.test(String(body.inputManifestHash))) {
    throw new ApiError("invalid_request", "原 Agent 请求身份无效");
  }
  const account = await admin.from("billing_accounts").select("id").eq("auth_user_id", authUserId).maybeSingle();
  if (account.error || !account.data) throw new ApiError("internal_error", "账号计费身份读取失败", true);
  const hold = await admin.from("credit_holds").select("id").eq("user_id", account.data.id).eq("idempotency_key", key).maybeSingle();
  if (hold.error) throw new ApiError("internal_error", "原 Agent 请求查询失败", true);
  if (!hold.data) throw new ApiError("invalid_request", "尚未查到原 Agent 请求，请稍后查询；不会重新提交", false, 404);
  const found = await admin.from("agent_runs")
    .select("id,conversation_id,status,skill_id,input_count,input_manifest_hash,request_object_key,image_provider,budget_credits,pricing_version,agent_runtime,visual_profile_id,visual_profile_version,visual_profile_hash")
    .eq("user_id", account.data.id).eq("hold_id", hold.data.id).maybeSingle();
  if (found.error) throw new ApiError("internal_error", "原 Agent 请求查询失败", true);
  if (!found.data) throw new ApiError("invalid_request", "原 Agent 请求尚未登记完成，请稍后查询；不会重新提交", false, 404);
  const row = found.data;
  const visual = body.visualProfile as Record<string, unknown> | undefined;
  if (row.input_manifest_hash !== body.inputManifestHash || row.skill_id !== body.skillId
    || row.input_count !== body.inputCount || row.image_provider !== body.imageProvider
    || row.agent_runtime !== (body.agentRuntime ?? "legacy_kernel")
    || row.visual_profile_id !== (visual?.profileId ?? null) || row.visual_profile_version !== (visual?.version ?? null)
    || row.visual_profile_hash !== (visual?.hash ?? null)) {
    throw new ApiError("invalid_request", "原 Agent 请求参数不一致", false, 409);
  }
  const sign = async (key: string) => {
    const result = await admin.storage.from("agent-temp").createSignedUploadUrl(key);
    if (result.error || !result.data) throw new ApiError("internal_error", "原任务上传地址获取失败", true);
    return result.data;
  };
  const manifest = row.status === "uploading" ? await sign(row.request_object_key) : null;
  const inputUploads = row.status === "uploading" ? await Promise.all(Array.from({ length: row.input_count }, async (_, i) => {
    const ordinal = i + 1, objectKey = `runs/${row.id}/inputs/reference-${ordinal}`;
    const signed = await sign(objectKey);
    return { ordinal, objectKey, uploadUrl: signed.signedUrl };
  })) : [];
  return { runId: row.id, conversationId: row.conversation_id, status: row.status,
    holdId: hold.data.id, uploadUrl: manifest?.signedUrl ?? null, inputUploads,
    budgetCredits: row.budget_credits, pricingVersion: row.pricing_version, agentRuntime: row.agent_runtime, recovered: true };
}
