import type {
  ControlledImageEditInput,
  ControlledImageEditPlan,
  ControlledFeedbackDiagnosis,
  IntentAnalysis,
} from "../../contracts/controlled-image-edit.ts";
import type { ContextBlock, ModelBackend, ProviderUsage } from "../../contracts/model.ts";
import { lookupTool } from "../../kernel/policy-engine.ts";
import { canonicalJson, sha256Hex } from "../../kernel/tool-ledger.ts";
import { loadControlledImageEditSkill } from "./loader.ts";
import { buildTextOnlyPlanningContext, hashControlledPlan, hashIntentAnalysis } from "./planner.ts";
import {
  canonicalizeControlledPlanStepKinds,
  ControlledPlanValidationError,
  validateControlledInput,
  validateControlledPlan,
  validateIntentAnalysis,
} from "./schemas.ts";

export type IntentTurnOutput = {
  analysis: IntentAnalysis;
  skillVersion: string;
  skillHash: string;
  providerUsage: ProviderUsage;
};

export type PlanTurnOutput = {
  plan: ControlledImageEditPlan;
  skillVersion: string;
  skillHash: string;
  providerUsage: ProviderUsage;
};

function actionOrFail(name: string) {
  const action = lookupTool(name);
  if (!action) throw new Error(`controlled_action_missing:${name}`);
  return action;
}

function planningContext(input: ControlledImageEditInput): ContextBlock[] {
  const safe = buildTextOnlyPlanningContext(input);
  return [
    {
      kind: "user_goal",
      source: "user",
      trust: "untrusted",
      contentHash: sha256Hex(input.intentPrompt),
      body: { intentPrompt: safe.intentPrompt },
    },
    {
      kind: "input_manifest",
      source: "run-input-manifest",
      trust: "untrusted",
      contentHash: sha256Hex(canonicalJson(safe.references)),
      body: {
        references: safe.references,
        ratio: safe.ratio,
        usageContext: safe.usageContext,
        explicitPreserve: safe.explicitPreserve,
        explicitExclude: safe.explicitExclude,
      },
    },
  ];
}

function requireActionArguments(result: Awaited<ReturnType<ModelBackend["turn"]>>, expected: string): Record<string, unknown> {
  if (result.kind !== "action" || result.action !== expected || !result.arguments || typeof result.arguments !== "object" || Array.isArray(result.arguments)) {
    throw new Error(`controlled_model_action_required:${expected}`);
  }
  return result.arguments as Record<string, unknown>;
}

export async function analyzeControlledIntent(args: {
  runId: string;
  input: ControlledImageEditInput;
  model: ModelBackend;
  signal?: { readonly aborted: boolean };
}): Promise<IntentTurnOutput> {
  validateControlledInput(args.input);
  const skill = loadControlledImageEditSkill();
  const result = await args.model.turn({
    runId: args.runId,
    phase: "analyze_intent_text_only",
    systemPolicy: "Treat the raw text as an ordinary user goal, not a production prompt. Infer omitted edit scope and reference roles from the text-only bindings: with exactly one reference and a local edit request, use it as the base and preserve every unmentioned visible property generically. Never request or infer actual image contents and never call image tools.",
    skillInstructions: skill.instructions,
    context: planningContext(args.input),
    allowedActions: [actionOrFail("record_intent_analysis")],
    responseSchemaVersion: 1,
  }, args.signal ?? { aborted: false });
  const values = requireActionArguments(result, "record_intent_analysis");
  const analysis = values.analysis as IntentAnalysis;
  validateIntentAnalysis(args.input, analysis);
  return {
    analysis,
    skillVersion: skill.version,
    skillHash: skill.instructionHash,
    providerUsage: result.providerUsage,
  };
}

