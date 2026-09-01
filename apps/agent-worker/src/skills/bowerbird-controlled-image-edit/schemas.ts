import type {
  ControlledImageEditInput,
  ControlledImageEditPlan,
  ControlledPlanStep,
  ControlledFeedbackDiagnosis,
  ControlledRunArtifact,
  IntentAnalysis,
  ReferenceRole,
} from "../../contracts/controlled-image-edit.ts";
import { validatePreferenceCapsule } from "../../contracts/preference.ts";
import { assertVisualProfileCapsule, visualProfileHashPayload } from "../../contracts/visual-profile.ts";
import { canonicalJson, sha256Hex } from "../../kernel/tool-ledger.ts";

export const MAX_CONTROLLED_REFERENCES = 8;
export const MAX_CONTROLLED_PLAN_STEPS = 8;
export const MAX_INTENT_PROMPT_LENGTH = 4_000;
const CONTROLLED_RATIOS = new Set(["1:1", "3:4", "4:3", "2:3", "3:2", "16:9", "9:16"]);
const CONTROLLED_REFERENCE_ROLES = new Set<ReferenceRole>([
  "base",
  "pose",
  "identity",
  "product",
  "garment",
  "accessory",
  "composition",
  "style",
  "other",
]);

export class ControlledPlanValidationError extends Error {
  readonly safeCode: string;

  constructor(safeCode: string) {
    super(safeCode);
    this.safeCode = safeCode;
  }
}

function requireText(value: unknown, safeCode: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new ControlledPlanValidationError(safeCode);
}

function assertUnique(values: string[], safeCode: string): void {
  if (new Set(values).size !== values.length) throw new ControlledPlanValidationError(safeCode);
}

export function validateControlledInput(input: ControlledImageEditInput): void {
  if (input.schemaVersion !== 1) throw new ControlledPlanValidationError("controlled_input_schema_unsupported");
  requireText(input.intentPrompt, "controlled_intent_prompt_required");
  if (input.intentPrompt.length > MAX_INTENT_PROMPT_LENGTH) {
    throw new ControlledPlanValidationError("controlled_intent_prompt_too_long");
  }
  if (input.references.length > MAX_CONTROLLED_REFERENCES) {
    throw new ControlledPlanValidationError("controlled_reference_limit_exceeded");
  }
  assertUnique(input.references.map((reference) => reference.referenceId), "controlled_reference_id_duplicate");
  assertUnique(input.references.map((reference) => reference.token), "controlled_reference_token_duplicate");
  assertUnique(input.references.map((reference) => String(reference.ordinal)), "controlled_reference_ordinal_duplicate");
  for (const reference of input.references) {
    requireText(reference.referenceId, "controlled_reference_id_required");
    requireText(reference.token, "controlled_reference_token_required");
    if (!Number.isInteger(reference.ordinal) || reference.ordinal < 1) {
      throw new ControlledPlanValidationError("controlled_reference_ordinal_invalid");
    }
    if (!reference.mime.startsWith("image/")) throw new ControlledPlanValidationError("controlled_reference_mime_invalid");
    if (!Number.isInteger(reference.bytes) || reference.bytes <= 0) {
      throw new ControlledPlanValidationError("controlled_reference_size_invalid");
    }
    if (!/^[0-9a-f]{64}$/.test(reference.sha256)) {
      throw new ControlledPlanValidationError("controlled_reference_hash_invalid");
    }
    if (reference.aspectRatio && !CONTROLLED_RATIOS.has(reference.aspectRatio)) {
      throw new ControlledPlanValidationError("controlled_reference_ratio_invalid");
    }
  }
  if (input.ratio && !CONTROLLED_RATIOS.has(input.ratio)) {
    throw new ControlledPlanValidationError("controlled_output_ratio_invalid");
  }
  if (input.preferenceCapsule) {
    try {
      validatePreferenceCapsule(input.preferenceCapsule);
    } catch {
      throw new ControlledPlanValidationError("controlled_preference_capsule_invalid");
    }
  }
  if (input.visualProfileCapsule) {
    try {
      assertVisualProfileCapsule(input.visualProfileCapsule);
      if (sha256Hex(canonicalJson(visualProfileHashPayload(input.visualProfileCapsule))) !== input.visualProfileCapsule.hash) {
        throw new Error("hash_mismatch");
      }
    } catch {
      throw new ControlledPlanValidationError("controlled_visual_profile_capsule_invalid");
    }
  }
}

