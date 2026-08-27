/**
 * PolicyEngine 纯函数（v1）—— 依据 AGENT-RUNTIME-PLAN.md §7.2 / §7.8 / §7.12。
 *
 * 这是「能力安全，而非提示词安全」的确定性门控：模型没有 shell/HTTP/文件路径/数据库
 * 能力，prompt injection 即使成功也找不到可越权执行的工具。最终权限取交集：
 *   GlobalKernelPolicy ∩ SkillPolicy ∩ RunStatePolicy ∩ FeaturePolicy
 *
 * PolicyEngine 只做 allow/deny 决策；不执行工具、不签发 URL、不结算。
 * 模型发出的非法动作（shell、改预算、跨 Run 读、跳过审批、超额生图）在此被拒绝。
 */

import type { ActionDefinition, ToolKind } from "../contracts/model.ts";
import type { ToolErrorClass } from "../contracts/tools.ts";
import type { BudgetSnapshot } from "../contracts/run.ts";
import type { SkillManifest } from "../contracts/skill.ts";
import { RENDER_HTML_INPUT_SCHEMA } from "../contracts/render-html.ts";
import { canAfford, estimateToolCost } from "./budget.ts";
import { computeArgsHash, deriveCallId, type ToolLedger } from "./tool-ledger.ts";

/** 全局工具白名单（§7.12）。不在此表的动作，任何 Skill 都不能调用。 */
export type ToolSpec = ActionDefinition & {
  /** 该工具是否触发生成（计入 maxGenerateAttempts、需审批前置）。 */
  generates?: boolean;
};

const COMMON = {
  assetId: { type: "string", description: "本 Run manifest 内的 asset id" },
} as const;

const NON_EMPTY_STRING = { type: "string", minLength: 1 } as const;
const STRING_ARRAY = { type: "array", items: NON_EMPTY_STRING } as const;
const HIGH_CONSISTENCY_SIGNAL = {
  type: "string",
  enum: ["identity", "product", "pose", "garment", "accessory", "composition", "text_layout"],
} as const;
const REFERENCE_ROLE = {
  type: "string",
  enum: ["base", "pose", "identity", "product", "garment", "accessory", "composition", "other"],
} as const;
const CLARIFICATION_PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    questionKey: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,120}$" },
    contextHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    question: { type: "string", minLength: 1, maxLength: 500 },
    recommendedAnswer: { type: "string", minLength: 1, maxLength: 240 },
    options: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 1, maxLength: 240 } },
    optionPatches: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          answer: { type: "string", minLength: 1, maxLength: 240 },
          patches: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                op: { type: "string", enum: ["set", "clear"] },
                value: {},
              },
              required: ["field", "op"],
              additionalProperties: false,
            },
          },
        },
        required: ["answer", "patches"],
        additionalProperties: false,
      },
    },
    affectedIntentFields: { type: "array", minItems: 1, items: { type: "string" } },
    rationale: { type: "string", minLength: 1, maxLength: 1_000 },
  },
  required: [
    "questionKey", "contextHash", "question", "recommendedAnswer", "options", "optionPatches",
    "affectedIntentFields", "rationale",
  ],
  additionalProperties: false,
} as const;

const INTENT_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    intentSummary: NON_EMPTY_STRING,
    finalSubjectReferenceId: NON_EMPTY_STRING,
    mustPreserve: STRING_ARRAY,
    mustTransfer: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fromReferenceId: NON_EMPTY_STRING,
          attributes: { type: "array", minItems: 1, items: NON_EMPTY_STRING },
        },
        required: ["fromReferenceId", "attributes"],
        additionalProperties: false,
      },
    },
    mustExclude: STRING_ARRAY,
    mayChange: STRING_ARRAY,
    highConsistencySignals: { type: "array", items: HIGH_CONSISTENCY_SIGNAL },
    assumptions: STRING_ARRAY,
  },
  required: [
    "schemaVersion", "intentSummary", "mustPreserve", "mustTransfer", "mustExclude",
    "mayChange", "highConsistencySignals", "assumptions",
  ],
  additionalProperties: false,
} as const;

