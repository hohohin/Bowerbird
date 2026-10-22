import type { ArkUnderstandUsage } from "../_shared/ark.ts";
import { ApiError } from "../_shared/errors.ts";

// Retry only the idempotent ledger write, NEVER the supplier inference.
export async function recordDiscoveryUsage(
  admin: any,
  userId: string,
  classificationId: string,
  usage: ArkUnderstandUsage,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { error } = await admin.rpc("record_classification_usage", {
        p_user_id: userId, p_id: classificationId, p_usage: usage,
      });
      if (!error) return;
    } catch {
      // A lost acknowledgement is safe to retry with the same counters.
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
  // Allowlisted metadata only, for manual reconciliation after a DB outage.
  // The durable pending row remains visible and is never counted as zero.
  console.error(JSON.stringify({ event: "classification_usage_persist_failed", classification_id: classificationId, usage }));
  throw new ApiError("internal_error", "补标签用量保存失败，请稍后核对", true);
}
