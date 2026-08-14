/**
 * ToolCall 副作用账本契约（v1）—— 依据 AGENT-RUNTIME-PLAN.md §5.7 / §7.8。
 *
 * 这是 harness 的副作用账本，不能只用日志替代。所有外部副作用工具经
 * prepare → submitted → complete 生命周期；崩溃后按状态决定查询还是重放。
 */

import type { ToolKind } from "./model.ts";

/** 工具调用账本状态。 */
export type ToolCallStatus =
  | "prepared"
  | "submitted"
  | "succeeded"
  | "failed"
  | "outcome_unknown";

/** 错误分类（§7.8），决定重试 / 退款 / 查询对账行为。 */
export type ToolErrorClass =
  | "validation_error"
  | "policy_denied"
  | "transient_before_submit"
  | "outcome_unknown_after_submit"
  | "provider_terminal"
  | "budget_exhausted"
  | "cancelled";

/** 派生稳定 call_id 的输入（§7.8）；模型不直接提供 call_id。 */
export type CallIdComponents = {
  runId: string;
  phase: string;
  /** 当前 phase 内的逻辑槽（同逻辑动作复用同 call_id，返回既有结果）。 */
  logicalSlot: number;
  /** 仅当 Skill 允许 revision 且参数变化时递增。 */
  revisionIndex: number;
};

/** 单条 tool-call 账本记录（对应控制面 agent_tool_calls 行，§5.7）。 */
export type ToolCall = {
  callId: string;
  kind: ToolKind;
  toolName: string;
  /** 规范化参数的 sha256 hex；同 call_id 仅在 hash 一致时复用结果。 */
  argsHash: string;
  attempt: number;
  status: ToolCallStatus;
  /** 供应商请求 id（submitted 后写入），崩溃恢复对账用。 */
  providerRequestId?: string;
  /** 结果对象在私有临时存储的 key（短 TTL）。 */
  resultObjectKey?: string;
  /** 结果正文 sha256；桌面下载后校验。 */
  resultHash?: string;
  startedAt?: string;
  submittedAt?: string;
  finishedAt?: string;
  /** 安全错误码（不回传内部安全细节给模型）。 */
  safeErrorCode?: string;
  errorClass?: ToolErrorClass;
};

/**
 * 工具调用生命周期（§7.8），确定性步骤：
 *   model action
 *     -> schema validate
 *     -> phase/policy/budget check
 *     -> derive stable call_id + args_hash
 *     -> tool_prepare（持久化）
 *     -> execute 或 query existing provider request
 *     -> tool_submitted（如有外部副作用）
 *     -> normalize result + usage + artifact hash
 *     -> tool_complete（持久化）
 *     -> checkpoint
 */
export const TOOL_CALL_LIFECYCLE = [
  "validate",
  "policy_budget_check",
  "derive_call_id_args_hash",
  "prepare",
  "execute_or_query",
  "submitted",
  "normalize",
  "complete",
  "checkpoint",
] as const;
