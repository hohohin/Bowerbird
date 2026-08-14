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
