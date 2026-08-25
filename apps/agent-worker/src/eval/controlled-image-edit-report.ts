export type ControlledEvalRow = {
  id: string;
  category: string;
  mode: "model" | "kernel";
  outcome: string;
  intentCorrect: boolean | null;
  referenceRolesCorrect: boolean | null;
  strategyCorrect: boolean | null;
  overplanned: boolean | null;
  structuredSuccess: boolean;
  toolPrivilegeViolation: boolean;
  steps: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCredits: number;
  evidence?: string;
  failureCode?: string;
};

export type ControlledEvalSummary = {
  cases: number;
  modelCases: number;
  kernelCases: number;
  intentAccuracy: number | null;
  referenceRoleAccuracy: number | null;
  strategyAccuracy: number | null;
  overplanningRate: number | null;
  structuredSuccessRate: number;
  toolPrivilegeViolationRate: number;
  averageSteps: number;
  averageToolCalls: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCredits: number;
  failuresByCode: Record<string, number>;
};

function rate(rows: ControlledEvalRow[], field: "intentCorrect" | "referenceRolesCorrect" | "strategyCorrect"): number | null {
  const scored = rows.map((row) => row[field]).filter((value): value is boolean => value !== null);
  return scored.length ? scored.filter(Boolean).length / scored.length : null;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function summarizeControlledEval(rows: ControlledEvalRow[]): ControlledEvalSummary {
  const overplanning = rows.map((row) => row.overplanned).filter((value): value is boolean => value !== null);
  const failuresByCode: Record<string, number> = {};
  for (const row of rows) {
    if (row.failureCode) failuresByCode[row.failureCode] = (failuresByCode[row.failureCode] ?? 0) + 1;
  }
  return {
    cases: rows.length,
    modelCases: rows.filter((row) => row.mode === "model").length,
    kernelCases: rows.filter((row) => row.mode === "kernel").length,
    intentAccuracy: rate(rows, "intentCorrect"),
    referenceRoleAccuracy: rate(rows, "referenceRolesCorrect"),
    strategyAccuracy: rate(rows, "strategyCorrect"),
    overplanningRate: overplanning.length ? overplanning.filter(Boolean).length / overplanning.length : null,
    structuredSuccessRate: rows.length ? rows.filter((row) => row.structuredSuccess).length / rows.length : 0,
    toolPrivilegeViolationRate: rows.length ? rows.filter((row) => row.toolPrivilegeViolation).length / rows.length : 0,
    averageSteps: average(rows.map((row) => row.steps)),
    averageToolCalls: average(rows.map((row) => row.toolCalls)),
    promptTokens: rows.reduce((sum, row) => sum + row.promptTokens, 0),
    completionTokens: rows.reduce((sum, row) => sum + row.completionTokens, 0),
    estimatedCredits: rows.reduce((sum, row) => sum + row.estimatedCredits, 0),
    failuresByCode,
  };
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function mark(value: boolean | null): string {
  return value === null ? "—" : value ? "✓" : "✗";
}

export function renderControlledEvalMarkdown(
  rows: ControlledEvalRow[],
  generatedAt: string,
  model: string,
): string {
  const summary = summarizeControlledEval(rows);
  const failures = Object.entries(summary.failuresByCode)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => `${code}=${count}`)
    .join("；") || "无";
  const lines = [
    "# Controlled Image Edit Agent 指标报告",
    "",
    `- 生成时间：${generatedAt}`,
    `- 文本模型：${model}`,
    `- 案例：${summary.cases}（模型规划 ${summary.modelCases}，Kernel 专项 ${summary.kernelCases}）`,
    "- 本报告只运行文本规划与确定性 Kernel 探针，不调用 Vision 或图片生成 provider。",
    "",
    "## 汇总",
    "",
    `- 意图判断正确率：${percent(summary.intentAccuracy)}`,
    `- 参考职责正确率：${percent(summary.referenceRoleAccuracy)}`,
    `- 策略正确率：${percent(summary.strategyAccuracy)}`,
    `- 过度规划率：${percent(summary.overplanningRate)}`,
    `- 结构化成功率：${percent(summary.structuredSuccessRate)}`,
    `- 工具越权率：${percent(summary.toolPrivilegeViolationRate)}`,
    `- 平均步骤 / 工具调用：${summary.averageSteps.toFixed(2)} / ${summary.averageToolCalls.toFixed(2)}`,
    `- DeepSeek token：input ${summary.promptTokens} / output ${summary.completionTokens}`,
    `- 预计 Bowerbird 积分：${summary.estimatedCredits}（文本回合按每次至少 1 分；规划图片调用按每次 5 分估算，未实际执行）`,
    `- 失败分类：${failures}`,
    "",
    "## 逐案例",
    "",
    "| ID | 类别 | 模式 | 结果 | 意图 | 职责 | 策略 | 过度规划 | 结构化 | 越权 | 步骤/调用 | token | 预计积分 | 证据 | 失败码 |",
    "|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.id} | ${row.category} | ${row.mode} | ${row.outcome} | ${mark(row.intentCorrect)} | ${mark(row.referenceRolesCorrect)} | ${mark(row.strategyCorrect)} | ${mark(row.overplanned)} | ${mark(row.structuredSuccess)} | ${mark(row.toolPrivilegeViolation)} | ${row.steps}/${row.toolCalls} | ${row.promptTokens + row.completionTokens} | ${row.estimatedCredits} | ${row.evidence ?? "—"} | ${row.failureCode ?? "—"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
