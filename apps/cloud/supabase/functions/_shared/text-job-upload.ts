import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ApiError } from "./errors.ts";
import { managedUsagePolicy } from "./usage.ts";

type Queue = "understand_jobs" | "visual_profile_jobs";
interface Upload {
  id: string;
  status: string;
  input_manifest_hash: string;
  request_object_key: string;
}
const BUCKET = "generation-temp";

export function readableTextResult(job: { result_text: string | null; deleted_at: string | null; content_expires_at: string }, now = Date.now()): string | null {
  return job.deleted_at === null && Date.parse(job.content_expires_at) > now ? job.result_text : null;
}

async function transition<T extends Upload>(admin: SupabaseClient, table: Queue, job: T, enqueue: boolean): Promise<T> {
  const { data, error } = await admin.rpc("transition_text_upload", {
    p_table: table, p_id: job.id, p_hash: job.input_manifest_hash, p_enqueue: enqueue,
  });
  if (error || !data) throw new ApiError("internal_error", "读取上传进度失败，请按原任务恢复", true);
  return data as T;
}

export async function inspectTextUpload<T extends Upload>(admin: SupabaseClient, table: Queue, job: T): Promise<T> {
  return job.status === "uploading" ? await transition(admin, table, job, false) : job;
}

interface Input {
  userId: string;
  key: string;
  payload: string;
  manifestHash: string;
  service: string;
  operation: string | null;
  cards: number | null;
}

function usageParameters() {
  const policy = managedUsagePolicy();
  return { p_unit_cost_micros: policy.unitCostMicros, p_daily_limit: policy.dailyLimitMicros, p_per_minute: policy.perUserPerMinute };
}

function checkAcceptance(error: { details?: string } | null) {
  if (error?.details === "manifest_conflict") throw new ApiError("invalid_request", "幂等键已用于不同内容", false, 409);
  if (error?.details === "insufficient_credits") throw new ApiError("insufficient_credits", "积分不足");
  if (error?.details === "price_unavailable") throw new ApiError("not_configured", "此复刻能力尚未启价，暂不可提交");
  if (error?.details === "rate_limit_per_minute") throw new ApiError("rate_limited", "请求过于频繁，请稍后再试", true);
  if (error?.details === "daily_cost_limit") throw new ApiError("cost_limit_reached", "云端今日成本额度已用完，请明日再试", true);
  if (error?.details === "key_in_use") throw new ApiError("invalid_request", "原请求已经受理，请按原任务恢复", false, 409);
  if (error) throw new ApiError("internal_error", "云端任务受理状态未知，请按原任务恢复", true);
}

export async function beginSyncUnderstand(admin: SupabaseClient, userId: string, key: string) {
  const { data, error } = await admin.rpc("begin_sync_understand", { p_user_id: userId, p_key: key, ...usageParameters() });
  checkAcceptance(error);
  if (!data) throw new ApiError("internal_error", "未收到积分预授权", true);
  return { holdId: String(data.hold_id), estimated: Number(data.estimated_amount), pricingVersion: Number(data.pricing_version) };
}

export async function acceptTextUpload<T extends Upload>(admin: SupabaseClient, table: Queue, input: Input): Promise<T> {
  const { data, error } = await admin.rpc("begin_text_upload", {
    p_table: table, p_user_id: input.userId, p_key: input.key, p_hash: input.manifestHash,
    p_operation: input.operation, p_service: input.service, p_cards: input.cards,
    ...usageParameters(),
  });
  checkAcceptance(error);
  if (!data) throw new ApiError("internal_error", "云端任务受理状态未知，请按原任务恢复", true);
  const job = data as T;
  if (job.status !== "uploading") return job;

  // A replay has the identical manifest bytes. Never overwrite an accepted
  // object. A duplicate means a sibling (or the interrupted caller) stored it.
  const uploaded = await admin.storage.from(BUCKET).upload(job.request_object_key, input.payload, {
    contentType: "application/json", upsert: false,
  });
  if (uploaded.error && await objectPresent(admin, job.request_object_key) !== true) {
    throw new ApiError("internal_error", "输入上传未确认，请使用原任务恢复", true);
  }
  return await transition(admin, table, job, true);
}

// Per-job keys are immutable. Both workers verify the bytes against the
// accepted SHA-256 before submission. A metadata lookup avoids downloading a
// second copy of a potentially large video/audio payload in the Edge runtime.
async function objectPresent(admin: SupabaseClient, key: string): Promise<boolean | null> {
  const slash = key.lastIndexOf("/");
  const name = key.slice(slash + 1);
  const files = await admin.storage.from(BUCKET).list(key.slice(0, slash), { search: name });
  if (files.error || !files.data) return null;
  return files.data.some(file => file.name === name);
}

export async function cleanupTextJobs(admin: SupabaseClient, table: Queue) {
  const expired = await admin.rpc("expire_unsubmitted_text_jobs", { p_table: table });
  if (expired.error) throw new ApiError("internal_error", "过期上传任务结算失败", true);
  const now = new Date().toISOString();
  const rows = await admin.from(table).select("id,request_object_key")
    .lt("content_expires_at", now).or("finished_at.not.is.null,upstream_submitted_at.not.is.null")
    .is("deleted_at", null).order("content_expires_at").order("id").limit(100);
  if (rows.error) throw new ApiError("internal_error", "过期任务查询失败", true);
  const jobs = rows.data ?? [];
  if (!jobs.length) return { expiredJobs: 0, removedObjects: 0 };
  const bucket = admin.storage.from(BUCKET);
  const removed = await bucket.remove(jobs.map(job => job.request_object_key));
  if (removed.error) throw new ApiError("internal_error", "过期输入对象删除失败", true);
  const deleted = new Set((removed.data ?? []).map(object => object.name));
  const cleared: string[] = [];
  for (const job of jobs) {
    if (!deleted.has(job.request_object_key)) {
      // Missing from the delete response can mean a partial delete or a retry
      // after a crash between Storage and SQL. List this job's private folder.
      if (await objectPresent(admin, job.request_object_key) !== false) continue;
    }
    cleared.push(job.id);
  }
  if (cleared.length) {
    const updated = await admin.from(table).update({ deleted_at: now, result_text: null })
      .in("id", cleared).or("finished_at.not.is.null,upstream_submitted_at.not.is.null").is("deleted_at", null);
    if (updated.error) throw new ApiError("internal_error", "过期结果标记失败", true);
  }
  if (cleared.length !== jobs.length) throw new ApiError("internal_error", "部分输入对象尚未删除，将继续清理", true);
  return { expiredJobs: cleared.length, removedObjects: deleted.size };
}
