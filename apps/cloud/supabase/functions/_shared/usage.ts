import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ApiError } from "./errors.ts";

function positiveNumber(name: string, fallback: number): number {
  const value = Number(Deno.env.get(name) ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ApiError("not_configured", `${name} 配置无效`);
  }
  return value;
}

export async function reserveManagedUsage(
  admin: SupabaseClient,
  userId: string,
  holdId: string,
  estimatedCredits: number,
): Promise<void> {
  const dailyLimitCny = positiveNumber("DAILY_COST_LIMIT_CNY", 500);
  const perUserPerMinute = Math.floor(positiveNumber("RATE_LIMIT_PER_USER_PER_MIN", 10));
  const costCnyPerCredit = positiveNumber("COST_CNY_PER_CREDIT", 0.047);
  const mock = (Deno.env.get("BOWERBIRD_CLOUD_MOCK") ?? "true") === "true";
  const costMicros = mock ? 0 : Math.ceil(estimatedCredits * costCnyPerCredit * 1_000_000);
  const dailyLimitMicros = Math.floor(dailyLimitCny * 1_000_000);

  if (!Number.isSafeInteger(costMicros) || !Number.isSafeInteger(dailyLimitMicros) ||
    dailyLimitMicros <= 0 || perUserPerMinute <= 0) {
    throw new ApiError("not_configured", "成本熔断配置超出安全范围");
  }

  const { data, error } = await admin.rpc("reserve_managed_usage", {
    p_user_id: userId,
    p_hold_id: holdId,
    p_cost_micros: costMicros,
    p_daily_cost_limit_micros: dailyLimitMicros,
    p_per_user_per_min: perUserPerMinute,
  });
  if (error?.details === "rate_limit_per_minute") {
    throw new ApiError("rate_limited", "请求过于频繁，请稍后再试", true);
  }
  if (error?.details === "daily_cost_limit") {
    throw new ApiError("cost_limit_reached", "云端今日成本额度已用完，请明日再试", true);
  }
  if (error?.details === "hold_not_active") {
    throw new ApiError("invalid_request", "该生成请求已结算，请发起新任务");
  }
  if (error) throw new ApiError("internal_error", "云端用量校验暂时不可用", true);

  const row = data?.[0] as Record<string, unknown> | undefined;
  if (!row) throw new ApiError("internal_error", "云端用量校验无返回", true);
  if (row.already_reserved === true) {
    throw new ApiError("invalid_request", "该生成请求正在处理或已经处理");
  }
}
