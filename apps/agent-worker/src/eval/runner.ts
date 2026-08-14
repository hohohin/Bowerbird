/**
 * Eval Runner —— M0 最小 in-memory Kernel driver。
 *
 * 把 FakeModel + FakeTools + Kernel（PhaseMachine/PolicyEngine/ToolLedger/Budget）串成
 * 一个可观测的 Run，产出 RunTrace 供 eval 断言。
 *
 * 边界：这是进程内、内存态的 eval 编排，**不是** 生产 Worker 运行时——
 * 没有 Supabase poll/claim/heartbeat、没有 checkpoint-to-cloud、没有真实 provider。
 * 那些属于 A2/A3。M0 只验证「契约 + 阶段约束 + 副作用账本 + 预算」的可运行性。
 */

import type {
  ContextBlock,
  ModelBackend,
  ModelTurnResult,
} from "../contracts/model.ts";
import type { BudgetSnapshot, RunStatus } from "../contracts/run.ts";
import type { SkillManifest } from "../contracts/skill.ts";
import type { ToolCall } from "../contracts/tools.ts";
import { isTerminal, nextPhase, validateAction } from "../kernel/phase-machine.ts";
import { evaluatePolicy, lookupTool } from "../kernel/policy-engine.ts";
import { ToolLedger, canonicalJson, computeArgsHash, sha256Hex } from "../kernel/tool-ledger.ts";
import { spend } from "../kernel/budget.ts";
import type { FakeArtifact, FakeTools } from "../fakes/fake-tools.ts";

export type TraceEntry =
  | { kind: "turn"; phase: string; modelResult: ModelTurnResult }
  | { kind: "action_ok"; phase: string; action: string; callId: string; cost: number; reused: boolean; display: string; nextPhase: string }
  | { kind: "approval"; approvalKind: "creative_plan" | "refine_plan"; approved: boolean; planHash: string }
  | { kind: "rejected"; layer: "phase" | "policy" | "tool"; action: string; reason: string; errorClass?: string }
  | { kind: "end"; finalPhase: string; status: RunStatus };

export type RunTrace = {
  runId: string;
  finalPhase: string;
  status: RunStatus;
  entries: TraceEntry[];
  toolCalls: ToolCall[];
  artifacts: FakeArtifact[];
  generateAttempts: number;
  approved: boolean;
  spentCredits: number;
  /** 被拒绝的动作汇总（eval 断言对抗性输入被拦）。 */
  rejections: TraceEntry[];
};

export type RunOptions = {
  manifest: SkillManifest;
  model: ModelBackend;
  tools: FakeTools;
  budget: BudgetSnapshot;
  runId?: string;
  /** 默认 true：审批自动通过（控制面暂停由 A1 实现，M0 用自动批准模拟）。 */
  autoApprove?: boolean;
  maxIterations?: number;
  signal?: { readonly aborted: boolean };
};

