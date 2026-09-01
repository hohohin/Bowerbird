import {
  RENDER_HTML_OUTPUT_SETTINGS_SCHEMA,
  validateRenderHtmlOutputSettings,
  type RenderHtmlOutputSettingsV1,
} from "../../contracts/render-html.ts";
import {
  assertVisualProfileCapsule,
  visualProfileHashPayload,
  type VisualProfileCapsule,
} from "../../contracts/visual-profile.ts";
import { canonicalJson, sha256Hex } from "../../kernel/tool-ledger.ts";

export type UnifiedAgentPlanningInput = {
  schemaVersion: 1;
  goal: string;
  /** 始终规范化并冻结进 checkpoint；旧请求缺失时使用安全默认。 */
  htmlOutput: RenderHtmlOutputSettingsV1;
  /** 项目内已确认的只读视觉设定；校验 hash 后随首次 checkpoint 冻结。 */
  visualProfileCapsule?: VisualProfileCapsule;
};

export function defaultUnifiedAgentHtmlOutput(): RenderHtmlOutputSettingsV1 {
  return {
    viewport: { widthCssPx: 900, heightCssPx: 700, deviceScaleFactor: 1 },
    capture: { mode: "full_page_and_slices", sliceHeightCssPx: 900, overlapCssPx: 0 },
    background: "opaque",
  };
}

export const UNIFIED_AGENT_PLANNING_INPUT_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { const: 1 },
    goal: { type: "string", minLength: 1, maxLength: 4_000 },
    htmlOutput: RENDER_HTML_OUTPUT_SETTINGS_SCHEMA,
    visualProfileCapsule: { type: "object" },
  },
  required: ["schemaVersion", "goal"],
  additionalProperties: false,
} as const;

export function validateUnifiedAgentPlanningInput(value: unknown): UnifiedAgentPlanningInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unified_agent_input_invalid");
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["schemaVersion", "goal", "htmlOutput", "visualProfileCapsule"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key)) || record.schemaVersion !== 1 ||
      typeof record.goal !== "string" || !record.goal.trim() || record.goal.length > 4_000) {
    throw new Error("unified_agent_input_invalid");
  }
  let visualProfileCapsule: VisualProfileCapsule | undefined;
  if (record.visualProfileCapsule !== undefined) {
    try {
      assertVisualProfileCapsule(record.visualProfileCapsule);
      if (sha256Hex(canonicalJson(visualProfileHashPayload(record.visualProfileCapsule))) !== record.visualProfileCapsule.hash) {
        throw new Error("visual_profile_hash_mismatch");
      }
      visualProfileCapsule = JSON.parse(canonicalJson(record.visualProfileCapsule)) as VisualProfileCapsule;
    } catch {
      throw new Error("unified_agent_visual_profile_invalid");
    }
  }
  const validated = validateRenderHtmlOutputSettings(record.htmlOutput ?? defaultUnifiedAgentHtmlOutput());
  if (!validated.ok) throw new Error(`unified_agent_input_invalid:${validated.violation.reason}`);
  const capture = validated.value.capture;
  return {
    schemaVersion: 1,
    goal: record.goal.trim(),
    htmlOutput: {
      viewport: { ...validated.value.viewport },
      capture: capture.mode === "full_page_and_slices"
        ? { ...capture, overlapCssPx: capture.overlapCssPx ?? 0 }
        : { mode: capture.mode },
      background: validated.value.background,
    },
    ...(visualProfileCapsule ? { visualProfileCapsule } : {}),
  };
}