export function validateIntentAnalysis(input: ControlledImageEditInput, analysis: IntentAnalysis): void {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    throw new ControlledPlanValidationError("controlled_analysis_shape_invalid");
  }
  if (analysis.schemaVersion !== 1) throw new ControlledPlanValidationError("controlled_analysis_schema_unsupported");
  requireText(analysis.intentSummary, "controlled_intent_summary_required");
  const textLists = [
    analysis.mustPreserve,
    analysis.mustExclude,
    analysis.mayChange,
    analysis.highConsistencySignals,
    analysis.assumptions,
  ];
  if (textLists.some((items) => !Array.isArray(items) || items.some((item) => typeof item !== "string" || !item.trim())) ||
      !Array.isArray(analysis.mustTransfer)) {
    throw new ControlledPlanValidationError("controlled_analysis_shape_invalid");
  }
  if (analysis.finalSubjectReferenceId !== undefined &&
      (typeof analysis.finalSubjectReferenceId !== "string" || !analysis.finalSubjectReferenceId.trim())) {
    throw new ControlledPlanValidationError("controlled_analysis_shape_invalid");
  }
  const referenceIds = new Set(input.references.map((reference) => reference.referenceId));
  if (analysis.finalSubjectReferenceId && !referenceIds.has(analysis.finalSubjectReferenceId)) {
    throw new ControlledPlanValidationError("controlled_analysis_unknown_subject_reference");
  }
  for (const transfer of analysis.mustTransfer) {
    if (!transfer || typeof transfer !== "object" || typeof transfer.fromReferenceId !== "string" ||
        !Array.isArray(transfer.attributes)) {
      throw new ControlledPlanValidationError("controlled_analysis_shape_invalid");
    }
    if (!referenceIds.has(transfer.fromReferenceId)) {
      throw new ControlledPlanValidationError("controlled_analysis_unknown_transfer_reference");
    }
    if (transfer.attributes.length === 0 ||
        transfer.attributes.some((attribute) => typeof attribute !== "string" || !attribute.trim())) {
      throw new ControlledPlanValidationError("controlled_analysis_transfer_attributes_required");
    }
  }
  assertUnique(analysis.highConsistencySignals, "controlled_analysis_signal_duplicate");
}

function validateStepUsage(step: ControlledPlanStep): void {
  if (step.estimatedUsage.generateCalls !== 1 || step.estimatedUsage.understandCalls !== 0) {
    throw new ControlledPlanValidationError("controlled_plan_initial_usage_invalid");
  }
}

/**
 * `kind` is execution metadata derived from the plan shape and output role. Keep
 * the model responsible for semantic choices (inputs, order and constraints),
 * while preventing a redundant enum pairing from rejecting an otherwise safe
 * plan.
 */
export function canonicalizeControlledPlanStepKinds(
  plan: ControlledImageEditPlan,
): ControlledImageEditPlan {
  const hasMultipleSteps = plan.steps.length > 1;
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      kind: step.outputRole === "control_reference"
        ? "generate_control_reference"
        : step.outputRole === "stage_result" || hasMultipleSteps
          ? "edit_from_previous"
          : "direct_generate",
    })),
  };
}

