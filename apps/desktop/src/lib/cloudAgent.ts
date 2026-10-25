export function cloudAgentStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    uploading: "正在准备输入",
    queued: "已进入队列",
    leased: "Agent 已领取任务",
    running: "Agent 正在规划或执行",
    awaiting_clarification: "等待你回答一个关键问题",
    awaiting_approval: "等待你批准计划",
    awaiting_local_task: "等待本机生成",
    awaiting_result_feedback: "等待你验收结果",
    exporting: "正在完成结算",
    cancel_requested: "正在安全取消",
    succeeded: "已完成",
    failed: "执行失败",
    cancelled: "已取消",
  };
  return labels[status] ?? "正在确认任务状态";
}

export function cloudAgentFailureMessage(message?: string | null): string {
  if (!message) return "Agent 执行失败，未继续调用生图工具。";
  const labels: Record<string, string> = {
    controlled_plan_base_reference_mismatch: "Agent 发现计划中的人物底图与意图分析不一致，已安全停止且未继续生图。请重新发起该任务。",
    controlled_plan_reference_roles_incomplete: "Agent 未能可靠绑定全部参考图职责，已安全停止且未继续生图。请重新发起该任务。",
    controlled_plan_multi_transfer_requires_staging: "该意图需要从多个参考图迁移不同属性，单次生成无法隔离它们。请重新发起，Agent 会生成分阶段控制计划。",
  };
  if (labels[message]) return labels[message];
  if (/^[a-z0-9_:-]+$/i.test(message)) {
    return "Agent 未能形成可安全执行的计划，已停止且未继续生图。";
  }
  return message;
}

export function cloudAgentStepLabel(step: string): string {
  const labels: Record<string, string> = {
    validate_input: "检查输入",
    analyze_intent: "理解需求",
    compose_plan: "制定计划",
    compose_plan_with_skill: "制定计划",
    awaiting_clarification: "等待补充信息",
    awaiting_plan_approval: "等待确认计划",
    awaiting_revision_approval: "等待确认修改计划",
    execute_approved_plan: "执行计划",
    awaiting_result_feedback: "等待验收结果",
    diagnose_feedback: "分析修改意见",
    compose_revision_plan: "制定修改计划",
    compose_html_document: "设计页面排版",
    render_once: "生成排版结果",
    awaiting_user_review: "等待检查结果",
    exporting: "整理结果",
    succeeded: "任务完成",
    failed: "任务未完成",
    cancelled: "任务已取消",
  };
  return labels[step] ?? "当前任务步骤";
}
