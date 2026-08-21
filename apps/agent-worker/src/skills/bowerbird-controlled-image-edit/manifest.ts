import type { SkillManifest } from "../../contracts/skill.ts";

export const CONTROLLED_IMAGE_EDIT_MANIFEST: SkillManifest = {
  id: "bowerbird-controlled-image-edit",
  version: "0.1.1",
  kernelMinVersion: "0.1.0",
  snapshotSchemaVersion: 1,
  title: "Bowerbird 受控图片编辑",
  description: "纯文本意图分析与动态受控图片计划；批准后按计划执行，反馈后才允许视觉诊断。",
  inputSchema: {
    type: "object",
    required: ["schemaVersion", "intentPrompt", "references"],
    properties: {
      schemaVersion: { const: 1 },
      intentPrompt: { type: "string", minLength: 1, maxLength: 4_000 },
      references: { type: "array", minItems: 0, maxItems: 8 },
    },
  },
  artifactSchema: {
    type: "object",
    required: ["conversationId", "role", "sha256"],
    properties: {
      role: { enum: ["input", "control_reference", "stage_result", "final_result", "plan", "diagnostic"] },
    },
  },
  phases: [
    {
      name: "analyze_intent_text_only",
      allowedActions: ["record_intent_analysis"],
      maxTurns: 2,
      transitions: [{ action: "record_intent_analysis", to: "compose_plan_with_skill" }],
    },
    {
      name: "compose_plan_with_skill",
      allowedActions: ["submit_plan_for_approval"],
      maxTurns: 2,
      transitions: [{ action: "submit_plan_for_approval", to: "execute_approved_plan" }],
    },
    {
      name: "execute_approved_plan",
      allowedActions: ["generate_image"],
      maxTurns: 0,
      transitions: [{ action: "generate_image", to: "execute_approved_plan" }],
      requiresApprovalTo: true,
    },
    {
      name: "diagnose_feedback",
      allowedActions: ["understand_image"],
      maxTurns: 4,
      transitions: [{ action: "understand_image", to: "compose_revision_plan" }],
      allowsRevision: true,
    },
    {
      name: "compose_revision_plan",
      allowedActions: ["submit_plan_for_approval"],
      maxTurns: 2,
      transitions: [{ action: "submit_plan_for_approval", to: "execute_approved_plan" }],
      allowsRevision: true,
    },
    { name: "done", allowedActions: [], maxTurns: 0, transitions: [] },
    { name: "failed", allowedActions: [], maxTurns: 0, transitions: [] },
    { name: "cancelled", allowedActions: [], maxTurns: 0, transitions: [] },
  ],
  initialPhase: "analyze_intent_text_only",
  terminalPhases: ["done", "failed", "cancelled"],
  budgetTiers: [{ id: "controlled-standard", credits: 48, label: "标准（最多 8 个生成步骤）" }],
  allowedProviders: ["deepseek", "ark"],
  maxRunSeconds: 1_800,
  maxModelTurns: 12,
  maxToolCalls: 16,
  maxGenerateAttempts: 8,
  clarifications: {
    maxPerRun: 3,
    intentFields: ["finalSubjectReferenceId", "mustTransfer", "highConsistencySignals", "strategy", "budget"],
  },
};