export function validateControlledPlan(
  input: ControlledImageEditInput,
  analysis: IntentAnalysis,
  expectedAnalysisHash: string,
  plan: ControlledImageEditPlan,
  options: { priorStepIds?: readonly string[]; requirePriorArtifactInput?: boolean } = {},
): void {
  validateControlledInput(input);
  validateIntentAnalysis(input, analysis);
  if (plan.schemaVersion !== 1) throw new ControlledPlanValidationError("controlled_plan_schema_unsupported");
  if (plan.intentAnalysisHash !== expectedAnalysisHash) {
    throw new ControlledPlanValidationError("controlled_plan_analysis_hash_mismatch");
  }
  requireText(plan.intentSummary, "controlled_plan_summary_required");
  if (plan.steps.length < 1 || plan.steps.length > MAX_CONTROLLED_PLAN_STEPS) {
    throw new ControlledPlanValidationError("controlled_plan_step_count_invalid");
  }
  if (plan.strategy === "direct" && plan.steps.length !== 1) {
    throw new ControlledPlanValidationError("controlled_plan_direct_must_be_single_step");
  }
  if (plan.strategy === "staged_controlled" && plan.steps.length < 2) {
    throw new ControlledPlanValidationError("controlled_plan_staged_requires_multiple_steps");
  }
  // 多来源属性迁移（换装+配饰等多参考串扰类意图）不允许单步直发：一次生成无法隔离
  // 各参考的属性来源，会退化为「多图一次性直发」的已知失败模式。基准方法要求先生成
  // 职责单一的控制参考再分阶段编辑；确定性拒绝驱动模型重规划（与 base 绑定错误同通道）。
  const transferSources = new Set(analysis.mustTransfer.map((transfer) => transfer.fromReferenceId));
  if (transferSources.size >= 2 && plan.steps.length === 1 && plan.steps[0].kind === "direct_generate") {
    throw new ControlledPlanValidationError("controlled_plan_multi_transfer_requires_staging");
  }

  const referenceIds = new Set(input.references.map((reference) => reference.referenceId));
  const roleIds = plan.referenceRoles.map((role) => role.referenceId);
  assertUnique(roleIds, "controlled_plan_reference_role_duplicate");
  if (roleIds.length !== input.references.length || roleIds.some((id) => !referenceIds.has(id))) {
    throw new ControlledPlanValidationError("controlled_plan_reference_roles_incomplete");
  }
  if (plan.referenceRoles.some((role) => !CONTROLLED_REFERENCE_ROLES.has(role.role))) {
    throw new ControlledPlanValidationError("controlled_plan_reference_role_invalid");
  }
  const bases = plan.referenceRoles.filter((role) => role.role === "base");
  if (bases.length > 1) throw new ControlledPlanValidationError("controlled_plan_multiple_base_references");
  if (analysis.finalSubjectReferenceId && bases[0]?.referenceId !== analysis.finalSubjectReferenceId) {
    throw new ControlledPlanValidationError("controlled_plan_base_reference_mismatch");
  }

  assertUnique(plan.steps.map((step) => step.id), "controlled_plan_step_id_duplicate");
  const priorStepIds = new Set(options.priorStepIds ?? []);
  const seenSteps = new Set<string>();
  let priorArtifactInputCount = 0;
  let finalCount = 0;
  for (let index = 0; index < plan.steps.length; index++) {
    const step = plan.steps[index];
    requireText(step.id, "controlled_plan_step_id_required");
    requireText(step.goal, "controlled_plan_step_goal_required");
    requireText(step.rationale, "controlled_plan_step_rationale_required");
    if (priorStepIds.has(step.id)) {
      throw new ControlledPlanValidationError("controlled_revision_step_id_conflicts_with_history");
    }
    validateStepUsage(step);
    for (const binding of step.inputs) {
      if (binding.type === "reference" && !referenceIds.has(binding.referenceId)) {
        throw new ControlledPlanValidationError("controlled_plan_unknown_reference_input");
      }
      if (binding.type === "step" && !seenSteps.has(binding.stepId) && !priorStepIds.has(binding.stepId)) {
        throw new ControlledPlanValidationError("controlled_plan_step_dependency_not_earlier");
      }
      if (binding.type === "step" && priorStepIds.has(binding.stepId)) priorArtifactInputCount++;
    }
    if (step.kind === "generate_control_reference" && step.outputRole !== "control_reference") {
      throw new ControlledPlanValidationError("controlled_plan_control_output_role_invalid");
    }
    if (step.kind === "direct_generate" && step.outputRole !== "final_result") {
      throw new ControlledPlanValidationError("controlled_plan_direct_output_role_invalid");
    }
    if (plan.strategy === "staged_controlled" && step.kind === "edit_from_previous") {
      const previousEdit = [...plan.steps.slice(0, index)]
        .reverse()
        .find((candidate) => candidate.outputRole === "stage_result");
      if (previousEdit && !step.inputs.some((binding) => binding.type === "step" && binding.stepId === previousEdit.id)) {
        throw new ControlledPlanValidationError("controlled_plan_previous_stage_required");
      }
    }
    if (step.outputRole === "final_result") {
      finalCount++;
      if (index !== plan.steps.length - 1) {
        throw new ControlledPlanValidationError("controlled_plan_final_must_be_last");
      }
    }
    seenSteps.add(step.id);
  }
  if (finalCount !== 1) throw new ControlledPlanValidationError("controlled_plan_requires_one_final");
  if (options.requirePriorArtifactInput && priorArtifactInputCount === 0) {
    throw new ControlledPlanValidationError("controlled_revision_requires_previous_result");
  }
}

export function validateControlledFeedbackDiagnosis(
  plan: ControlledImageEditPlan,
  availableArtifacts: ControlledRunArtifact[],
  diagnosis: ControlledFeedbackDiagnosis,
): void {
  if (diagnosis.schemaVersion !== 1) {
    throw new ControlledPlanValidationError("controlled_diagnosis_schema_unsupported");
  }
  requireText(diagnosis.summary, "controlled_diagnosis_summary_required");
  requireText(diagnosis.earliestFailedStepId, "controlled_diagnosis_step_required");
  requireText(diagnosis.revisionDirective, "controlled_diagnosis_directive_required");
  if (!plan.steps.some((step) => step.id === diagnosis.earliestFailedStepId) &&
      !availableArtifacts.some((artifact) => artifact.role !== "input" && artifact.stepId === diagnosis.earliestFailedStepId)) {
    throw new ControlledPlanValidationError("controlled_diagnosis_unknown_step");
  }
  if (diagnosis.failedConstraints.length === 0 || diagnosis.failedConstraints.some((item) => !item.trim())) {
    throw new ControlledPlanValidationError("controlled_diagnosis_failed_constraints_required");
  }
  if (diagnosis.preservedConstraints.some((item) => !item.trim())) {
    throw new ControlledPlanValidationError("controlled_diagnosis_preserved_constraints_invalid");
  }
  assertUnique(diagnosis.inspectedArtifactIds, "controlled_diagnosis_artifact_duplicate");
  const artifactIds = new Set(availableArtifacts.map((artifact) => artifact.artifactId));
  if (diagnosis.inspectedArtifactIds.length === 0 || diagnosis.inspectedArtifactIds.some((id) => !artifactIds.has(id))) {
    throw new ControlledPlanValidationError("controlled_diagnosis_artifact_unknown");
  }
}
