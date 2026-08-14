/**
 * RunSnapshot 契约（v1）—— 依据 AGENT-RUNTIME-PLAN.md §7.9。
 *
 * 版本化检查点，支持 Worker 升级后的显式 migration 或安全失败。
 * 恢复时不信任 snapshot 自报的积分或权限：重新读控制面状态/租约/取消信号/
 * usage ledger/FeaturePolicy 再决定下一步。
 */

import type { BudgetSnapshot, RunStatus } from "./run.ts";

/** snapshot 当前 schema 版本；migration 钩子据此升级或安全失败。 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** 进行中或已完成 tool call 的账本引用（§7.9）。 */
export type SnapshotToolCallRef = {
  callId: string;
  status: "prepared" | "submitted" | "succeeded" | "failed" | "outcome_unknown";
  providerRequestId?: string;
  argsHash: string;
};

/**
 * RunSnapshot。保存时机（§7.9）：每次 tool prepare、上游 submitted、tool complete、
 * 审批暂停、phase transition 和终态之前。snapshot 先写临时对象、校验 hash 后原子更新指针。
 */
export type RunSnapshot = {
  schemaVersion: number;
  kernelVersion: string;
  skillId: string;
  skillVersion: string;
  modelBackend: string;
  model?: string;

  status: RunStatus;
  phase: string;
  revisionIndex: number;
  modelTurnCount: number;
  toolCallCount: number;
  budget: BudgetSnapshot;

  /** 已完成 / 进行中的 call 引用（恢复时先查 usage/artifact 再决定是否重放）。 */
  toolCalls: SnapshotToolCallRef[];
  /** 已提交上游但结果未知者，恢复时只查询不重放（§7.8）。 */
  pendingOutcomeCallIds: string[];

  approvedPlanHash?: string;
  approvalId?: string;
  contextCapsuleHash?: string;

  /** compaction summary 保留的被采纳事实（带来源 hash）。 */
  compactedFacts: Array<{ fact: string; sourceHash: string }>;
  pendingMessages: string[];
  lastEventSeq: number;
  /** snapshot 自身内容 hash（原子更新指针时校验）。 */
  snapshotHash?: string;
};
