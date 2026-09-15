import { ApiError } from "./errors.ts";

export function normalizeRedemptionCode(value: unknown): string {
  if (typeof value !== "string" || value.length > 128) {
    throw new ApiError("invalid_request", "请输入有效的兑换码");
  }
  const code = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(code)) throw new ApiError("invalid_request", "兑换码格式不正确，请检查后重试");
  return code;
}

export async function redemptionCodeHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeRedemptionCode(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readRedemptionBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new ApiError("invalid_request", "请输入兑换码");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 1024) {
        await reader.cancel();
        throw new ApiError("payload_too_large", "请求内容过大");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new ApiError("invalid_request", "兑换请求格式不正确"); }
}

export function assertRedemptionResult(result: { status?: string } | null): void {
  switch (result?.status) {
    case "redeemed": return;
    case "unauthorized": throw new ApiError("unauthorized", "请重新登录后兑换");
    case "invalid_code": throw new ApiError("invalid_request", "兑换码无效、已过期或已被使用");
    case "rate_limited": throw new ApiError("rate_limited", "兑换尝试过于频繁，请 15 分钟后再试");
    case "studio_active": throw new ApiError("invalid_request", "当前已是 Studio，暂不支持兑换 Pro；兑换码未使用");
    case "permanent_pro": throw new ApiError("invalid_request", "当前 Pro 无到期时间，无需续期；兑换码未使用");
    default: throw new ApiError("internal_error", "兑换服务暂时不可用，请使用同一码重试", true);
  }
}
