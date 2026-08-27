/**
 * 稳定错误码 —— HTML-RENDER-PLAN.md §11。
 *
 * renderer → Agent Worker 只回传稳定 code + 安全文案；详细原因仅进受限运维日志，
 * 且日志不得包含 HTML/CSS 正文、用户文本或资源内容。
 */

export const RENDER_ERROR_CODES = [
  "render_input_invalid",
  "render_html_unsafe",
  "render_resource_invalid",
  "render_document_too_large",
  "render_layout_unstable",
  "render_timeout",
  "render_capacity_busy",
  "render_output_invalid",
  "render_service_unavailable",
] as const;

export type RenderErrorCode = (typeof RENDER_ERROR_CODES)[number];

export type RenderFailure = {
  ok: false;
  code: RenderErrorCode;
  /** 安全文案（面向 Worker/模型的固定短语，不含输入内容）。 */
  message: string;
  /** §11 的可重试语义：仅不稳定/超时/繁忙/服务异常可有限重试。 */
  retryable: boolean;
};

const SAFE_MESSAGES: Record<RenderErrorCode, string> = {
  render_input_invalid: "render request schema or parameters invalid",
  render_html_unsafe: "html contains forbidden constructs",
  render_resource_invalid: "resource missing or failed validation",
  render_document_too_large: "document exceeds render size limits",
  render_layout_unstable: "layout did not stabilize in time",
  render_timeout: "render exceeded time budget",
  render_capacity_busy: "renderer busy",
  render_output_invalid: "render output failed validation",
  render_service_unavailable: "renderer unavailable",
};

const RETRYABLE: ReadonlySet<RenderErrorCode> = new Set<RenderErrorCode>([
  "render_layout_unstable",
  "render_timeout",
  "render_capacity_busy",
  "render_service_unavailable",
]);

/** 构造对外的安全失败（detail 只进内部日志，不回传）。 */
export function renderFailure(code: RenderErrorCode): RenderFailure {
  return { ok: false, code, message: SAFE_MESSAGES[code], retryable: RETRYABLE.has(code) };
}

/** 内部错误分类（短、无内容），供运维日志定位；永远不回传给调用方。 */
export type RenderErrorDetail = {
  code: RenderErrorCode;
  /** 机器可读的短原因，如 tag_not_allowed / url_scheme_forbidden / crc_mismatch。 */
  reason: string;
};

export function renderError(code: RenderErrorCode, reason: string): RenderErrorDetail {
  return { code, reason };
}
