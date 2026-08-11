import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ApiError } from "./errors.ts";

export interface Balance {
  daily: number;
  sub: number;
  topup: number;
}

export interface HoldResult {
  holdId: string;
  estimated: number;
  pricingVersion: number;
  balance: Balance;
}

function dailyFreeCredits(): number {
  const amount = Number.parseInt(
    Deno.env.get("DAILY_FREE_CREDITS") ?? "30",
    10,
  );
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new ApiError("internal_error", "每日积分配置无效", true);
  }
  return amount;
}

function rpcError(error: { message?: string; details?: string; code?: string } | null): never {
  if (error?.details === "insufficient_credits" || error?.message?.includes("insufficient credits")) {
    throw new ApiError("insufficient_credits", "积分不足");
  }
  throw new ApiError("internal_error", "积分服务暂时不可用", true);
}

function balance(row: Record<string, unknown>): Balance {
  return {
    daily: Number(row.daily_balance ?? 0),
    sub: Number(row.sub_balance ?? 0),
    topup: Number(row.topup_balance ?? 0),
  };
}

export async function ensureDailyCredits(
  admin: SupabaseClient,
  userId: string,
): Promise<Balance> {
  const { data, error } = await admin.rpc("ensure_daily_credits", {
    p_user_id: userId,
    p_amount: dailyFreeCredits(),
  });
  if (error) rpcError(error);
  const row = data?.[0] as Record<string, unknown> | undefined;
  if (!row) throw new ApiError("internal_error", "每日积分发放无返回", true);
  return balance(row);
}

export async function holdCredits(
  admin: SupabaseClient,
  userId: string,
  idempotencyKey: string,
  service: string,
): Promise<HoldResult> {
  const { data, error } = await admin.rpc("credit_hold", {
    p_user_id: userId,
    p_idempotency_key: idempotencyKey,
    p_service: service,
    p_estimated_amount: null,
  });
  if (error) rpcError(error);
  const row = data?.[0] as Record<string, unknown> | undefined;
  if (!row) throw new ApiError("internal_error", "积分预授权无返回", true);
  return {
    holdId: String(row.hold_id),
    estimated: Number(row.estimated_amount),
    pricingVersion: Number(row.pricing_version),
    balance: balance(row),
  };
}

export async function confirmCredits(
  admin: SupabaseClient,
  holdId: string,
  actualAmount: number,
): Promise<{ transactionId: string; balance: Balance }> {
  const { data, error } = await admin.rpc("credit_confirm", {
    p_hold_id: holdId,
    p_actual_amount: actualAmount,
  });
  if (error) rpcError(error);
  const row = data?.[0] as Record<string, unknown> | undefined;
  if (!row) throw new ApiError("internal_error", "积分确认无返回", true);
  return { transactionId: holdId, balance: balance(row) };
}

export async function rollbackCredits(
  admin: SupabaseClient,
  holdId: string,
  reason: string,
): Promise<Balance> {
  const { data, error } = await admin.rpc("credit_rollback", {
    p_hold_id: holdId,
    p_reason: reason,
  });
  if (error) rpcError(error);
  const row = data?.[0] as Record<string, unknown> | undefined;
  if (!row) throw new ApiError("internal_error", "积分回滚无返回", true);
  return balance(row);
}

export async function markPendingSettlement(
  admin: SupabaseClient,
  holdId: string,
  reason: string,
): Promise<void> {
  const { error } = await admin.rpc("mark_hold_pending_settlement", {
    p_hold_id: holdId,
    p_reason: reason,
  });
  if (error) rpcError(error);
}