export async function runSkill(opts: RunOptions): Promise<RunTrace> {
  const { manifest, model, tools, budget } = opts;
  const runId = opts.runId ?? "run-m0";
  const autoApprove = opts.autoApprove ?? true;
  const maxIterations = opts.maxIterations ?? 32;

  const ledger = new ToolLedger();
  const toolCalls: ToolCall[] = [];
  const artifacts: FakeArtifact[] = [];
  const entries: TraceEntry[] = [];
  const rejections: TraceEntry[] = [];

  let phase = manifest.initialPhase;
  let toolCallCount = 0;
  let generateAttempts = 0;
  let modelTurnCount = 0;
  let currentBudget = budget;
  let approvedPlanHash: string | undefined;
  let logicalSlot = 0;
  let status: RunStatus = "running";

  for (let i = 0; i < maxIterations; i++) {
    if (isTerminal(manifest, phase)) {
      status = phase === "done" ? "succeeded" : "running";
      break;
    }
    const phaseDef = manifest.phases.find((p) => p.name === phase)!;
    const allowedActions = phaseDef.allowedActions
      .map((n) => lookupTool(n))
      .filter((t): t is NonNullable<typeof t> => !!t);

    const context: ContextBlock[] = [
      {
        kind: "phase_brief",
        source: "kernel",
        trust: "system",
        contentHash: sha256Hex(`phase|${phase}`),
        body: { phase, skillId: manifest.id },
      },
      {
        kind: "budget",
        source: "kernel",
        trust: "system",
        contentHash: sha256Hex(`budget|${currentBudget.spentCredits}|${currentBudget.budgetCredits}`),
        body: {
          budgetCredits: currentBudget.budgetCredits,
          spentCredits: currentBudget.spentCredits,
          remaining: currentBudget.budgetCredits - currentBudget.spentCredits,
        },
      },
      ...artifacts.map(
        (a): ContextBlock => ({
          kind: "tool_result",
          source: a.callId,
          trust: "approved",
          contentHash: a.contentHash,
          body: { callId: a.callId, kind: a.kind, summary: a.summary },
        }),
      ),
    ];
    const request = {
      runId,
      phase,
      systemPolicy: "Bowerbird Agent Kernel v0 — phase-constrained.",
      skillInstructions: manifest.description,
      context,
      allowedActions,
      responseSchemaVersion: 1,
    };
    const result = await model.turn(request, opts.signal ?? { aborted: false });
    modelTurnCount++;
    entries.push({ kind: "turn", phase, modelResult: result });

    if (result.kind !== "action") {
      status = result.kind === "refusal" ? "failed" : "running";
      break;
    }

    const action = result.action;
    const args = result.arguments;

    // 1) phase 合法性（模型外第一道门）
    const phaseDecision = validateAction(manifest, phase, action);
    if (!phaseDecision.ok) {
      const rej: TraceEntry = { kind: "rejected", layer: "phase", action, reason: phaseDecision.reason };
      entries.push(rej);
      rejections.push(rej);
      status = "failed";
      break;
    }

    // 2) policy 预算/白名单/审批/次数（模型外第二道门）
    const verdict = evaluatePolicy(
      {
        runId,
        phase,
        manifest,
        toolCallCount,
        generateAttemptCount: generateAttempts,
        modelTurnCount,
        budget: currentBudget,
        ledger,
        nextLogicalSlot: logicalSlot,
        approvedPlanHash,
      },
      action,
      args,
    );

    if (verdict.verdict === "deny") {
      const rej: TraceEntry = {
        kind: "rejected",
        layer: "policy",
        action,
        reason: verdict.reason,
        errorClass: verdict.errorClass,
      };
      entries.push(rej);
      rejections.push(rej);
      status = "failed";
      break;
    }

    if (verdict.verdict === "awaiting_approval") {
      const planHash = sha256Hex(canonicalJson(args));
      const approved = autoApprove;
      entries.push({ kind: "approval", approvalKind: verdict.kind, approved, planHash });
      if (!approved) {
        status = "awaiting_approval";
        break;
      }
      approvedPlanHash = planHash;
      phase = nextPhase(manifest, phase, action);
      logicalSlot = 0;
      continue;
    }

    // verdict === "allow"
    const exec = tools.execute(verdict.callId, action, args);
    if (!exec.ok) {
      const rej: TraceEntry = {
        kind: "rejected",
        layer: "tool",
        action,
        reason: exec.safeCode,
        errorClass: exec.errorClass,
      };
      entries.push(rej);
      rejections.push(rej);
      status = "failed";
      break;
    }

    const callRecord: ToolCall = {
      callId: verdict.callId,
      kind: verdict.tool.kind,
      toolName: action,
      argsHash: verdict.argsHash,
      attempt: 1,
      status: "succeeded",
      startedAt: undefined,
      finishedAt: undefined,
    };
    if (exec.artifact) {
      callRecord.resultHash = exec.artifact.contentHash;
      artifacts.push(exec.artifact);
    }
    ledger.remember(callRecord);
    toolCalls.push(callRecord);
    toolCallCount++;
    logicalSlot++;
    if (verdict.tool.generates) generateAttempts++;
    currentBudget = spend(currentBudget, verdict.cost);

    const next = nextPhase(manifest, phase, action);
    entries.push({
      kind: "action_ok",
      phase,
      action,
      callId: verdict.callId,
      cost: verdict.cost,
      reused: verdict.reused,
      display: exec.display,
      nextPhase: next,
    });
    phase = next;
  }

  if (status === "running" && isTerminal(manifest, phase)) status = "succeeded";

  return {
    runId,
    finalPhase: phase,
    status,
    entries,
    toolCalls,
    artifacts,
    generateAttempts,
    approved: !!approvedPlanHash,
    spentCredits: currentBudget.spentCredits,
    rejections,
  };
}

export { computeArgsHash };
