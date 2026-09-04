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
  references?: UnifiedAgentReference[];
  ratio?: string;
  /** 始终规范化并冻结进 checkpoint；旧请求缺失时使用安全默认。 */
  htmlOutput: RenderHtmlOutputSettingsV1;
  /** 项目内已确认的只读视觉设定；校验 hash 后随首次 checkpoint 冻结。 */
  visualProfileCapsule?: VisualProfileCapsule;
};

export type UnifiedAgentReference = {
  artifactId: string;
  token: string;
  ordinal: number;
  mime: "image/png" | "image/jpeg" | "image/webp";
  bytes: number;
  sha256: string;
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
    references: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          artifactId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
          token: { type: "string", minLength: 1, maxLength: 160 },
          ordinal: { type: "integer", minimum: 1, maximum: 8 },
          mime: { enum: ["image/png", "image/jpeg", "image/webp"] },
          bytes: { type: "integer", minimum: 1, maximum: 10_485_760 },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
        required: ["artifactId", "token", "ordinal", "mime", "bytes", "sha256"],
        additionalProperties: false,
      },
    },
    ratio: { enum: ["1:1", "3:4", "4:3", "2:3", "3:2", "16:9", "9:16"] },
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
  const allowedKeys = new Set(["schemaVersion", "goal", "references", "ratio", "htmlOutput", "visualProfileCapsule"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key)) || record.schemaVersion !== 1 ||
      typeof record.goal !== "string" || !record.goal.trim() || record.goal.length > 4_000 ||
      record.references !== undefined && (!Array.isArray(record.references) || record.references.length > 8)) {
    throw new Error("unified_agent_input_invalid");
  }
  if (record.ratio !== undefined && !["1:1", "3:4", "4:3", "2:3", "3:2", "16:9", "9:16"].includes(String(record.ratio))) {
    throw new Error("unified_agent_input_invalid");
  }
  const ids = new Set<string>();
  const references = (record.references as unknown[] | undefined)?.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("unified_agent_input_invalid");
    const item = raw as Record<string, unknown>;
    const artifactId = typeof item.artifactId === "string" ? item.artifactId : "";
    const token = typeof item.token === "string" ? item.token.trim() : "";
    if (Object.keys(item).some((key) => !["artifactId", "token", "ordinal", "mime", "bytes", "sha256"].includes(key)) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(artifactId) ||
        ids.has(artifactId) || !token || token.length > 160 || item.ordinal !== index + 1 ||
        !["image/png", "image/jpeg", "image/webp"].includes(String(item.mime)) ||
        !Number.isInteger(item.bytes) || Number(item.bytes) < 1 || Number(item.bytes) > 10 * 1024 * 1024 ||
        typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256)) {
      throw new Error("unified_agent_input_invalid");
    }
    ids.add(artifactId);
    return {
      artifactId,
      token,
      ordinal: index + 1,
      mime: String(item.mime) as UnifiedAgentReference["mime"],
      bytes: Number(item.bytes),
      sha256: item.sha256 as string,
    };
  });
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
    ...(references ? { references } : {}),
    ...(record.ratio ? { ratio: String(record.ratio) } : {}),
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
