/**
 * 有限澄清契约（v1）—— 依据 AGENT-RUNTIME-PLAN.md §7.15。
 *
 * Agent loop 只在三个节点接收用户文字：计划前有限澄清、计划审批/修改、结果反馈。
 * 模型只能提交 ClarificationProposal，Kernel 检查必要性/重复/次数/intent 字段影响后
 * 才写入控制面并释放 Worker 租约。用户回答编译为结构化 IntentPatch（不堆进聊天 transcript）。
 */

/**
 * 模型提议的一次澄清。一次只问一个问题、提供推荐答案、能从结构化上下文
 * 确定的内容不询问；每 Run 最多 3 次（manifest.clarifications.maxPerRun）。
 */
export type ClarificationProposal = {
  /** Run 内稳定的 question 标识，用于去重（唯一键 (run_id, question_key)，§5.4）。 */
  questionKey: string;
  /** 该问题所依赖的 intent 上下文快照 hash；回答须匹配仍有效的 context_hash。 */
  contextHash: string;
  question: string;
  recommendedAnswer: string;
  options: string[];
  /** 声明会影响哪些 intent 字段；问题不涉 manifest 声明的字段则 Kernel 拒绝询问。 */
  affectedIntentFields: string[];
  rationale: string;
};

/**
 * 用户回答编译成的结构化补丁。批准后的计划若因新回答变化，原 proposal hash 失效
 * 并重新审批（§7.10）。工具执行期间不接受聊天输入。
 */
export type IntentPatch = {
  sourceQuestionKey: string;
  /** 必须匹配仍生效的 ClarificationProposal.contextHash，否则要求重新提问。 */
  contextHash: string;
  patches: Array<IntentPatchOp>;
};

export type IntentPatchOp =
  | { field: string; op: "set"; value: unknown }
  | { field: string; op: "clear" };
