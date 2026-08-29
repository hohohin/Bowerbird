export const CONTROLLED_IMAGE_EDIT_SKILL = "bowerbird-controlled-image-edit";
export const HTML_LAYOUT_RENDER_SKILL = "bowerbird-html-layout-render";

export interface FeaturePolicy {
  can_use_byo: boolean;
  can_use_cloud: boolean;
  max_parallel_jobs: number;
  understand_daily_limit: number | null;
  can_use_priority_queue: boolean;
  can_hd_export: boolean;
  can_use_agent_runs: boolean;
  max_parallel_agent_runs: number;
  allowed_agent_skills: string[];
  agent_budget_options: string[];
  can_use_visual_profiles: boolean;
}

const AGENT_BUDGET_OPTIONS = ["controlled-min", "controlled-standard"];

export function policyFor(tier: string): FeaturePolicy {
  const agent = {
    can_use_agent_runs: true,
    allowed_agent_skills: [CONTROLLED_IMAGE_EDIT_SKILL],
    agent_budget_options: [...AGENT_BUDGET_OPTIONS],
    can_use_visual_profiles: true,
  };
  if (tier === "studio") {
    return {
      can_use_byo: true,
      can_use_cloud: true,
      max_parallel_jobs: 8,
      understand_daily_limit: null,
      can_use_priority_queue: true,
      can_hd_export: false,
      max_parallel_agent_runs: 4,
      ...agent,
    };
  }
  if (tier === "pro") {
    return {
      can_use_byo: true,
      can_use_cloud: true,
      max_parallel_jobs: 4,
      understand_daily_limit: null,
      can_use_priority_queue: false,
      can_hd_export: false,
      max_parallel_agent_runs: 2,
      ...agent,
    };
  }
  return {
    can_use_byo: false,
    can_use_cloud: true,
    max_parallel_jobs: 1,
    understand_daily_limit: 10,
    can_use_priority_queue: false,
    can_hd_export: false,
    max_parallel_agent_runs: 1,
    ...agent,
  };
}

/** A8-T1 小流量门控：AGENT_ACCESS_MODE=test_only 时仅 `raw_app_meta_data.bowerbird_test`
 *  标记的账号可用 Agent（复用 0036 遥测标记通道，不新增名单表）。未配置/其他值 = 全量。 */
export function agentAccessTestOnly(mode?: string): boolean {
  return (mode ?? Deno.env.get("AGENT_ACCESS_MODE") ?? "").trim().toLowerCase() === "test_only";
}

export function accountTestMarker(appMetadata: unknown): boolean {
  return !!appMetadata && typeof appMetadata === "object" && !Array.isArray(appMetadata) &&
    (appMetadata as Record<string, unknown>).bowerbird_test === true;
}

/** 与 policyFor 同源的用户级策略：小名单模式下未标记账号的权益快照隐藏 Agent 能力，
 * 桌面 UI / Rust command / agent-run create 三层随之收敛。
 * HTML 排版 Skill 为 H3 POC：仅对 bowerbird_test 标记账号追加（HTML-RENDER-PLAN H3-T6）。 */
export function policyForUser(
  tier: string,
  user: { app_metadata?: unknown },
  options: { agentTestOnly?: boolean } = {},
): FeaturePolicy {
  const policy = policyFor(tier);
  const restricted = options.agentTestOnly ?? agentAccessTestOnly();
  const testAccount = accountTestMarker(user?.app_metadata);
  const skills = testAccount ? [...policy.allowed_agent_skills, HTML_LAYOUT_RENDER_SKILL] : policy.allowed_agent_skills;
  if (!restricted || testAccount) return { ...policy, allowed_agent_skills: skills };
  return {
    ...policy,
    can_use_agent_runs: false,
    allowed_agent_skills: [],
    agent_budget_options: [],
    // 小名单模式同时收紧视觉设定云端提炼（同为云端付费能力）。
    can_use_visual_profiles: false,
  };
}

export function activeTier(subscription: {
  tier?: string | null;
  status?: string | null;
  current_period_end?: string | null;
} | null | undefined, now = Date.now()): string {
  const active = subscription?.status === "active" &&
    (!subscription.current_period_end || Date.parse(subscription.current_period_end) > now);
  return active ? subscription?.tier ?? "free" : "free";
}
