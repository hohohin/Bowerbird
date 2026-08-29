import type { RenderHtmlBackground, RenderHtmlCaptureMode } from "../../contracts/render-html.ts";

export type HtmlLayoutReferenceInput = {
  artifactId: string;
  token: string;
  ordinal: number;
  mime: "image/png" | "image/jpeg" | "image/webp";
  bytes: number;
  sha256: string;
};

export type HtmlLayoutRenderInputV1 = {
  schemaVersion: 1;
  layoutPrompt: string;
  references: HtmlLayoutReferenceInput[];
  viewport: { widthCssPx: number; heightCssPx: number; deviceScaleFactor: 1 | 2 };
  capture: { mode: RenderHtmlCaptureMode; sliceHeightCssPx?: number; overlapCssPx?: number };
  background: RenderHtmlBackground;
};

export type ComposeHtmlDocumentActionV1 = {
  schemaVersion: 1;
  html: string;
  resourceArtifactIds: string[];
};

const ARTIFACT_ID = /^[A-Za-z0-9-]{1,80}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REFERENCES = 16;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function fail(reason: string): never {
  throw new Error(`html_layout_input_invalid:${reason}`);
}

export const COMPOSE_HTML_DOCUMENT_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    html: { type: "string", minLength: 1, maxLength: MAX_HTML_BYTES },
    resourceArtifactIds: {
      type: "array",
      maxItems: MAX_REFERENCES,
      items: { type: "string", pattern: "^[A-Za-z0-9-]{1,80}$" },
    },
  },
  required: ["schemaVersion", "html", "resourceArtifactIds"],
  additionalProperties: false,
} as const;

export const HTML_LAYOUT_RENDER_INPUT_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    layoutPrompt: { type: "string", minLength: 1, maxLength: 4_000 },
    references: {
      type: "array",
      maxItems: MAX_REFERENCES,
      items: {
        type: "object",
        properties: {
          artifactId: { type: "string", pattern: "^[A-Za-z0-9-]{1,80}$" },
          token: { type: "string", minLength: 1, maxLength: 160 },
          ordinal: { type: "integer", minimum: 1, maximum: MAX_REFERENCES },
          mime: { type: "string", enum: ["image/png", "image/jpeg", "image/webp"] },
          bytes: { type: "integer", minimum: 1, maximum: 20 * 1024 * 1024 },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
        required: ["artifactId", "token", "ordinal", "mime", "bytes", "sha256"],
        additionalProperties: false,
      },
    },
    viewport: {
      type: "object",
      properties: {
        widthCssPx: { type: "integer", minimum: 320, maximum: 2400 },
        heightCssPx: { type: "integer", minimum: 240, maximum: 4000 },
        deviceScaleFactor: { type: "integer", enum: [1, 2] },
      },
      required: ["widthCssPx", "heightCssPx", "deviceScaleFactor"],
      additionalProperties: false,
    },
    capture: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["viewport", "full_page", "full_page_and_slices"] },
        sliceHeightCssPx: { type: "integer", minimum: 200, maximum: 4000 },
        overlapCssPx: { type: "integer", minimum: 0, maximum: 200 },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    background: { type: "string", enum: ["opaque", "transparent"] },
  },
  required: ["schemaVersion", "layoutPrompt", "references", "viewport", "capture", "background"],
  additionalProperties: false,
} as const;

