/**
 * PhaseMachine 纯函数（v1）—— 依据 AGENT-RUNTIME-PLAN.md §7.3 / §7.5。
 *
 * 纯函数：输入 (manifest, phase, action) → 输出下一 phase 或拒绝。
 * 非法转换直接拒绝；模型不能跳过审批或自行完成结算。
 */

import type { PhaseDef, PhaseTransition, SkillManifest } from "../contracts/skill.ts";

export type PhaseActionDecision =
  | { ok: true; phase: PhaseDef; transition: PhaseTransition }
  | { ok: false; reason: PhaseRejectReason };

export type PhaseRejectReason =
  | "unknown_phase"
  | "action_not_allowed_in_phase"
  | "no_such_transition"
  | "terminal_phase";

export function findPhase(manifest: SkillManifest, phase: string): PhaseDef | undefined {
  return manifest.phases.find((p) => p.name === phase);
}

export function isTerminal(manifest: SkillManifest, phase: string): boolean {
  return manifest.terminalPhases.includes(phase);
}

/**
 * 校验：在当前 phase 下，模型能否用该 action 推进。
 * 三道关：phase 存在 → action 在 phase.allowedActions → 存在对应 transition。
 */
export function validateAction(
  manifest: SkillManifest,
  phase: string,
  action: string,
): PhaseActionDecision {
  if (isTerminal(manifest, phase)) return { ok: false, reason: "terminal_phase" };
  const def = findPhase(manifest, phase);
  if (!def) return { ok: false, reason: "unknown_phase" };
  if (!def.allowedActions.includes(action)) {
    return { ok: false, reason: "action_not_allowed_in_phase" };
  }
  const transition = def.transitions.find((t) => t.action === action);
  if (!transition) return { ok: false, reason: "no_such_transition" };
  return { ok: true, phase: def, transition };
}

/** 应用合法转换，返回下一 phase 名。调用前应先 validateAction。 */
export function nextPhase(
  manifest: SkillManifest,
  phase: string,
  action: string,
): string {
  const decision = validateAction(manifest, phase, action);
  if (!decision.ok) {
    throw new Error(
      `PhaseMachine: illegal transition ${phase} --${action}--> (${decision.reason})`,
    );
  }
  return decision.transition.to;
}
