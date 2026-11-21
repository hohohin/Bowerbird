import { hasComfyEntitlement } from "./comfyVideo";
import { H3_IMAGE } from "./genProviders";
import type { AuthSnapshot, EntitlementSnapshot, FeaturePolicy, GenJob } from "../lib/types";
import { isCloudProvider, normalizeGenerationProvider } from "../lib/genProviders";

/** 账号界面只展示当前身份有效快照中的余额和订阅。 */
export function accountEntitlement(snapshot: EntitlementSnapshot | null, userId?: string | null) {
  return userId && snapshot?.user_id === userId && snapshot.offline_state !== "expired" && snapshot.offline_state !== "invalid"
    ? snapshot : null;
}

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
  if (provider === H3_IMAGE) return hasComfyEntitlement(entitlement);
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

/** 即梦自有订阅由供应商控制并发。其在途任务不占其他生成渠道的名额。 */
export function countLimitedGenerationJobs(jobs: Record<string, GenJob>): number {
  return Object.values(jobs).filter(job => job.running && normalizeGenerationProvider(job.provider) !== "jimeng").length;
}

export function canStartAnotherJob(
  entitlement: EntitlementSnapshot | null,
  runningCount: number,
  provider: string,
): boolean {
  const policy = effectivePolicy(entitlement);
  if (normalizeGenerationProvider(provider) === "jimeng") return policy.can_use_byo;
  return runningCount < policy.max_parallel_jobs;
}

type UnderstandAccess = {
  cloudEntitlement: EntitlementSnapshot | null;
  codexHealth: { ok: boolean } | null;
  cloudAuth: Pick<AuthSnapshot, "cloud_available" | "logged_in" | "user_id"> | null;
};

export function understandEngineUsable({ cloudAuth, cloudEntitlement, codexHealth }: UnderstandAccess,
  provider: "bowerbird-cloud" | "codex",
): boolean {
  const current = accountEntitlement(cloudEntitlement, cloudAuth?.logged_in ? cloudAuth.user_id : null);
  if (!current) return false;
  const policy = effectivePolicy(current);
  if (provider === "codex") return policy.can_use_byo && codexHealth?.ok === true;
  const { daily, sub, topup } = current.balances;
  return cloudAuth?.cloud_available === true && policy.can_use_cloud && daily + sub + topup > 0;
}

/** 就绪提示接受任意一个可用的反推引擎。 */
export function understandReady(access: UnderstandAccess): boolean {
  return understandEngineUsable(access, "codex") || understandEngineUsable(access, "bowerbird-cloud");
}
