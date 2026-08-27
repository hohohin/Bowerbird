/**
 * renderer 内部请求/响应契约 v1 —— HTML-RENDER-PLAN.md §4.2/§4.3 的容器内形态。
 *
 * 模型可提交的 `render_html` 输入（RenderHtmlInputV1，artifact id 形态）由 Agent Worker
 * 在 H2 定义；Worker 负责解析 artifact、验证 MIME/大小/SHA-256 后，把**字节**经本内部
 * 契约发给 renderer。因此：
 *   - 本 schema 不出现 URL、路径、header、浏览器参数；
 *   - 资源以 `asset:<key>` 占位 + 字节表表达，HTML 中的引用必须是占位形式；
 *   - runId/callId/argsHash 由 Worker 派生并随请求携带，renderer 原样回显供双方复核（§5.4）。
 *
 * 全部校验为服务端闭集：未知字段拒绝、整数范围检查、模式字段互斥。
 */
import { RENDER_LIMITS } from "./limits.ts";
import type { RenderErrorCode } from "./errors.ts";

export const RENDER_SCHEMA_VERSION = 1;

export type RenderCaptureMode = "viewport" | "full_page" | "full_page_and_slices";
export type RenderBackground = "opaque" | "transparent";
export type RenderResourceMime = "image/png" | "image/jpeg" | "image/webp";

/** 资源占位 key：HTML 内以 `asset:<key>` 引用；key 本身不可猜测语义（Worker 生成）。 */
export type RenderResource = {
  key: string;
  mime: RenderResourceMime;
  /** 资源字节 sha256 hex（Worker 已验证；renderer 复核）。 */
  sha256: string;
  /** 资源字节（base64）。 */
  dataBase64: string;
};

export type InternalRenderRequest = {
  schemaVersion: number;
  /** Worker 派生的请求标识（run+call 派生），仅用于日志与临时目录命名。 */
  requestId: string;
  runId: string;
  callId: string;
  /** 与 Worker 侧 `call_id + args_hash` 幂等键对应；renderer 回显。 */
  argsHash: string;
  html: string;
  resources: RenderResource[];
  viewport: {
    widthCssPx: number;
    heightCssPx: number;
    deviceScaleFactor: 1 | 2;
  };
  capture: {
    mode: RenderCaptureMode;
    sliceHeightCssPx?: number;
    overlapCssPx?: number;
  };
  background: RenderBackground;
};

export type DeviceRect = { x: number; y: number; width: number; height: number };

export type RenderOutputRole = "viewport_screenshot" | "full_page_screenshot" | "slice_screenshot";

export type InternalRenderOutput = {
  role: RenderOutputRole;
  /** 切片序号，1 起递增；仅 slice_screenshot 有。 */
  index?: number;
  /** 裁切区域（设备像素，相对整页像素结果原点）。 */
  clipDevicePx: DeviceRect;
  mime: "image/png";
  widthDevicePx: number;
  heightDevicePx: number;
  bytes: number;
  sha256: string;
  dataBase64: string;
};

export type InternalRenderSuccess = {
  ok: true;
  schemaVersion: number;
  rendererFingerprint: string;
  /** 回显复核字段（§5.4）。 */
  runId: string;
  callId: string;
  argsHash: string;
  sourceHtmlSha256: string;
  document: {
    widthCssPx: number;
    heightCssPx: number;
    widthDevicePx: number;
    heightDevicePx: number;
  };
  renderMs: number;
  outputs: InternalRenderOutput[];
};

export type InternalRenderResult = InternalRenderSuccess | { ok: false; code: RenderErrorCode; message: string; retryable: boolean };