export function validateHtmlLayoutRenderInput(value: unknown): HtmlLayoutRenderInputV1 {
  if (!record(value) || !only(value, ["schemaVersion", "layoutPrompt", "references", "viewport", "capture", "background"])) fail("shape");
  if (value.schemaVersion !== 1) fail("schema_version");
  if (typeof value.layoutPrompt !== "string" || !value.layoutPrompt.trim() || value.layoutPrompt.length > 4_000) fail("layout_prompt");
  if (!Array.isArray(value.references) || value.references.length > MAX_REFERENCES) fail("references");
  const ids = new Set<string>();
  value.references.forEach((item, index) => {
    if (!record(item) || !only(item, ["artifactId", "token", "ordinal", "mime", "bytes", "sha256"])) fail("reference_shape");
    if (typeof item.artifactId !== "string" || !ARTIFACT_ID.test(item.artifactId) || ids.has(item.artifactId)) fail("reference_artifact_id");
    ids.add(item.artifactId);
    if (typeof item.token !== "string" || !item.token.trim() || item.token.length > 160 || item.ordinal !== index + 1) fail("reference_identity");
    if (item.mime !== "image/png" && item.mime !== "image/jpeg" && item.mime !== "image/webp") fail("reference_mime");
    if (!integer(item.bytes) || item.bytes <= 0 || item.bytes > 20 * 1024 * 1024 || typeof item.sha256 !== "string" || !SHA256.test(item.sha256)) fail("reference_metadata");
  });
  const viewport = value.viewport;
  if (!record(viewport) || !only(viewport, ["widthCssPx", "heightCssPx", "deviceScaleFactor"]) ||
      !integer(viewport.widthCssPx) || viewport.widthCssPx < 320 || viewport.widthCssPx > 2400 ||
      !integer(viewport.heightCssPx) || viewport.heightCssPx < 240 || viewport.heightCssPx > 4000 ||
      (viewport.deviceScaleFactor !== 1 && viewport.deviceScaleFactor !== 2)) fail("viewport");
  const capture = value.capture;
  if (!record(capture) || !only(capture, ["mode", "sliceHeightCssPx", "overlapCssPx"]) ||
      (capture.mode !== "viewport" && capture.mode !== "full_page" && capture.mode !== "full_page_and_slices")) fail("capture");
  if (capture.mode === "full_page_and_slices") {
    if (!integer(capture.sliceHeightCssPx) || capture.sliceHeightCssPx < 200 || capture.sliceHeightCssPx > 4000) fail("slice_height");
    const overlap = capture.overlapCssPx ?? 0;
    if (!integer(overlap) || overlap < 0 || overlap > 200 || overlap >= capture.sliceHeightCssPx) fail("slice_overlap");
  } else if (capture.sliceHeightCssPx !== undefined || capture.overlapCssPx !== undefined) fail("slice_params");
  if (value.background !== "opaque" && value.background !== "transparent") fail("background");
  return value as unknown as HtmlLayoutRenderInputV1;
}

/**
 * 模型 compose action 的第一道闭集校验。renderer sanitizer 仍是 HTML/CSS 安全权威；
 * 这里额外保证资源顺序与当前 Run 显式 manifest 完全一致，且模型不能表达 URL/路径。
 */
export function validateComposeHtmlDocumentAction(
  value: unknown,
  expectedResourceArtifactIds: readonly string[],
): ComposeHtmlDocumentActionV1 {
  if (!record(value) || !only(value, ["schemaVersion", "html", "resourceArtifactIds"])) fail("compose_shape");
  if (value.schemaVersion !== 1 || typeof value.html !== "string") fail("compose_schema");
  const htmlBytes = new TextEncoder().encode(value.html).byteLength;
  if (!htmlBytes || htmlBytes > MAX_HTML_BYTES || value.html.includes("\0")) fail("compose_html_size");
  if (!Array.isArray(value.resourceArtifactIds) || value.resourceArtifactIds.length !== expectedResourceArtifactIds.length ||
      value.resourceArtifactIds.some((id, index) => id !== expectedResourceArtifactIds[index])) fail("compose_resource_manifest");
  if (/(?:https?|file|data|javascript|ftp):|\\\\|[A-Za-z]:[\\/]/i.test(value.html)) fail("compose_external_locator");
  if (/<\s*(?:script|iframe|base|form|object|embed|svg)\b|\bon[a-z]+\s*=|@import\b/i.test(value.html)) fail("compose_unsafe_markup");
  for (const match of value.html.matchAll(/asset:([A-Za-z0-9-]+)/g)) {
    const key = match[1] ?? "";
    const ordinal = /^reference-(\d+)$/.exec(key);
    if (!ordinal || Number(ordinal[1]) < 1 || Number(ordinal[1]) > expectedResourceArtifactIds.length) fail("compose_asset_reference");
  }
  return value as unknown as ComposeHtmlDocumentActionV1;
}