const CONTROLLED_PLAN_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    intentAnalysisHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    intentSummary: NON_EMPTY_STRING,
    strategy: { type: "string", enum: ["direct", "controlled", "staged_controlled"] },
    referenceRoles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          referenceId: NON_EMPTY_STRING,
          role: REFERENCE_ROLE,
          mustPreserve: STRING_ARRAY,
          mustTransfer: STRING_ARRAY,
          mustExclude: STRING_ARRAY,
        },
        required: ["referenceId", "role", "mustPreserve", "mustTransfer", "mustExclude"],
        additionalProperties: false,
      },
    },
    assumptions: STRING_ARRAY,
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          id: NON_EMPTY_STRING,
          kind: {
            type: "string",
            enum: ["direct_generate", "generate_control_reference", "edit_from_previous"],
            description: "Execution type. Use direct_generate only for a one-step final_result; generate_control_reference only for control_reference; edit_from_previous for stage_result or the final step of a multi-step plan.",
          },
          goal: NON_EMPTY_STRING,
          inputs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["reference", "step"] },
                referenceId: NON_EMPTY_STRING,
                stepId: NON_EMPTY_STRING,
              },
              required: ["type"],
              additionalProperties: false,
            },
          },
          modifies: STRING_ARRAY,
          preserves: STRING_ARRAY,
          excludes: STRING_ARRAY,
          outputRole: {
            type: "string",
            enum: ["control_reference", "stage_result", "final_result"],
            description: "Use control_reference for an intermediate isolated control, stage_result for a non-final edit, and final_result exactly once on the last step.",
          },
          rationale: NON_EMPTY_STRING,
          estimatedUsage: {
            type: "object",
            properties: {
              generateCalls: { type: "integer", enum: [1] },
              understandCalls: { type: "integer", enum: [0] },
            },
            required: ["generateCalls", "understandCalls"],
            additionalProperties: false,
          },
        },
        required: [
          "id", "kind", "goal", "inputs", "modifies", "preserves", "excludes",
          "outputRole", "rationale", "estimatedUsage",
        ],
        additionalProperties: false,
      },
    },
  },
  required: [
    "schemaVersion", "intentAnalysisHash", "intentSummary", "strategy",
    "referenceRoles", "assumptions", "steps",
  ],
  additionalProperties: false,
} as const;

