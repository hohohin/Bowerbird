import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ApiError } from "../_shared/errors.ts";
import { confirmCredits, markPendingSettlement, rollbackCredits } from "../_shared/billing.ts";

// The synchronous fallback has no worker lease to record submission. Preserve
// the reservation before dispatch so an Edge timeout or lost confirmation
// cannot refund a supplier call that may already have succeeded.
export async function settleSyncUnderstand<T extends { actualCost: number }>(
  admin: SupabaseClient, holdId: string, invoke: () => Promise<T>,
) {
  try {
    await markPendingSettlement(admin, holdId, "sync understand dispatch");
  } catch (error) {
    await rollbackCredits(admin, holdId, "sync dispatch not started");
    throw error;
  }
  let result: T;
  try {
    result = await invoke();
  } catch (error) {
    if (error instanceof ApiError && (error.code === "not_configured" || error.status === 422)) {
      await rollbackCredits(admin, holdId, error.code);
      throw error;
    }
    throw new ApiError("internal_error", "原请求结果待核对，请勿重复提交", false);
  }
  const confirmed = await confirmCredits(admin, holdId, result.actualCost);
  return { result, confirmed };
}
