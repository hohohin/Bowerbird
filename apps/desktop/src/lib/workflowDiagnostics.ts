import { WorkflowNodeError, WorkflowInputError, workflowTitle, type WorkflowInput, type WorkflowNode } from "./canvasWorkflow";
export { WorkflowNodeError, WorkflowInputError } from "./canvasWorkflow";

export interface WorkflowDiagnostic {
  id: string;
  code: "INPUT_UNAVAILABLE" | "START_FAILED" | "STEP_FAILED";
  phase: "validation" | "execution";
  nodeId: string;
  nodeLabel: string;
  message: string;
  action: string;
  source?: WorkflowInput;
  referenceLabel?: string;
  runId?: string;
  step?: number;
  timestamp: string;
}

export function workflowDiagnostic(error: unknown, node: WorkflowNode, phase: WorkflowDiagnostic["phase"], runId?: string, step?: number): WorkflowDiagnostic {
  const input = error instanceof WorkflowInputError ? error : undefined;
  const target = error instanceof WorkflowNodeError ? error.node : node;
  return {
    id: crypto.randomUUID(), code: input ? "INPUT_UNAVAILABLE" : phase === "validation" ? "START_FAILED" : "STEP_FAILED",
    phase, nodeId: target.id, nodeLabel: target.kind === "instruction" ? `${workflowTitle(target)} · ${{ layers: "分层编辑", describe: "反推", reuse: "复用生成提示词" }[target.action]}` : workflowTitle(target),
    message: error instanceof Error ? error.message : String(error),
    action: input ? "定位出错卡片，检查标出的输入连接或 @ 引用；确认上游成功输出后，再运行此流程。"
      : phase === "validation" ? "定位卡片并按原因修正配置，再启动流程。"
      : "定位卡片检查失败原因；若涉及生成服务，先确认原任务状态，避免重复提交。可复制诊断信息反馈。",
    ...(input ? { source: input.source, referenceLabel: input.referenceLabel } : {}),
    runId, step, timestamp: new Date().toISOString(),
  };
}

// No prompt bodies, image data or credentials in the support payload.
export function workflowDiagnosticReport(issue: WorkflowDiagnostic) { return JSON.stringify(issue, null, 2); }
