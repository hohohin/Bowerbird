export type ErrorCode =
  | "unauthorized"
  | "insufficient_credits"
  | "payload_too_large"
  | "rate_limited"
  | "upstream_failed"
  | "cost_limit_reached"
  | "capacity_reached"
  | "upstream_timeout"
  | "invalid_request"
  | "not_configured"
  | "upgrade_required"
  | "internal_error";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  insufficient_credits: 402,
  payload_too_large: 413,
  rate_limited: 429,
  upstream_failed: 502,
  cost_limit_reached: 503,
  capacity_reached: 503,
  upstream_timeout: 504,
  invalid_request: 400,
  not_configured: 503,
  upgrade_required: 403,
  internal_error: 500,
};

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly status = STATUS[code],
  ) {
    super(message);
  }
}

export function requestId(request: Request): string {
  return request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(error: unknown, id: string, headers: HeadersInit = {}): Response {
  const known = error instanceof ApiError
    ? error
    : new ApiError("internal_error", "服务暂时不可用", true);
  return jsonResponse(
    { error: { code: known.code, message: known.message, request_id: id, retryable: known.retryable } },
    known.status,
    headers,
  );
}

export function safeLog(fields: {
  requestId: string;
  userId?: string;
  service?: string;
  status: string;
  elapsedMs?: number;
  credits?: number;
}): void {
  // Never add token, prompt, image, request body or upstream keys to this object.
  console.log(JSON.stringify({
    request_id: fields.requestId,
    user_hash: fields.userId ? fields.userId.slice(0, 8) : undefined,
    service: fields.service,
    status: fields.status,
    elapsed_ms: fields.elapsedMs,
    credits: fields.credits,
  }));
}
