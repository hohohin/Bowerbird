import type { EntitlementSnapshot, FeaturePolicy } from "../lib/types";

/** 服务端派生的免费权益兜底（未同步/未登录时与 Rust FeaturePolicy::free 对齐）。 */
export const FREE_POLICY: FeaturePolicy = {
  can_use_byo: false,
  can_use_cloud: true,
  max_parallel_jobs: 1,
  understand_daily_limit: 10,
  can_use_priority_queue: false,
  can_hd_export: false,
};

/** 唯一门控事实源：从 entitlement 快照取 policy；缺失时用免费兜底。 */
export function effectivePolicy(entitlement: EntitlementSnapshot | null): FeaturePolicy {
  return entitlement?.policy ?? FREE_POLICY;
}

/** BYO（codex/即梦）可用性：服务端 policy 判定。 */
export function canUseByo(entitlement: EntitlementSnapshot | null): boolean {
  return effectivePolicy(entitlement).can_use_byo;
}

/** 生成 provider 权限：Cloud 与本机 BYO 都只读取服务端派生 policy。 */
export function canUseGenerationProvider(
  entitlement: EntitlementSnapshot | null,
  provider: string | null | undefined,
): boolean {
  const policy = effectivePolicy(entitlement);
  return provider === "bowerbird-cloud" ? policy.can_use_cloud : policy.can_use_byo;
}

/** 理解类默认路由：Pro/Studio 走本机 CLI，免费档只能走 Cloud。 */
export function understandProvider(
  entitlement: EntitlementSnapshot | null,
): "codex" | "bowerbird-cloud" | null {
  const policy = effectivePolicy(entitlement);
  if (policy.can_use_byo) return "codex";
  if (policy.can_use_cloud) return "bowerbird-cloud";
  return null;
}

/** 创作板发送时的并发闸：max_parallel_jobs 决定允许同时运行的生成任务数。 */
export function canStartAnotherJob(
  entitlement: EntitlementSnapshot | null,
  runningCount: number,
): boolean {
  return runningCount < effectivePolicy(entitlement).max_parallel_jobs;
}
