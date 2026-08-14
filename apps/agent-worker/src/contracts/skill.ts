/**
 * SkillManifest 契约（v1）—— 依据 AGENT-RUNTIME-PLAN.md §7.5。
 *
 * Skill 是随 Worker 镜像发布、版本固定的官方内置流程。manifest 只能继续收紧
 * 全局能力，不能打开全局禁用能力（§7.2）。首版每个 Skill 固定 phase graph。
 */

/** 预算档位；用户只能选服务端定义的档位，不接受任意超大整数（§9.1）。 */
export type BudgetTier = {
  id: string;
  credits: number;
  label: string;
};

/** phase 内的单步转换声明：模型产出 action 后，PhaseMachine 据此推进到下一 phase。 */
export type PhaseTransition = {
  /** 触发转换的动作名（须在该 phase 的 allowedActions 内）。 */
  action: string;
  /** 目标 phase。 */
  to: string;
};

/** Skill 的一个阶段定义。 */
export type PhaseDef = {
  name: string;
  /** 该 phase 允许模型调用的动作名（取交集于全局/Run 策略）。 */
  allowedActions: string[];
  /** 本 phase 内最大模型回合数；超出由 StopController 触发。 */
  maxTurns: number;
  /** 合法转换表；不在表内的 action→phase 由 PhaseMachine 拒绝。 */
  transitions: PhaseTransition[];
  /** 进入该 phase 需要用户审批（首版仅「执行生图前」一个业务审批点，§7.10）。 */
  requiresApprovalTo?: boolean;
  /** 是否允许同逻辑槽在参数变化时产生新 call（revision），默认 false。 */
  allowsRevision?: boolean;
};

/** Skill manifest 顶层契约。 */
export type SkillManifest = {
  id: string;
  version: string;
  /** Kernel 最低兼容版本；不满足时安全失败（§7.9）。 */
  kernelMinVersion: string;
  /** RunSnapshot schema 版本，控制 checkpoint 迁移。 */
  snapshotSchemaVersion: number;
  title: string;
  description: string;
  /** 输入（用户目标 + 选中素材 manifest）JSON Schema。 */
  inputSchema: Record<string, unknown>;
  /** 最终产物 JSON Schema（计划 / 评估 / 图引用）。 */
  artifactSchema: Record<string, unknown>;
  phases: PhaseDef[];
  initialPhase: string;
  terminalPhases: string[];
  budgetTiers: BudgetTier[];
  /** 允许的模型 provider；ark 首版，claude 仅未来 eval 通过后追加。 */
  allowedProviders: ReadonlyArray<"ark" | "claude">;
  /** Run 墙钟上限（秒）。 */
  maxRunSeconds: number;
  /** 全 Run 最大模型回合数。 */
  maxModelTurns: number;
  /** 全 Run 最大工具调用数。 */
  maxToolCalls: number;
  /** 生成类动作（generate_image 等）全 Run 最大次数；首版 = 2（首图 + 至多一次重试）。 */
  maxGenerateAttempts: number;
  /** 有限澄清约束（§7.15）。 */
  clarifications: {
    maxPerRun: number;
    /** 声明会影响结果的 intent 字段；问题不涉这些字段则 Kernel 不问。 */
    intentFields: string[];
  };
};
