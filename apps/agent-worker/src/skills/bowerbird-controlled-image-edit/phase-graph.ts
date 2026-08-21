export type ControlledImageEditPhase =
  | "analyze_intent_text_only"
  | "compose_plan_with_skill"
  | "awaiting_plan_approval"
  | "execute_approved_plan"
  | "finalize_without_inspection"
  | "awaiting_result_feedback"
  | "diagnose_feedback"
  | "compose_revision_plan"
  | "awaiting_revision_approval"
  | "exporting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ControlledPhaseEvent =
  | "intent_recorded"
  | "plan_proposed"
  | "plan_approved"
  | "plan_rejected"
  | "execution_completed"
  | "finalized_without_inspection"
  | "result_accepted"
  | "feedback_received"
  | "diagnosis_completed"
  | "revision_proposed"
  | "revision_approved"
  | "export_completed"
  | "failed"
  | "cancelled";

const TRANSITIONS: Readonly<Record<ControlledImageEditPhase, Partial<Record<ControlledPhaseEvent, ControlledImageEditPhase>>>> = {
  analyze_intent_text_only: { intent_recorded: "compose_plan_with_skill", failed: "failed", cancelled: "cancelled" },
  compose_plan_with_skill: { plan_proposed: "awaiting_plan_approval", failed: "failed", cancelled: "cancelled" },
  awaiting_plan_approval: { plan_approved: "execute_approved_plan", plan_rejected: "cancelled", cancelled: "cancelled" },
  execute_approved_plan: { execution_completed: "finalize_without_inspection", failed: "failed", cancelled: "cancelled" },
  finalize_without_inspection: { finalized_without_inspection: "awaiting_result_feedback", failed: "failed" },
  awaiting_result_feedback: { result_accepted: "exporting", feedback_received: "diagnose_feedback", cancelled: "cancelled" },
  diagnose_feedback: { diagnosis_completed: "compose_revision_plan", failed: "failed", cancelled: "cancelled" },
  compose_revision_plan: { revision_proposed: "awaiting_revision_approval", failed: "failed", cancelled: "cancelled" },
  awaiting_revision_approval: { revision_approved: "execute_approved_plan", plan_rejected: "cancelled", cancelled: "cancelled" },
  exporting: { export_completed: "succeeded", failed: "failed" },
  succeeded: {},
  failed: {},
  cancelled: {},
};

export function nextControlledPhase(
  phase: ControlledImageEditPhase,
  event: ControlledPhaseEvent,
): ControlledImageEditPhase {
  const next = TRANSITIONS[phase][event];
  if (!next) throw new Error(`controlled_phase_transition_denied:${phase}:${event}`);
  return next;
}

export function canUseVisionInControlledPhase(phase: ControlledImageEditPhase): boolean {
  return phase === "diagnose_feedback";
}
