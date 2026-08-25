import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import {
  renderControlledEvalMarkdown,
  summarizeControlledEval,
  type ControlledEvalRow,
} from "./controlled-image-edit-report.ts";

const rows: ControlledEvalRow[] = [
  {
    id: "model-ok",
    category: "model",
    mode: "model",
    outcome: "direct/1",
    intentCorrect: true,
    referenceRolesCorrect: false,
    strategyCorrect: true,
    overplanned: false,
    structuredSuccess: true,
    toolPrivilegeViolation: false,
    steps: 1,
    toolCalls: 1,
    promptTokens: 100,
    completionTokens: 20,
    estimatedCredits: 7,
  },
  {
    id: "kernel-deny",
    category: "kernel",
    mode: "kernel",
    outcome: "policy_denied",
    intentCorrect: null,
    referenceRolesCorrect: null,
    strategyCorrect: null,
    overplanned: null,
    structuredSuccess: false,
    toolPrivilegeViolation: false,
    steps: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimatedCredits: 0,
    failureCode: "expected_denial_missing",
  },
];

test("controlled eval summary uses per-metric denominators and stable failure counts", () => {
  const summary = summarizeControlledEval(rows);
  equal(summary.cases, 2);
  equal(summary.intentAccuracy, 1);
  equal(summary.referenceRoleAccuracy, 0);
  equal(summary.strategyAccuracy, 1);
  equal(summary.overplanningRate, 0);
  equal(summary.structuredSuccessRate, 0.5);
  equal(summary.toolPrivilegeViolationRate, 0);
  equal(summary.averageSteps, 0.5);
  equal(summary.promptTokens, 100);
  equal(summary.completionTokens, 20);
  equal(summary.estimatedCredits, 7);
  deepEqual(summary.failuresByCode, { expected_denial_missing: 1 });
});

test("controlled eval markdown includes aggregate and case evidence", () => {
  const markdown = renderControlledEvalMarkdown(rows, "2026-08-25T00:00:00.000Z", "deepseek-chat");
  ok(markdown.includes("案例：2（模型规划 1，Kernel 专项 1）"));
  ok(markdown.includes("意图判断正确率：100.0%"));
  ok(markdown.includes("expected_denial_missing=1"));
  ok(markdown.includes("| model-ok |"));
});
