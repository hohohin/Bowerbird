import type { SkillManifest } from "../../contracts/skill.ts";
import { UNIFIED_AGENT_PLANNING_INPUT_SCHEMA } from "./schemas.ts";

export const UNIFIED_AGENT_MANIFEST: SkillManifest = {
  id: "bowerbird-unified-agent",
  version: "0.1.0",
  kernelMinVersion: "0.1.0",
  snapshotSchemaVersion: 1,
  title: "Bowerbird 通用云端 Agent",
  description: "一个 Agent 按需读取方法，在授权范围内根据工具结果继续执行；旧 Run 保持原步骤审批。",
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
      allowedActions: ["list_skills", "read_skill", "read_context", "ask_user", "list_run_assets", "understand_asset", "request_task_authorization", "submit_plan"],
      maxTurns: 32,
      transitions: [{ action: "request_task_authorization", to: "awaiting_plan_approval" }, { action: "submit_plan", to: "awaiting_plan_approval" }],
    },
    { name: "awaiting_plan_approval", allowedActions: [], maxTurns: 0, transitions: [] },
    {
      name: "execute_approved_plan",
      allowedActions: ["list_skills", "read_skill", "read_context", "list_run_assets", "call_tool", "generate_image", "compose_html", "render_html", "inspect_artifact", "compose_xiaohongshu", "finalize_output"],
      maxTurns: 128,
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
  // Test bootstrap hold; the server extends it to the priced authorization before execution.
  budgetTiers: [{ id: "unified-agent-test", credits: 30, label: "通用 Agent 测试初始预授权" }],
  allowedProviders: ["deepseek", "ark"],
  maxRunSeconds: 600,
  maxModelTurns: 160,
  maxToolCalls: 64,
  maxGenerateAttempts: 31,
  clarifications: { maxPerRun: 12, intentFields: ["goal"] },
};
