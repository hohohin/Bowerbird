import type { SkillManifest } from "../../contracts/skill.ts";
import { COMPOSE_HTML_DOCUMENT_SCHEMA, HTML_LAYOUT_RENDER_INPUT_SCHEMA } from "./schemas.ts";

export const HTML_LAYOUT_RENDER_MANIFEST: SkillManifest = {
  id: "bowerbird-html-layout-render",
  version: "0.1.0",
  kernelMinVersion: "0.1.0",
  snapshotSchemaVersion: 1,
  title: "Bowerbird HTML 离线排版",
  description: "生成受限 HTML/CSS 并离线截图一次；不访问网页、不调用 Vision、不自动修订。",
  inputSchema: HTML_LAYOUT_RENDER_INPUT_SCHEMA,
  artifactSchema: {
    type: "object",
    properties: {
      role: { enum: ["html_document", "render_manifest", "viewport_screenshot", "full_page_screenshot", "slice_screenshot"] },
    },
    required: ["role"],
    additionalProperties: false,
  },
  phases: [
    { name: "prepare_inputs", allowedActions: [], maxTurns: 0, transitions: [] },
    {
      name: "compose_html_document",
      allowedActions: ["compose_html_document"],
      maxTurns: 2,
      transitions: [{ action: "compose_html_document", to: "render_once" }],
    },
    {
      name: "render_once",
      allowedActions: ["render_html"],
      maxTurns: 0,
      transitions: [{ action: "render_html", to: "awaiting_user_review" }],
    },
    { name: "awaiting_user_review", allowedActions: [], maxTurns: 0, transitions: [] },
    { name: "exporting", allowedActions: [], maxTurns: 0, transitions: [] },
    { name: "succeeded", allowedActions: [], maxTurns: 0, transitions: [] },
    { name: "failed", allowedActions: [], maxTurns: 0, transitions: [] },
    { name: "cancelled", allowedActions: [], maxTurns: 0, transitions: [] },
  ],
  initialPhase: "prepare_inputs",
  terminalPhases: ["succeeded", "failed", "cancelled"],
  budgetTiers: [{ id: "html-layout-test", credits: 15, label: "HTML 排版测试" }],
  allowedProviders: ["deepseek"],
  maxRunSeconds: 600,
  maxModelTurns: 2,
  maxToolCalls: 2,
  maxGenerateAttempts: 0,
  clarifications: { maxPerRun: 0, intentFields: [] },
};

export { COMPOSE_HTML_DOCUMENT_SCHEMA };
