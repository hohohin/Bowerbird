const proDenial = "运行工作流卡片需要 Pro。已有结果仍可查看和导出";

export function isWorkflowProDenied(error: unknown): boolean {
  return (error instanceof Error ? error.message : error) === proDenial;
}
