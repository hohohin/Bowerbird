/**
 * ModelBackend 契约（v1）—— Bowerbird Agent Kernel 的可替换模型后端。
 *
 * 设计依据：AGENT-RUNTIME-PLAN.md §7.4。
 * 核心约束：backend 只能返回当前 phase 允许的动作集合内的「建议」，
 * 不执行工具、不签发 URL、不写 checkpoint、不结算积分。
 * 真正的控制权永远在 Kernel / 控制面（确定性代码）。
 *
 * 本文件为 v1 契约冻结；变更需升 responseSchemaVersion 并经 eval 回归。
 */

/** 供应商原始 usage。**非权威**——最终积分由 Edge Function 按版本化费率重算。 */
export type ProviderUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** 非文本类（图像/调用）计量。 */
  imageCount?: number;
  /** 上游墙钟耗时，用于成本可观测性，不直接换算积分。 */
  upstreamElapsedMs?: number;
  /** 供应商请求 id，落入 tool-call ledger 供崩溃后对账（outcome_unknown 路径）。 */
  providerRequestId?: string;
  /** 原始 usage 透传；日志只记安全摘要，不含此字段。 */
  raw?: Record<string, unknown>;
};

/** 上下文信任级。用户目标 / 图片反推 / 模型产物 / 偏好一律按 untrusted 引用。 */
export type TrustLevel = "system" | "approved" | "untrusted";

/**
 * 每轮 prompt 的一个上下文块。按固定顺序组装（§7.6），后面的用户内容
 * 不能覆盖前面的系统约束。所有块带 provenance + contentHash 以便回链与压缩。
 */
export type ContextBlock = {
  kind:
    | "system_policy"
    | "phase_brief"
    | "skill_instruction"
    | "budget"
    | "approval_result"
    | "user_goal"
    | "input_manifest"
    | "tool_result"
    | "preference_capsule"
    | "visual_profile_capsule"
    | "compaction_summary";
  /** provenance 回链：asset_id / call_id / capsule hash / "kernel" 等。 */
  source: string;
  trust: TrustLevel;
  createdAt?: string;
  /** 规范化内容的 sha256 hex（compaction/审计用）。 */
  contentHash: string;
  /** 结构化正文，schema 依 kind 而定；Kernel 不把它当系统指令。 */
  body: unknown;
};

/** 动作/工具的能力类别。决定 PolicyEngine 的越权判定与 ledger 记录。 */
export type ToolKind = "read_only" | "provider" | "kernel" | "workspace";

/** Skill allowlist 中声明的、当前 phase 允许模型调用的动作。 */
export type ActionDefinition = {
  name: string;
  kind: ToolKind;
  description: string;
  /** 动作参数的 JSON Schema（draft 07）；模型必须据此产出 arguments。 */
  argumentSchema: Record<string, unknown>;
  /** 结果 schema（可选，供 Kernel 校验 normalize 后的工具结果）。 */
  resultSchema?: Record<string, unknown>;
  /** 单 Run 内该动作最大调用次数；超出由 PolicyEngine 拒绝。 */
  maxCallsPerRun?: number;
};

/** 每轮给模型的请求。Kernel 按固定顺序拼好，backend 只读。 */
export type ModelTurnRequest = {
  runId: string;
  phase: string;
  systemPolicy: string;
  skillInstructions: string;
  context: ContextBlock[];
  allowedActions: ActionDefinition[];
  /** 响应协议版本；backend 返回的 action 须据此解释。 */
  responseSchemaVersion: number;
};

/**
 * 模型每回合的产出。首版每回合最多一个 action（Kernel 不执行并行工具，
 * 简化幂等/预算/取消语义，见 §7.2）。
 *  - action：推进 phase 的工具调用建议（须在 allowedActions 内）。
 *  - message：不能推进关键 phase；仅作可展示建议或 clarification。
 *  - refusal：模型主动放弃；Kernel 据此安全失败或重试。
 */
export type ModelTurnResult =
  | { kind: "action"; action: string; arguments: unknown; providerUsage: ProviderUsage }
  | { kind: "message"; text: string; providerUsage: ProviderUsage }
  | { kind: "refusal"; reason: string; providerUsage: ProviderUsage };

/**
 * 模型后端契约。ark / claude(未来 eval 通过后) / fake 三实现共用此契约，
 * 同一 eval runner 可替换 backend。
 *
 * 约束：
 *  - Ark 原生 tool call 与 strict JSON 输出都须归一为 ModelTurnResult.action。
 *  - backend 不执行工具、不签发 URL、不写 checkpoint、不结算积分。
 *  - 供应商原始响应只在短期 snapshot 中按需保留；事件/日志只写安全摘要。
 */
/**
 * 中止信号的结构契约。与 DOM / Node 的 AbortSignal 结构兼容，
 * 但不引入 @types/node 依赖——契约层保持纯 TS。
 * Kernel 取消时把 aborted 置 true；backend 在长上游调用中应检查它。
 */
export type AbortSignalLike = { readonly aborted: boolean };

/**
 * 模型后端契约。文本回合（理解素材、形成计划、选下一动作、评分）由 ModelBackend 承担；
 * 首版用 **DeepSeek**（`deepseek-chat` 支持 tool calling；`deepseek-reasoner` 不支持，禁用）。
 * `ark` 保留（方舟豆包文本模型可选），`claude` 仅未来 eval 通过后追加，`fake` 为 M0 确定性测试。
 *
 * 注意 provider 分工：**ModelBackend 只管文本回合**。工具 `generate_image`（方舟 Seedream）、
 * `understand_image`（方舟豆包 vision）的 provider 在工具实现层，**不在此契约**——且 DeepSeek
 * 不接受 image_url（无视觉），看图必须方舟 vision（见 PROJECT 踩坑「DeepSeek 不兼容 image_url」）。
 *
 * 约束：
 *  - backend 只能返回当前 phase 允许的动作集合内的「建议」，归一为 ModelTurnResult.action。
 *  - backend 不执行工具、不签发 URL、不写 checkpoint、不结算积分。
 *  - 供应商原始响应只在短期 snapshot 中按需保留；事件/日志只写安全摘要。
 */
export interface ModelBackend {
  readonly id: "deepseek" | "ark" | "claude" | "fake";
  turn(request: ModelTurnRequest, signal: AbortSignalLike): Promise<ModelTurnResult>;
}

export const MODEL_RESPONSE_SCHEMA_VERSION = 1;
