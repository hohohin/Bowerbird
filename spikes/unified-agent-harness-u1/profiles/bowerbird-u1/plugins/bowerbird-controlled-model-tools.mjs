import { defineTool } from "@deepseek-ai/dsh-tools";
import { callBowerbirdPlanningBridge } from "./bowerbird-planning-rpc.mjs";

const JSON_OUTPUT = {
  schema: { type: "json" },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};

const STRING = { type: "string" };
const STRING_ARRAY = { type: "array", items: STRING };
const HIGH_CONSISTENCY_SIGNAL = {
  type: "string",
  enum: ["identity", "product", "pose", "garment", "accessory", "composition", "text_layout"],
};
const REFERENCE_ROLE = {
  type: "string",
  enum: ["base", "pose", "identity", "product", "garment", "accessory", "composition", "style", "other"],
};

const INTENT_ANALYSIS = {
  type: "object",
  required: true,
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", required: true, enum: [1] },
    intentSummary: { ...STRING, required: true },
    finalSubjectReferenceId: STRING,
    mustPreserve: { ...STRING_ARRAY, required: true },
    mustTransfer: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          fromReferenceId: { ...STRING, required: true },
          attributes: { ...STRING_ARRAY, required: true },
        },
      },
    },
    mustExclude: { ...STRING_ARRAY, required: true },
    mayChange: { ...STRING_ARRAY, required: true },
    highConsistencySignals: { type: "array", required: true, items: HIGH_CONSISTENCY_SIGNAL },
    assumptions: { ...STRING_ARRAY, required: true },
  },
};

const CLARIFICATION_PROPOSAL = {
  type: "object",
  required: true,
  additionalProperties: false,
  properties: {
    questionKey: { ...STRING, required: true },
    contextHash: { ...STRING, required: true },
    question: { ...STRING, required: true },
    recommendedAnswer: { ...STRING, required: true },
    options: { ...STRING_ARRAY, required: true },
    optionPatches: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          answer: { ...STRING, required: true },
          patches: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                field: { ...STRING, required: true },
                op: { type: "string", required: true, enum: ["set", "clear"] },
                value: { type: "json" },
              },
            },
          },
        },
      },
    },
    affectedIntentFields: { ...STRING_ARRAY, required: true },
    rationale: { ...STRING, required: true },
  },
};

const CONTROLLED_PLAN = {
  type: "object",
  required: true,
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", required: true, enum: [1] },
    intentAnalysisHash: { ...STRING, required: true },
    intentSummary: { ...STRING, required: true },
    strategy: { type: "string", required: true, enum: ["direct", "controlled", "staged_controlled"] },
    referenceRoles: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          referenceId: { ...STRING, required: true },
          role: { ...REFERENCE_ROLE, required: true },
          mustPreserve: { ...STRING_ARRAY, required: true },
          mustTransfer: { ...STRING_ARRAY, required: true },
          mustExclude: { ...STRING_ARRAY, required: true },
        },
      },
    },
    assumptions: { ...STRING_ARRAY, required: true },
    steps: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { ...STRING, required: true },
          kind: {
            type: "string",
            required: true,
            enum: ["direct_generate", "generate_control_reference", "edit_from_previous"],
          },
          goal: { ...STRING, required: true },
          inputs: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string", required: true, enum: ["reference", "step"] },
                referenceId: STRING,
                stepId: STRING,
              },
            },
          },
          modifies: { ...STRING_ARRAY, required: true },
          preserves: { ...STRING_ARRAY, required: true },
          excludes: { ...STRING_ARRAY, required: true },
          outputRole: {
            type: "string",
            required: true,
            enum: ["control_reference", "stage_result", "final_result"],
          },
          rationale: { ...STRING, required: true },
          estimatedUsage: {
            type: "object",
            required: true,
            additionalProperties: false,
            properties: {
              generateCalls: { type: "integer", required: true, enum: [1] },
              understandCalls: { type: "integer", required: true, enum: [0] },
            },
          },
        },
      },
    },
  },
};

function remoteAction(name, description, parameters) {
  return defineTool({
    name,
    description,
    parameters,
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const value = await callBowerbirdPlanningBridge(name, args, exec.signal);
      if (value && typeof value === "object" && value.terminalReason === "model_action_captured") {
        exec.concludeTurn();
      }
      return value;
    },
  });
}

export const name = "bowerbird-controlled-model-tools";
export const inject = ["tools"];

export function controlledModelToolDefinitions() {
  return [
    remoteAction(
      "record_intent_analysis",
      "Record the text-only controlled intent analysis using exactly the declared camelCase fields. Never include image content, captions, OCR, paths, or invented reference IDs.",
      { analysis: INTENT_ANALYSIS },
    ),
    remoteAction(
      "request_clarification",
      "Return one bounded clarification only when text ambiguity changes the base responsibility, plan route, or budget.",
      { proposal: CLARIFICATION_PROPOSAL },
    ),
    remoteAction(
      "submit_plan_for_approval",
      "Return the complete controlled image plan for parent-Kernel validation and user approval. This does not execute any image tool.",
      { plan: CONTROLLED_PLAN },
    ),
  ];
}

export function apply(ctx) {
  for (const definition of controlledModelToolDefinitions()) ctx.tools.register(definition);
}
