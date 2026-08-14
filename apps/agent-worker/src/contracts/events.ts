/**
 * 稳定事件契约（v1）—— 依据 AGENT-RUNTIME-PLAN.md §7.11。
 *
 * Kernel 只发稳定事件类型，不把模型自由文本当进度协议。
 * 每条事件带 run_id / seq / phase / safe_code / progress / references。
 * 生产事件不含 prompt、图片、签名 URL、原始模型响应。
 */

export type AgentEventType =
  | "run.started"
  | "phase.started"
  | "phase.completed"
  | "model.turn.completed"
  | "tool.prepared"
  | "tool.submitted"
  | "tool.completed"
  | "tool.failed"
  | "approval.requested"
  | "approval.resolved"
  | "clarification.requested"
  | "clarification.resolved"
  | "artifact.created"
  | "budget.exhausted"
  | "run.cancelled"
  | "run.failed"
  | "run.succeeded";

export type AgentEvent = {
  runId: string;
  /** 单调递增；唯一键 (run_id, seq) 保证 Worker 批量上报重放幂等（§5.2）。 */
  seq: number;
  type: AgentEventType;
  phase?: string;
  /** 安全错误码；不含用户内容/密钥。 */
  safeCode?: string;
  progress?: number;
  /** 短期私有对象引用（key / hash），不内联正文。 */
  references?: Array<{ kind: string; key?: string; hash?: string }>;
  createdAt: string;
};

/**
 * 可展示事件正文仅存 UI 必需且可过期的内容（display_payload，§5.2）。
 * M0 只定义其形状占位；A1 落库时按 type 收敛白名单字段。
 */
export type DisplayPayload = Record<string, unknown>;
