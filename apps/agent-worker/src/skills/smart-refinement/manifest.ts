/**
 * 智能精修 Skill（M0 eval 目标）—— manifest + phase graph。
 *
 * 比「系列创作导演」更小的可独立评估流程，验证 Kernel 四项能力：
 *   结构化意图(parse_intent) → 参考图职责(assign_reference_roles)
 *   → 分维度评分(score_dimensions) → 必要时精修一次(refine_once，最多 1 次)。
 *
 * 复用同一 Kernel 机制（PhaseMachine/PolicyEngine/ToolLedger/Budget）与审批点
 * （生图前唯一审批点：submit_refine_plan → await_refine_approval）。
 * 真实 Ark adapter 与完整 Skill eval 属于 A3。
 */

import type { SkillManifest } from "../../contracts/skill.ts";

export const SMART_REFINEMENT_MANIFEST: SkillManifest = {
  id: "smart-refinement",
  version: "0.1.0-m0",
  kernelMinVersion: "0.0.1",
  snapshotSchemaVersion: 1,
  title: "智能精修",
  description:
    "对一张已生成/已有图，结合用户结构化意图与参考图职责，按维度评分，必要时精修一次。",
  inputSchema: {
    type: "object",
    properties: {
      targetAssetId: { type: "string", description: "待精修的本 Run 内图" },
      goal: { type: "string", maxLength: 4000 },
      referenceAssetIds: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 8 },
      ratio: { type: "string" },
    },
    required: ["targetAssetId", "goal"],
  },
  artifactSchema: {
    type: "object",
    properties: {
      intent: { type: "object" },
      reference_roles: { type: "array" },
      score: { type: "array" },
      generated_image: { type: "object" },
    },
  },
  phases: [
    {
      name: "parse_intent",
      allowedActions: ["parse_intent"],
      maxTurns: 2,
      transitions: [{ action: "parse_intent", to: "assign_reference_roles" }],
    },
    {
      name: "assign_reference_roles",
      allowedActions: ["assign_reference_roles"],
      maxTurns: 2,
      transitions: [{ action: "assign_reference_roles", to: "score_dimensions" }],
    },
    {
      name: "score_dimensions",
      allowedActions: ["score_dimensions"],
      maxTurns: 2,
      transitions: [{ action: "score_dimensions", to: "decide_refine" }],
    },
    {
      name: "decide_refine",
      allowedActions: ["accept_result", "submit_refine_plan"],
      maxTurns: 2,
      transitions: [
        { action: "accept_result", to: "finalize" },
        { action: "submit_refine_plan", to: "refine" },
      ],
    },
    {
      name: "refine",
      allowedActions: ["refine_once"],
      maxTurns: 2,
      transitions: [{ action: "refine_once", to: "score_revision" }],
      requiresApprovalTo: true,
    },
    {
      name: "score_revision",
      allowedActions: ["inspect_generated_image"],
      maxTurns: 2,
      transitions: [{ action: "inspect_generated_image", to: "finalize" }],
    },
    {
      name: "finalize",
      allowedActions: ["finish_run"],
      maxTurns: 2,
      transitions: [{ action: "finish_run", to: "done" }],
    },
    { name: "done", allowedActions: [], maxTurns: 0, transitions: [] },
  ],
  initialPhase: "parse_intent",
  terminalPhases: ["done"],
  budgetTiers: [{ id: "sr-standard", credits: 12, label: "标准（≤12 分）" }],
  allowedProviders: ["ark"],
  maxRunSeconds: 600,
  maxModelTurns: 12,
  maxToolCalls: 12,
  maxGenerateAttempts: 1,
  clarifications: {
    maxPerRun: 3,
    intentFields: ["subject", "style", "mood", "goal"],
  },
};
