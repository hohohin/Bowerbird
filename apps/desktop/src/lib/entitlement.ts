import type { EntitlementSnapshot, FeaturePolicy } from "../lib/types";
import { isCloudProvider } from "../lib/genProviders";

/** 服务端派生的免费权益兜底（未同步/未登录时与 Rust FeaturePolicy::free 对齐）。 */
export const FREE_POLICY: FeaturePolicy = {
  can_use_byo: false,
  can_use_cloud: true,
  max_parallel_jobs: 1,
  understand_daily_limit: 10,
  can_use_priority_queue: false,
  can_hd_export: false,
  can_use_agent_runs: true,
  max_parallel_agent_runs: 1,
  allowed_agent_skills: ["bowerbird-controlled-image-edit"],
  agent_budget_options: ["controlled-min", "controlled-standard"],
  can_use_visual_profiles: true,
};

/** 唯一门控事实源：从 entitlement 快照取 policy；缺失时用免费兜底。 */
export function effectivePolicy(entitlement: EntitlementSnapshot | null): FeaturePolicy {
  return entitlement?.policy ? { ...FREE_POLICY, ...entitlement.policy } : FREE_POLICY;
}

/** 正式 Agent 入口只读取服务端下发的 skill allowlist 与并发策略。 */
export function canUseAgentRun(
  entitlement: EntitlementSnapshot | null,
  skillId = "bowerbird-controlled-image-edit",
): boolean {
  const policy = effectivePolicy(entitlement);
  return policy.can_use_agent_runs &&
    policy.max_parallel_agent_runs > 0 &&
    policy.allowed_agent_skills.includes(skillId) &&
    policy.agent_budget_options.length > 0;
}

export function canStartAnotherAgentRun(
  entitlement: EntitlementSnapshot | null,
  runningCount: number,
  skillId = "bowerbird-controlled-image-edit",
): boolean {
  const policy = effectivePolicy(entitlement);
  return canUseAgentRun(entitlement, skillId) && runningCount < policy.max_parallel_agent_runs;
}

/** BYO（codex/即梦）可用性：服务端 policy 判定。 */
export function canUseByo(entitlement: EntitlementSnapshot | null): boolean {
  return effectivePolicy(entitlement).can_use_byo;
}

/** 生成 provider 权限：Cloud（Pro/标准/Lite 变体）与本机 BYO 都只读取服务端派生 policy。 */
export function canUseGenerationProvider(
  entitlement: EntitlementSnapshot | null,
  provider: string | null | undefined,
): boolean {
  const policy = effectivePolicy(entitlement);
  return isCloudProvider(provider) ? policy.can_use_cloud : policy.can_use_byo;
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

/**
 * 理解引擎（反推 / 命名 / 归类）当前是否就绪：按权益路由后判对应引擎健康。
 * Pro/Studio → codex CLI；免费档 → Bowerbird Cloud（需 cloud_available + 已登录）。
 * 供首启总览 / 设置就绪徽章 / 侧栏齿轮红点等「环境是否配齐」判断复用，
 * 不再各处直判 codexHealth（否则免费档登录 Cloud 后仍误报「未就绪」）。
 */
export function understandReady(args: {
  entitlement: EntitlementSnapshot | null;
  codexHealth: { ok: boolean } | null;
  cloudAuth: { cloud_available: boolean; logged_in: boolean } | null;
}): boolean {
  const route = understandProvider(args.entitlement);
  if (route === "codex") return !!args.codexHealth?.ok;
  if (route === "bowerbird-cloud") {
    return !!args.cloudAuth?.cloud_available && !!args.cloudAuth.logged_in;
  }
  return false;
}
