/**
 * Run 状态机与预算快照契约（v1）—— 依据 AGENT-RUNTIME-PLAN.md §6.3 / §9.1。
 *
 * 这些是控制面与 Kernel 共享的状态语义。M0 的 in-memory driver 只持有 RunState
 * 的可观察子集；真正的持久化（Supabase 行）与状态转换 RPC 属于 A1，不在本文件实现。
 */

/** Run 生命周期状态（§6.3）。 */
export type RunStatus =
  | "uploading"
  | "queued"
  | "leased"
  | "running"
  | "awaiting_clarification"
  | "awaiting_approval"
  | "awaiting_result_feedback"
  | "exporting"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled";

/** 终态：不再发生 phase 推进或副作用。 */
export const TERMINAL_STATUSES: ReadonlyArray<RunStatus> = [
  "succeeded",
  "failed",
  "cancelled",
];

/**
 * 预算快照。budgetCredits = 创建时预授权的最大积分（hold 上限）；
 * actualCredits 由服务端在 finish 时按可信 usage 聚合；Kernel 逐工具前查 remaining。
 * actualCredits 在 Run 结束前不可由模型/Worker 自报为权威。
 */
export type BudgetSnapshot = {
  budgetCredits: number;
  holdId?: string;
  pricingVersion?: number;
  /** 已登记 usage 的累计积分（Edge 口径），运行期单调递增。 */
  spentCredits: number;
  /** 实际结算积分，仅终态可信。 */
  actualCredits?: number;
};

export function remainingBudget(b: BudgetSnapshot): number {
  return Math.max(0, b.budgetCredits - b.spentCredits);
}