export type ContractViolation = { code: RenderErrorCode; reason: string };

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const RESOURCE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);
const CAPTURE_MODES: ReadonlySet<string> = new Set(["viewport", "full_page", "full_page_and_slices"]);
const BACKGROUNDS: ReadonlySet<string> = new Set(["opaque", "transparent"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** id 闭集 + 拒绝路径串段（防御纵深：临时目录名由这些 id 派生）。 */
function isValidId(v: unknown): v is string {
  return typeof v === "string" && ID_PATTERN.test(v) && !v.includes("..");
}

/** 严格白名单字段检查：对象只允许 knownKeys 中列出的键。 */
function onlyKeys(obj: Record<string, unknown>, knownKeys: readonly string[]): boolean {
  for (const key of Object.keys(obj)) {
    if (!knownKeys.includes(key)) return false;
  }
  return true;
}

/**
 * 校验内部渲染请求。返回 fail 时 reason 为无内容的短分类。
 * 字节级复核（base64 可解码、sha256 一致、magic bytes、总量）在 render-service 做；
 * 这里只做 schema 形状与闭集范围。
 */
export function validateRenderRequest(input: unknown): { ok: true; value: InternalRenderRequest } | { ok: false; violation: ContractViolation } {
  if (!isPlainObject(input)) return fail("render_input_invalid", "request_not_object");
  if (!onlyKeys(input, ["schemaVersion", "requestId", "runId", "callId", "argsHash", "html", "resources", "viewport", "capture", "background"])) {
    return fail("render_input_invalid", "unknown_request_field");
  }
  if (input.schemaVersion !== RENDER_SCHEMA_VERSION) return fail("render_input_invalid", "schema_version");
  if (!isValidId(input.requestId)) return fail("render_input_invalid", "request_id");
  if (!isValidId(input.runId)) return fail("render_input_invalid", "run_id");
  if (!isValidId(input.callId)) return fail("render_input_invalid", "call_id");
  if (typeof input.argsHash !== "string" || !HEX64_PATTERN.test(input.argsHash)) return fail("render_input_invalid", "args_hash");

  if (typeof input.html !== "string") return fail("render_input_invalid", "html_not_string");
  const htmlBytes = Buffer.byteLength(input.html, "utf8");
  if (htmlBytes === 0) return fail("render_input_invalid", "html_empty");
  if (htmlBytes > RENDER_LIMITS.maxHtmlBytes) return fail("render_input_invalid", "html_too_large");

  if (!Array.isArray(input.resources)) return fail("render_input_invalid", "resources_not_array");
  if (input.resources.length > RENDER_LIMITS.maxResourceCount) return fail("render_input_invalid", "resource_count");
  const seenKeys = new Set<string>();
  let declaredBytes = 0;
  for (const item of input.resources) {
    if (!isPlainObject(item) || !onlyKeys(item, ["key", "mime", "sha256", "dataBase64"])) {
      return fail("render_input_invalid", "resource_shape");
    }
    if (typeof item.key !== "string" || !KEY_PATTERN.test(item.key)) return fail("render_input_invalid", "resource_key");
    if (seenKeys.has(item.key)) return fail("render_input_invalid", "resource_key_duplicate");
    seenKeys.add(item.key);
    if (typeof item.mime !== "string" || !RESOURCE_MIMES.has(item.mime)) return fail("render_input_invalid", "resource_mime");
    if (typeof item.sha256 !== "string" || !HEX64_PATTERN.test(item.sha256)) return fail("render_input_invalid", "resource_sha256");
    if (typeof item.dataBase64 !== "string") return fail("render_input_invalid", "resource_data");
    declaredBytes += Math.floor((item.dataBase64.length * 3) / 4);
    if (declaredBytes > RENDER_LIMITS.maxResourcesTotalBytes) return fail("render_input_invalid", "resources_total_bytes");
  }

  const vp = input.viewport;
  if (!isPlainObject(vp) || !onlyKeys(vp, ["widthCssPx", "heightCssPx", "deviceScaleFactor"])) {
    return fail("render_input_invalid", "viewport_shape");
  }
  if (!isInteger(vp.widthCssPx) || vp.widthCssPx < RENDER_LIMITS.minViewportWidthCssPx || vp.widthCssPx > RENDER_LIMITS.maxViewportWidthCssPx) {
    return fail("render_input_invalid", "viewport_width");
  }
  if (!isInteger(vp.heightCssPx) || vp.heightCssPx < RENDER_LIMITS.minViewportHeightCssPx || vp.heightCssPx > RENDER_LIMITS.maxViewportHeightCssPx) {
    return fail("render_input_invalid", "viewport_height");
  }
  if (vp.deviceScaleFactor !== 1 && vp.deviceScaleFactor !== 2) return fail("render_input_invalid", "device_scale_factor");

  const cap = input.capture;
  if (!isPlainObject(cap) || !onlyKeys(cap, ["mode", "sliceHeightCssPx", "overlapCssPx"])) {
    return fail("render_input_invalid", "capture_shape");
  }
  if (typeof cap.mode !== "string" || !CAPTURE_MODES.has(cap.mode)) return fail("render_input_invalid", "capture_mode");
  if (typeof input.background !== "string" || !BACKGROUNDS.has(input.background)) return fail("render_input_invalid", "background");
  if (cap.mode === "full_page_and_slices") {
    if (!isInteger(cap.sliceHeightCssPx) || cap.sliceHeightCssPx < RENDER_LIMITS.minSliceHeightCssPx || cap.sliceHeightCssPx > RENDER_LIMITS.maxSliceHeightCssPx) {
      return fail("render_input_invalid", "slice_height");
    }
    const overlap = cap.overlapCssPx ?? 0;
    if (!isInteger(overlap) || overlap < RENDER_LIMITS.minOverlapCssPx || overlap > RENDER_LIMITS.maxOverlapCssPx) {
      return fail("render_input_invalid", "slice_overlap");
    }
    if (overlap >= cap.sliceHeightCssPx) return fail("render_input_invalid", "slice_overlap_ge_height");
  } else if (cap.sliceHeightCssPx !== undefined || cap.overlapCssPx !== undefined) {
    // 非 slicing 模式不允许出现切片参数（闭集语义，防止歧义扩散）。
    return fail("render_input_invalid", "slice_params_without_slice_mode");
  }

  return { ok: true, value: input as unknown as InternalRenderRequest };
}

function fail(code: RenderErrorCode, reason: string): { ok: false; violation: ContractViolation } {
  return { ok: false, violation: { code, reason } };
}
