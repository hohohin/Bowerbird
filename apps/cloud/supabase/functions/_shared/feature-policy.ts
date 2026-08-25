export const CONTROLLED_IMAGE_EDIT_SKILL = "bowerbird-controlled-image-edit";

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
}

const AGENT_BUDGET_OPTIONS = ["controlled-min", "controlled-standard"];

export function policyFor(tier: string): FeaturePolicy {
  const agent = {
    can_use_agent_runs: true,
    allowed_agent_skills: [CONTROLLED_IMAGE_EDIT_SKILL],
    agent_budget_options: [...AGENT_BUDGET_OPTIONS],
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

export function activeTier(subscription: {
  tier?: string | null;
  status?: string | null;
  current_period_end?: string | null;
} | null | undefined, now = Date.now()): string {
  const active = subscription?.status === "active" &&
    (!subscription.current_period_end || Date.parse(subscription.current_period_end) > now);
  return active ? subscription?.tier ?? "free" : "free";
}
