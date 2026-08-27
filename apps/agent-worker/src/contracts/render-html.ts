/**
 * `render_html` 工具契约 v1 —— HTML-RENDER-PLAN.md §4.2/§4.3（H2-T1）。
 *
 * 两层形态：
 *   - `RenderHtmlInputV1`：**模型可提交**的输入（artifact id 形态，无 URL/路径/浏览器参数）。
 *     在 Kernel/执行器侧校验（闭集整数 + 未知字段拒绝），并交给 PolicyEngine 的
 *     argumentSchema 下发模型；
 *   - `RendererWireRequest/Success`：Agent Worker → html-renderer 容器的**内部有界请求**
 *     形态（字节形态），与 apps/html-renderer/src/contracts.ts 逐字段镜像；
 *     wire 兼容由 render-html-executor.test.ts 的跨包 fixture 测试钉死。
 *
 * 数值上限镜像 RENDER_LIMITS（apps/html-renderer/src/limits.ts，H0 spike 后如调整需两侧同步）。
 */

export type RenderHtmlCaptureMode = "viewport" | "full_page" | "full_page_and_slices";
export type RenderHtmlBackground = "opaque" | "transparent";

/** 模型可提交的输入（v1）。 */
export type RenderHtmlInputV1 = {
  schemaVersion: 1;
  /** 当前 Run 内 role=html_document 的 artifact id（compose 阶段产出）。 */
  htmlArtifactId: string;
  /** 当前 Run 内显式登记的图片 artifact id（资源闭集，执行器复核归属）。 */
  resourceArtifactIds: string[];
  viewport: {
    widthCssPx: number;
    heightCssPx: number;
    deviceScaleFactor: 1 | 2;
  };
  capture: {
    mode: RenderHtmlCaptureMode;
    sliceHeightCssPx?: number;
    overlapCssPx?: number;
  };
  background: RenderHtmlBackground;
};

/** 新增 artifact 角色（HTML-RENDER-PLAN §4.4；migration 0044 扩 DB check 约束）。 */
export type RenderHtmlArtifactRole =
  | "html_document"
  | "render_manifest"
  | "viewport_screenshot"
  | "full_page_screenshot"
  | "slice_screenshot";

/** 单次调用允许的最大切片数（与 renderer 侧 maxSliceCount 一致）。 */
export const RENDER_HTML_MAX_SLICES = 32;
export const RENDER_HTML_MAX_RESOURCES = 64;

/** 下发模型的 JSON Schema（闭集；用于 PolicyEngine argumentSchema）。 */
export const RENDER_HTML_INPUT_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    htmlArtifactId: { type: "string", description: "本 Run 内已提交的 HTML/CSS 文档 artifact id" },
    resourceArtifactIds: {
      type: "array",
      maxItems: RENDER_HTML_MAX_RESOURCES,
      items: { type: "string", description: "本 Run 内显式登记的图片 artifact id" },
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
  required: ["schemaVersion", "htmlArtifactId", "resourceArtifactIds", "viewport", "capture", "background"],
  additionalProperties: false,
} as const;

export type RenderHtmlInputViolation = { reason: string };

const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9-]{1,80}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(obj: Record<string, unknown>, knownKeys: readonly string[]): boolean {
  return Object.keys(obj).every((key) => knownKeys.includes(key));
}

function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * 校验模型提交的 render_html 输入（schema 闭集）。
 * 归属（htmlArtifactId/resourceArtifactIds 是否属于当前 Run）由执行器在工作区层复核。
 */
