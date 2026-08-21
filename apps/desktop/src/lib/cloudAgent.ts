export function cloudAgentStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    uploading: "正在准备输入",
    queued: "已进入队列",
    leased: "Agent 已领取任务",
    running: "Agent 正在规划或执行",
    awaiting_approval: "等待你批准计划",
    awaiting_result_feedback: "等待你验收结果",
    exporting: "正在完成结算",
    cancel_requested: "正在安全取消",
    succeeded: "已完成",
    failed: "执行失败",
    cancelled: "已取消",
  };
  return labels[status] ?? status;
}

export function cloudAgentFailureMessage(message?: string | null): string {
  if (!message) return "Agent 执行失败，未继续调用生图工具。";
  const labels: Record<string, string> = {
    controlled_plan_base_reference_mismatch: "Agent 发现计划中的人物底图与意图分析不一致，已安全停止且未继续生图。请重新发起该任务。",
    controlled_plan_reference_roles_incomplete: "Agent 未能可靠绑定全部参考图职责，已安全停止且未继续生图。请重新发起该任务。",
  };
  if (labels[message]) return labels[message];
  if (/^[a-z0-9_:-]+$/i.test(message)) {
    return "Agent 未能形成可安全执行的计划，已停止且未继续生图。";
  }
  return message;
}
