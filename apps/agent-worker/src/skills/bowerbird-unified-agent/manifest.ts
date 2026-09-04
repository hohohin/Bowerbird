import type { SkillManifest } from "../../contracts/skill.ts";
import { UNIFIED_AGENT_PLANNING_INPUT_SCHEMA } from "./schemas.ts";

export const UNIFIED_AGENT_MANIFEST: SkillManifest = {
  id: "bowerbird-unified-agent",
  version: "0.1.0",
  kernelMinVersion: "0.1.0",
  snapshotSchemaVersion: 1,
  title: "Bowerbird 通用云端 Agent",
  description: "一个受控 Agent 通过父进程 Tool Gateway 规划当前 Run，并执行已批准的受控工具步骤。",
  inputSchema: UNIFIED_AGENT_PLANNING_INPUT_SCHEMA,
  artifactSchema: {
    type: "object",
    properties: { role: { enum: ["plan"] } },
    required: ["role"],
    additionalProperties: false,
  },
  phases: [
    {
      name: "compose_plan",
      allowedActions: ["list_run_assets", "understand_asset", "submit_plan"],
      maxTurns: 12,
      transitions: [{ action: "submit_plan", to: "awaiting_plan_approval" }],
    },
    { name: "awaiting_plan_approval", allowedActions: [], maxTurns: 0, transitions: [] },
    {
      name: "execute_approved_plan",
      allowedActions: ["generate_image", "compose_html", "render_html", "inspect_artifact", "compose_xiaohongshu", "finalize_output"],
      maxTurns: 0,
      requiresApprovalTo: true,
      transitions: [],
    },
    { name: "awaiting_result_feedback", allowedActions: [], maxTurns: 0, transitions: [] },
    { name: "succeeded", allowedActions: [], maxTurns: 0, transitions: [] },
    { name: "failed", allowedActions: [], maxTurns: 0, transitions: [] },
    { name: "cancelled", allowedActions: [], maxTurns: 0, transitions: [] },
  ],
  initialPhase: "compose_plan",
  terminalPhases: ["succeeded", "failed", "cancelled"],
  budgetTiers: [{ id: "unified-agent-test", credits: 30, label: "通用 Agent 本地验证" }],
  allowedProviders: ["deepseek", "ark"],
  maxRunSeconds: 600,
  maxModelTurns: 12,
  maxToolCalls: 16,
  maxGenerateAttempts: 11,
  clarifications: { maxPerRun: 0, intentFields: [] },
};