export const GLOBAL_TOOL_REGISTRY: ReadonlyArray<ToolSpec> = [
  {
    name: "read_input_manifest",
    kind: "read_only",
    description: "读取本 Run 选中图及已有分析摘要。不接受 runId——跨 Run 不可表达。",
    argumentSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "understand_image",
    kind: "provider",
    description: "方舟视觉理解一张本 Run 内素材。",
    argumentSchema: { type: "object", properties: { assetId: COMMON.assetId }, required: ["assetId"] },
  },
  // —— 智能精修专用动作（M0 eval 目标）——
  {
    name: "parse_intent",
    kind: "workspace",
    description: "把用户目标解析为结构化意图（subject/style/mood/constraints/goal）。",
    argumentSchema: {
      type: "object",
      properties: { intent: { type: "object" } },
      required: ["intent"],
    },
  },
  {
    name: "assign_reference_roles",
    kind: "workspace",
    description: "为每张参考图指派职责（main/style/composition/mood/exclude）。",
    argumentSchema: {
      type: "object",
      properties: { assignments: { type: "array" } },
      required: ["assignments"],
    },
  },
  {
    name: "record_intent_analysis",
    kind: "workspace",
    description: "记录纯文本意图分析。必须严格使用 schemaVersion/intentSummary/finalSubjectReferenceId/mustPreserve/mustTransfer/mustExclude/mayChange/highConsistencySignals/assumptions 这些 camelCase 字段；不得包含图片内容、caption、OCR 或路径。",
    argumentSchema: {
      type: "object",
      properties: { analysis: INTENT_ANALYSIS_SCHEMA },
      required: ["analysis"],
      additionalProperties: false,
    },
  },
  {
    name: "request_clarification",
    kind: "kernel",
    description: "仅当文本歧义会改变底图职责、计划路线或预算时，提交一个带推荐答案的有限澄清问题。不得询问可由默认假设或计划审批解决的偏好。",
    argumentSchema: {
      type: "object",
      properties: { proposal: CLARIFICATION_PROPOSAL_SCHEMA },
      required: ["proposal"],
      additionalProperties: false,
    },
  },
  {
    name: "score_dimensions",
    kind: "workspace",
    description: "按 rubric 对当前图在构图/光影/色调/氛围/材质等维度打分。",
    argumentSchema: {
      type: "object",
      properties: { scores: { type: "array" }, targetArtifactCallId: { type: "string" } },
      required: ["scores"],
    },
  },
  {
    name: "accept_result",
    kind: "kernel",
    description: "接受当前结果，进入 finalize（不精修）。",
    argumentSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "submit_plan_for_approval",
    kind: "kernel",
    description: "提交完整受控图片计划并暂停，等待用户审批。必须严格使用参数 schema 的 camelCase 字段；生图前只有此审批点。",
    argumentSchema: {
      type: "object",
      properties: { plan: CONTROLLED_PLAN_SCHEMA },
      required: ["plan"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_refine_plan",
    kind: "kernel",
    description: "智能精修：提交一次精修计划并暂停，等待用户审批。",
    argumentSchema: {
      type: "object",
      properties: { changes: { type: "string" }, estimatedAdditionalCredits: { type: "number" } },
      required: ["changes"],
    },
  },
  {
    name: "generate_image",
    kind: "provider",
    generates: true,
    description: "调 Seedream 生成一张图。需已批准计划；计入 maxGenerateAttempts。",
    argumentSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        referenceAssetIds: { type: "array", items: { type: "string" } },
        ratio: { type: "string" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "refine_once",
    kind: "provider",
    generates: true,
    description: "智能精修的一次修订生成。最多一次，需已批准精修计划。",
    argumentSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        referenceAssetIds: { type: "array", items: { type: "string" } },
      },
      required: ["prompt"],
    },
  },
  {
    name: "inspect_generated_image",
    kind: "provider",
    description: "对本 Run 已登记产物按 rubric 评估（只读本 Run 产物）。",
    argumentSchema: {
      type: "object",
      properties: { artifactCallId: { type: "string" } },
      required: ["artifactCallId"],
    },
  },
  {
    name: "write_artifact",
    kind: "workspace",
    description: "写计划/报告/结构化摘要到 /workspace/output（有限类型与大小）。",
    argumentSchema: {
      type: "object",
      properties: { kind: { type: "string" }, content: { type: "string" } },
      required: ["kind", "content"],
    },
  },
  {
    name: "propose_preference",
    kind: "workspace",
    description: "输出偏好候选 artifact（不写长期偏好）。",
    argumentSchema: { type: "object", properties: { facts: { type: "array" } }, required: ["facts"] },
  },
  {
    name: "finish_run",
    kind: "kernel",
    description: "提交最终产物清单。Kernel 再校验 phase/hash/完整性；模型不直接改终态。",
    argumentSchema: {
      type: "object",
      properties: { artifactCallIds: { type: "array", items: { type: "string" } } },
      required: ["artifactCallIds"],
    },
  },
  {
    name: "render_html",
    kind: "renderer",
    description:
      "把本 Run 已登记的受限 HTML/CSS 文档在离线 Chromium 中渲染为视口/整页/纵向切片 PNG。不接受 URL、路径或浏览器参数；资源只能引用本 Run 显式登记的图片 artifact；切片从同一整页像素结果裁出。截图完成后不触发任何 Vision 检查或自动修订。",
    argumentSchema: RENDER_HTML_INPUT_SCHEMA,
  },
];

const REGISTRY_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(
  GLOBAL_TOOL_REGISTRY.map((t) => [t.name, t]),
);

export function lookupTool(name: string): ToolSpec | undefined {
  return REGISTRY_BY_NAME.get(name);
}

export type PolicyContext = {
  runId: string;
  phase: string;
  manifest: SkillManifest;
  toolCallCount: number;
  generateAttemptCount: number;
  modelTurnCount: number;
  budget: BudgetSnapshot;
  ledger: ToolLedger;
  /** 当前 phase 内已派发的逻辑槽数（用于稳定 call_id）。 */
  nextLogicalSlot: number;
  approvedPlanHash?: string;
};

export type PolicyVerdict =
  | {
      verdict: "allow";
      tool: ToolSpec;
      callId: string;
      argsHash: string;
      cost: number;
      reused: boolean;
    }
  | { verdict: "awaiting_approval"; kind: "creative_plan" | "refine_plan" }
  | { verdict: "deny"; errorClass: ToolErrorClass; reason: string };

/** 模型动作是否「触发生成」。 */
function isGenerate(tool: ToolSpec): boolean {
  return tool.generates === true;
}

/**
 * 评估模型动作。检查顺序：白名单 → 跨 Run 守卫 → 次数上限 → 审批前置
 *   → 工具计数 → 预算 → 幂等复用。
 * 任一不过即 deny；deny 的 reason 是安全错误码，不回传内部安全细节给模型。
 */
export function evaluatePolicy(
  ctx: PolicyContext,
  actionName: string,
  args: unknown,
): PolicyVerdict {
  const tool = lookupTool(actionName);
  // 1) 全局白名单：shell / exec / set_budget / read_other_run 等一律不在表内。
  if (!tool) {
    return { verdict: "deny", errorClass: "policy_denied", reason: "tool_not_available" };
  }

  const argsObj = (args ?? {}) as Record<string, unknown>;

  if (ctx.manifest.id === "bowerbird-controlled-image-edit") {
    if (actionName === "inspect_generated_image") {
      return { verdict: "deny", errorClass: "policy_denied", reason: "controlled_proactive_inspection_denied" };
    }
    if (actionName === "understand_image" && ctx.phase !== "diagnose_feedback") {
      return { verdict: "deny", errorClass: "policy_denied", reason: "controlled_vision_before_feedback_denied" };
    }
    if (isGenerate(tool) && ctx.phase !== "execute_approved_plan") {
      return { verdict: "deny", errorClass: "policy_denied", reason: "controlled_generation_phase_denied" };
    }
  }

  // 1b) render_html 的 phase 门控（HTML-RENDER-PLAN §6.1）：只能由 Skill manifest 在
  //     特定 phase 的 allowedActions 中显式加入；Skill 指令不能动态开启。
  //     （现役 controlled-image-edit 的任何 phase 都未声明 → 恒拒绝，fail closed。）
  if (actionName === "render_html") {
    const phaseDef = ctx.manifest.phases.find((phase) => phase.name === ctx.phase);
    if (!phaseDef || !phaseDef.allowedActions.includes("render_html")) {
      return { verdict: "deny", errorClass: "policy_denied", reason: "render_phase_not_allowed" };
    }
  }

  // 2) 跨 Run 守卫：任何工具的 args 若携带与本 Run 不符的 runId/ownerRun → 拒绝。
  const foreignRun = argsObj["runId"] ?? argsObj["ownerRun"] ?? argsObj["targetRunId"];
  if (typeof foreignRun === "string" && foreignRun !== ctx.runId) {
    return { verdict: "deny", errorClass: "policy_denied", reason: "cross_run_access_denied" };
  }

  // 3) 生成次数上限（maxGenerateAttempts）。
  if (isGenerate(tool) && ctx.generateAttemptCount >= ctx.manifest.maxGenerateAttempts) {
    return {
      verdict: "deny",
      errorClass: "policy_denied",
      reason: "max_generate_attempts_exceeded",
    };
  }

  // 4) 审批前置：生图类工具必须有已批准计划 hash。
  if (isGenerate(tool) && !ctx.approvedPlanHash) {
    // 提交计划/精修计划是合法的「请求审批」入口，不在此分支拒绝。
    return { verdict: "deny", errorClass: "policy_denied", reason: "approval_required" };
  }

  // 5) 工具调用总数上限。
  if (ctx.toolCallCount >= ctx.manifest.maxToolCalls) {
    return { verdict: "deny", errorClass: "policy_denied", reason: "max_tool_calls_exceeded" };
  }

  // 6) 预算：固定费率估算（M0 降级规则）。
  const cost = estimateToolCost(actionName);
  if (!canAfford(ctx.budget, cost)) {
    return { verdict: "deny", errorClass: "budget_exhausted", reason: "insufficient_budget" };
  }

  // 7) 提交审批的 kernel 动作 → 不「执行」，转入 awaiting_approval。
  if (actionName === "submit_plan_for_approval") {
    return { verdict: "awaiting_approval", kind: "creative_plan" };
  }
  if (actionName === "submit_refine_plan") {
    return { verdict: "awaiting_approval", kind: "refine_plan" };
  }

  // 8) 幂等：派生稳定 call_id，若同 args_hash 已有结果则复用、不重复计费。
  const argsHash = computeArgsHash(args);
  const callId = deriveCallId({
    runId: ctx.runId,
    phase: ctx.phase,
    logicalSlot: ctx.nextLogicalSlot,
    revisionIndex: 0,
  });
  const existing = ctx.ledger.get(callId);
  if (existing && existing.argsHash === argsHash && existing.status === "succeeded") {
    return { verdict: "allow", tool, callId, argsHash, cost: 0, reused: true };
  }

  return { verdict: "allow", tool, callId, argsHash, cost, reused: false };
}

export type { ToolKind };