export function validateRenderHtmlInput(input: unknown): { ok: true; value: RenderHtmlInputV1 } | { ok: false; violation: RenderHtmlInputViolation } {
  if (!isPlainObject(input)) return fail("input_not_object");
  if (!onlyKeys(input, ["schemaVersion", "htmlArtifactId", "resourceArtifactIds", "viewport", "capture", "background"])) {
    return fail("unknown_field");
  }
  if (input.schemaVersion !== 1) return fail("schema_version");
  if (typeof input.htmlArtifactId !== "string" || !ARTIFACT_ID_PATTERN.test(input.htmlArtifactId)) return fail("html_artifact_id");
  if (!Array.isArray(input.resourceArtifactIds)) return fail("resource_artifact_ids");
  if (input.resourceArtifactIds.length > RENDER_HTML_MAX_RESOURCES) return fail("resource_count");
  const seen = new Set<string>();
  for (const id of input.resourceArtifactIds) {
    if (typeof id !== "string" || !ARTIFACT_ID_PATTERN.test(id)) return fail("resource_artifact_id");
    if (seen.has(id)) return fail("resource_artifact_id_duplicate");
    seen.add(id);
  }

  const vp = input.viewport;
  if (!isPlainObject(vp) || !onlyKeys(vp, ["widthCssPx", "heightCssPx", "deviceScaleFactor"])) return fail("viewport_shape");
  if (!isInteger(vp.widthCssPx) || vp.widthCssPx < 320 || vp.widthCssPx > 2400) return fail("viewport_width");
  if (!isInteger(vp.heightCssPx) || vp.heightCssPx < 240 || vp.heightCssPx > 4000) return fail("viewport_height");
  if (vp.deviceScaleFactor !== 1 && vp.deviceScaleFactor !== 2) return fail("device_scale_factor");

  const cap = input.capture;
  if (!isPlainObject(cap) || !onlyKeys(cap, ["mode", "sliceHeightCssPx", "overlapCssPx"])) return fail("capture_shape");
  if (cap.mode !== "viewport" && cap.mode !== "full_page" && cap.mode !== "full_page_and_slices") return fail("capture_mode");
  if (typeof input.background !== "string" || (input.background !== "opaque" && input.background !== "transparent")) return fail("background");
  if (cap.mode === "full_page_and_slices") {
    if (!isInteger(cap.sliceHeightCssPx) || cap.sliceHeightCssPx < 200 || cap.sliceHeightCssPx > 4000) return fail("slice_height");
    const overlap = cap.overlapCssPx ?? 0;
    if (!isInteger(overlap) || overlap < 0 || overlap > 200) return fail("slice_overlap");
    if (overlap >= cap.sliceHeightCssPx) return fail("slice_overlap_ge_height");
  } else if (cap.sliceHeightCssPx !== undefined || cap.overlapCssPx !== undefined) {
    return fail("slice_params_without_slice_mode");
  }

  return { ok: true, value: input as unknown as RenderHtmlInputV1 };
}

function fail(reason: string): { ok: false; violation: RenderHtmlInputViolation } {
  return { ok: false, violation: { reason } };
}

// ———— 纯 base64 编解码（零依赖；Node Buffer 的等价子集，行为确定性一致） ————

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_ALPHABET[b0 >> 2]!;
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    out += b1 === undefined ? "=" : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    out += b2 === undefined ? "=" : BASE64_ALPHABET[b2 & 0x3f]!;
  }
  return out;
}

export function base64Decode(value: string): Uint8Array {
  const clean = value.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    const digit = BASE64_ALPHABET.indexOf(char);
    if (digit < 0) continue;
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }
  return out.subarray(0, index);
}

// ————————————————————————————————————————————
// Worker → html-renderer 内部 wire 契约（镜像 apps/html-renderer/src/contracts.ts）
// ————————————————————————————————————————————

export type RendererWireResource = {
  key: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  sha256: string;
  dataBase64: string;
};

export type RendererWireRequest = {
  schemaVersion: 1;
  requestId: string;
  runId: string;
  callId: string;
  argsHash: string;
  html: string;
  resources: RendererWireResource[];
  viewport: { widthCssPx: number; heightCssPx: number; deviceScaleFactor: 1 | 2 };
  capture: { mode: RenderHtmlCaptureMode; sliceHeightCssPx?: number; overlapCssPx?: number };
  background: RenderHtmlBackground;
};

export type RendererWireOutput = {
  role: "viewport_screenshot" | "full_page_screenshot" | "slice_screenshot";
  index?: number;
  clipDevicePx: { x: number; y: number; width: number; height: number };
  mime: "image/png";
  widthDevicePx: number;
  heightDevicePx: number;
  bytes: number;
  sha256: string;
  dataBase64: string;
};

export type RendererWireSuccess = {
  ok: true;
  schemaVersion: 1;
  rendererFingerprint: string;
  runId: string;
  callId: string;
  argsHash: string;
  sourceHtmlSha256: string;
  document: { widthCssPx: number; heightCssPx: number; widthDevicePx: number; heightDevicePx: number };
  renderMs: number;
  outputs: RendererWireOutput[];
};

/** renderer 失败响应（稳定错误码，§11）。 */
export type RendererWireFailure = {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
};

export const RENDERER_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "render_layout_unstable",
  "render_timeout",
  "render_capacity_busy",
  "render_service_unavailable",
]);

/** 执行器产出的规范化结果（进入 checkpoint / 模型可见摘要的形态，§4.3）。 */
export type RenderHtmlResultV1 = {
  schemaVersion: 1;
  rendererFingerprint: string;
  sourceHtmlSha256: string;
  argsHash: string;
  document: { widthCssPx: number; heightCssPx: number; widthDevicePx: number; heightDevicePx: number };
  renderMs: number;
  outputs: Array<{
    artifactId: string;
    role: RenderHtmlArtifactRole;
    index?: number;
    clipDevicePx: { x: number; y: number; width: number; height: number };
    mime: "image/png";
    bytes: number;
    sha256: string;
  }>;
};