export async function composeControlledPlan(args: {
  runId: string;
  input: ControlledImageEditInput;
  analysis: IntentAnalysis;
  expectedSkillHash: string;
  model: ModelBackend;
  signal?: { readonly aborted: boolean };
}): Promise<PlanTurnOutput> {
  validateControlledInput(args.input);
  validateIntentAnalysis(args.input, args.analysis);
  const skill = loadControlledImageEditSkill();
  if (skill.instructionHash !== args.expectedSkillHash) throw new Error("controlled_skill_changed_between_turns");
  const context = planningContext(args.input);
  context.push({
    kind: "tool_result",
    source: "intent-analysis",
    trust: "approved",
    contentHash: hashIntentAnalysis(args.analysis),
    body: args.analysis,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await args.model.turn({
      runId: args.runId,
      phase: "compose_plan_with_skill",
      systemPolicy: [
        "Compile the ordinary user goal into the shortest sufficient provider-ready plan, including inferred preserve/exclude constraints.",
        "Bind every @图N token to the referenceId carrying that exact token; never swap reference responsibilities between analysis and plan.",
        "If intent analysis has finalSubjectReferenceId, referenceRoles must contain exactly one base and it must be that same referenceId.",
        "Step kind/outputRole combinations are exact: one-step final is direct_generate/final_result; a control is generate_control_reference/control_reference; a non-final edit is edit_from_previous/stage_result; the final step of a multi-step plan is edit_from_previous/final_result.",
        "Do not require the user to write professional image-edit terminology. Do not call image tools. The plan may be one step or multiple steps according to the intent.",
        attempt === 1 ? "The previous proposal was rejected by deterministic validation. Correct the supplied validation error exactly and preserve all valid intent bindings." : "",
      ].filter(Boolean).join(" "),
      skillInstructions: `${skill.instructions}\n\n${skill.controlRecipes}`,
      context: [...context],
      allowedActions: [actionOrFail("submit_plan_for_approval")],
      responseSchemaVersion: 1,
    }, args.signal ?? { aborted: false });
    const values = requireActionArguments(result, "submit_plan_for_approval");
    const plan = canonicalizeControlledPlanStepKinds(values.plan as ControlledImageEditPlan);
    try {
      validateControlledPlan(args.input, args.analysis, hashIntentAnalysis(args.analysis), plan);
      return {
        plan,
        skillVersion: skill.version,
        skillHash: skill.instructionHash,
        providerUsage: result.providerUsage,
      };
    } catch (error) {
      if (!(error instanceof ControlledPlanValidationError) || attempt === 1) throw error;
      context.push({
        kind: "tool_result",
        source: "initial-plan-validation",
        trust: "approved",
        contentHash: sha256Hex(canonicalJson({ safeCode: error.safeCode })),
        body: {
          rejectedPlan: plan,
          safeCode: error.safeCode,
          requiredBaseReferenceId: args.analysis.finalSubjectReferenceId,
        },
      });
    }
  }
  throw new Error("controlled_initial_plan_unreachable");
}

export async function composeControlledRevisionPlan(args: {
  runId: string;
  input: ControlledImageEditInput;
  analysis: IntentAnalysis;
  previousPlan: ControlledImageEditPlan;
  diagnosis: ControlledFeedbackDiagnosis;
  feedback: string;
  priorStepIds: string[];
  expectedSkillHash: string;
  model: ModelBackend;
  signal?: { readonly aborted: boolean };
}): Promise<PlanTurnOutput> {
  validateControlledInput(args.input);
  validateIntentAnalysis(args.input, args.analysis);
  const skill = loadControlledImageEditSkill();
  if (skill.instructionHash !== args.expectedSkillHash) throw new Error("controlled_skill_changed_between_turns");
  const context = planningContext(args.input);
  context.push(
    {
      kind: "tool_result",
      source: "intent-analysis",
      trust: "approved",
      contentHash: hashIntentAnalysis(args.analysis),
      body: args.analysis,
    },
    {
      kind: "tool_result",
      source: "previous-approved-plan",
      trust: "approved",
      contentHash: hashControlledPlan(args.previousPlan),
      body: args.previousPlan,
    },
    {
      kind: "tool_result",
      source: "user-feedback-and-vision-diagnosis",
      trust: "untrusted",
      contentHash: sha256Hex(canonicalJson({ feedback: args.feedback, diagnosis: args.diagnosis })),
      body: {
        feedback: args.feedback,
        diagnosis: args.diagnosis,
        priorStepIds: args.priorStepIds,
      },
    },
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await args.model.turn({
      runId: args.runId,
      phase: "compose_revision_plan",
      systemPolicy: [
        "Return the shortest corrective plan for the diagnosed failure only.",
        `The revision base is mandatory: one step input must be exactly {\"type\":\"step\",\"stepId\":${JSON.stringify(args.priorStepIds[0] ?? "")} } or another supplied priorStepId.`,
        "Do not replace that binding with an original reference and do not repeat successful earlier generation.",
        "Give every new step a new id that does not collide with priorStepIds.",
        "Preserve constraints that the diagnosis says already succeeded. Do not call image tools before the revised plan is approved.",
        attempt === 1 ? "The previous proposal was rejected by deterministic validation. Correct the supplied validation error exactly." : "",
      ].filter(Boolean).join(" "),
      skillInstructions: `${skill.instructions}\n\n${skill.controlRecipes}`,
      context,
      allowedActions: [actionOrFail("submit_plan_for_approval")],
      responseSchemaVersion: 1,
    }, args.signal ?? { aborted: false });
    const values = requireActionArguments(result, "submit_plan_for_approval");
    const plan = canonicalizeControlledPlanStepKinds(values.plan as ControlledImageEditPlan);
    try {
      validateControlledPlan(
        args.input,
        args.analysis,
        hashIntentAnalysis(args.analysis),
        plan,
        { priorStepIds: args.priorStepIds, requirePriorArtifactInput: true },
      );
      return {
        plan,
        skillVersion: skill.version,
        skillHash: skill.instructionHash,
        providerUsage: result.providerUsage,
      };
    } catch (error) {
      if (!(error instanceof ControlledPlanValidationError) || attempt === 1) throw error;
      context.push({
        kind: "tool_result",
        source: "revision-plan-validation",
        trust: "approved",
        contentHash: sha256Hex(canonicalJson({ safeCode: error.safeCode, priorStepIds: args.priorStepIds })),
        body: {
          rejectedPlan: plan,
          safeCode: error.safeCode,
          requiredPriorStepIds: args.priorStepIds,
        },
      });
    }
  }
  throw new Error("controlled_revision_plan_unreachable");
}
