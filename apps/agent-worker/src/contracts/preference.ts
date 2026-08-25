/**
 * PreferenceCapsule 契约（v1）—— 依据 AGENT-RUNTIME-PLAN.md §7.7。
 *
 * 个性化是桌面本地生成、可审计的只读胶囊；Worker 不自由积累 conversation memory。
 * 桌面只发送本次相关的少量事实；用户可关闭个性化；胶囊随 Run 临时数据一起过期。
 * Kernel 可输出 preference_candidate artifact，但不能写长期表。
 */

export type PreferenceFactCategory =
  | "style"
  | "subject"
  | "palette"
  | "composition"
  | "medium"
  | "workflow"
  | "avoid";

export type PreferenceFact = {
  category: PreferenceFactCategory;
  value: string;
  confidence: number;
  evidenceCount: number;
  /** 显式（用户确认）vs 隐式（观察推断）。隐式须重复出现或经确认才生效。 */
  explicit: boolean;
};

export type PreferenceCapsule = {
  schemaVersion: 1;
  scope: { projectId?: string };
  preferred: PreferenceFact[];
  avoid: PreferenceFact[];
  workflow: PreferenceFact[];
  generatedAt: string;
  expiresAt: string;
};

/**
 * Agent 输出的偏好候选 artifact（只进本地待确认队列，不自动写长期偏好，§7.7）。
 * 桌面确定性规则负责去重/冲突/衰减/最低证据门槛。
 */
export type PreferenceCandidate = {
  schemaVersion: 1;
  runId: string;
  facts: Array<PreferenceFact & { evidence: string[] }>;
  /** 探索性建议须与「依据既有偏好」区分，避免偏好锁死创意空间。 */
  exploratory: boolean;
};

const CATEGORIES = new Set<PreferenceFactCategory>([
  "style", "subject", "palette", "composition", "medium", "workflow", "avoid",
]);
const MAX_FACTS = 24;
const MAX_VALUE_LENGTH = 240;
const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

/** MVP 只接受桌面明确发送的显式事实；隐式候选仍留在本地待确认队列。 */
export function validatePreferenceCapsule(capsule: PreferenceCapsule): void {
  if (capsule.schemaVersion !== 1) throw new Error("preference_capsule_schema_unsupported");
  const projectId = capsule.scope?.projectId;
  if (projectId !== undefined && (!projectId.trim() || projectId.length > 120)) {
    throw new Error("preference_capsule_scope_invalid");
  }
  const generatedAt = Date.parse(capsule.generatedAt);
  const expiresAt = Date.parse(capsule.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(generatedAt) || !Number.isFinite(expiresAt) || expiresAt <= generatedAt ||
      generatedAt > now + 5 * 60 * 1_000 || expiresAt - generatedAt > MAX_LIFETIME_MS ||
      expiresAt <= now || expiresAt > now + MAX_LIFETIME_MS) {
    throw new Error("preference_capsule_expiry_invalid");
  }
  const groups = [capsule.preferred, capsule.avoid, capsule.workflow];
  if (groups.some((group) => !Array.isArray(group)) || groups.reduce((sum, group) => sum + group.length, 0) > MAX_FACTS) {
    throw new Error("preference_capsule_fact_limit_exceeded");
  }
  const keys = new Set<string>();
  for (const fact of groups.flat()) {
    if (!CATEGORIES.has(fact.category) || !fact.value.trim() || fact.value.length > MAX_VALUE_LENGTH ||
        !Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1 ||
        !Number.isInteger(fact.evidenceCount) || fact.evidenceCount < 1 || !fact.explicit) {
      throw new Error("preference_capsule_fact_invalid");
    }
    const key = `${fact.category}\u0000${fact.value.trim().toLocaleLowerCase()}`;
    if (keys.has(key)) throw new Error("preference_capsule_fact_duplicate");
    keys.add(key);
  }
}
