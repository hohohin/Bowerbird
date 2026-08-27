/**
 * Budget 纯函数账本（v1）—— 依据 AGENT-RUNTIME-PLAN.md §9.1 / §9.2。
 *
 * M0 采用「每动作固定积分」的确定性降级费率（§9.2：上游不可靠 token usage 时的
 * 可审计降级规则）。真实 token-based pricing 是 A0-T1/A0-T5 未确认前置项。
 */

import type { BudgetSnapshot } from "../contracts/run.ts";

/**
 * M0 固定费率（降级规则，§9.2）。A1 起由 service_costs 配置 + Edge 纯函数计算，
 * Worker 上报原始 usage，**不决定最终积分**。
 */
export const M0_FIXED_TARIFF: Readonly<Record<string, number>> = Object.freeze({
  read_input_manifest: 0,
  understand_image: 1,
  generate_image: 5,
  inspect_generated_image: 1,
  write_artifact: 0,
  propose_preference: 0,
  submit_plan_for_approval: 0,
  finish_run: 0,
  // HTML 离线渲染首版 0 积分（HTML-RENDER-PLAN §7.3：计费策略归定价文档；仍写 ledger/技术 usage）。
  render_html: 0,
  // smart-refinement 专用动作
  parse_intent: 0,
  assign_reference_roles: 0,
  score_dimensions: 1,
  refine_once: 5,
});

export function estimateToolCost(toolName: string): number {
  return M0_FIXED_TARIFF[toolName] ?? 0;
}

export function canAfford(budget: BudgetSnapshot, cost: number): boolean {
  return cost <= budget.budgetCredits - budget.spentCredits;
}

/** 不可变累加：返回新快照。actualCredits 仅终态由服务端聚合写入。 */
export function spend(budget: BudgetSnapshot, cost: number): BudgetSnapshot {
  return { ...budget, spentCredits: budget.spentCredits + cost };
}
