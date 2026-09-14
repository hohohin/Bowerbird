import type { AuthContext } from "./auth.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "./errors.ts";
import { corsHeaders } from "./limits.ts";
import { readRedemptionBody, redemptionCodeHash } from "./redemption.ts";

const encoder = new TextEncoder();
export function assertCodeAdmin(user: { app_metadata?: Record<string, unknown> }): void {
  if (user.app_metadata?.bowerbird_admin !== true) {
    throw new ApiError("unauthorized", "此账号没有兑换码管理权限", false, 403);
  }
}

export function adminUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError("invalid_request", "记录标识不正确");
  }
  return value;
}

export async function codeEncryptionKey(encoded = Deno.env.get("PRO_CODE_ENCRYPTION_KEY") ?? ""): Promise<CryptoKey> {
  try {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    if (bytes.length !== 32) throw new Error();
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch { throw new ApiError("not_configured", "发码密钥尚未配置，请联系部署管理员"); }
}

export async function encryptCode(key: CryptoKey, id: string, code: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(id) }, key, encoder.encode(code)));
  return `v1.${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...bytes))}`;
}

export async function decryptCode(key: CryptoKey, id: string, envelope: string): Promise<string> {
  try {
    const [version, iv, data, extra] = envelope.split(".");
    if (version !== "v1" || extra !== undefined) throw new Error();
    const result = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(atob(iv), (c) => c.charCodeAt(0)), additionalData: encoder.encode(id) },
      key, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    return new TextDecoder().decode(result);
  } catch { throw new ApiError("internal_error", "兑换码解密失败，请检查发码密钥", false); }
}

export function issueParameters(body: Record<string, unknown>, now = Date.now()) {
  const batchId = adminUuid(body.batch_id);
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const count = body.count;
  const expiry = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
  if (!label || label.length > 80 || !Number.isInteger(count) || Number(count) < 1 || Number(count) > 1000
    || !Number.isFinite(expiry) || expiry <= now || expiry > now + 730 * 86400000) {
    throw new ApiError("invalid_request", "请填写批次名称、1–1000 的数量和未来两年内的兑换截止时间");
  }
  return { batchId, label, count: Number(count), expiresAt: new Date(expiry).toISOString() };
}

export async function handleCodeAdmin(request: Request, authenticate: (request: Request) => Promise<AuthContext>): Promise<Response> {
  const id = requestId(request);
  let headers: HeadersInit = { "cache-control": "no-store", "pragma": "no-cache" };
  let userId: string | undefined;
  try {
    headers = { ...headers, ...corsHeaders(request) };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    const { user, admin } = await authenticate(request);
    assertCodeAdmin(user);
    userId = user.id;
    const body = await readRedemptionBody(request);
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const { data, error } = await admin.rpc(name, { ...args, p_actor: user.id });
      if (error?.code === "42501") throw new ApiError("unauthorized", "此账号没有兑换码管理权限", false, 403);
      if (error?.code === "22023") throw new ApiError("invalid_request", "请求参数无效，或该批次请求已用于其他发码内容");
      if (error) throw new ApiError("internal_error", "兑换码管理服务暂时不可用，请重试", true);
      return data;
    };
    let result: unknown;
    switch (body.action) {
      case "list": {
        const status = typeof body.status === "string" ? body.status : "";
        const search = typeof body.search === "string" ? body.search.trim() : "";
        const page = body.page ?? 0;
        if (!["", "unused", "redeemed", "expired", "disabled"].includes(status) || search.length > 100
          || !Number.isInteger(page) || Number(page) < 0 || Number(page) > 100000) throw new ApiError("invalid_request", "筛选条件不正确");
        result = await rpc("admin_list_pro_codes", { p_status: status, p_search: search,
          p_batch_id: body.batch_id ? adminUuid(body.batch_id) : null, p_page: page });
        break;
      }
      case "issue": {
        const { batchId, label, count, expiresAt } = issueParameters(body);
        const key = await codeEncryptionKey();
        const codes = await Promise.all(Array.from({ length: count }, async () => {
          const codeId = crypto.randomUUID();
          const raw = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
          const code = raw.match(/.{8}/g)!.join("-");
          return { id: codeId, hash: await redemptionCodeHash(raw), suffix: raw.slice(-8), ciphertext: await encryptCode(key, codeId, code) };
        }));
        result = await rpc("admin_issue_pro_codes", { p_batch_id: batchId, p_label: label, p_expires_at: expiresAt, p_codes: codes });
        break;
      }
      case "disable": {
        result = await rpc("admin_disable_pro_code", { p_code_id: adminUuid(body.code_id) });
        const status = (result as { status: string })?.status;
        if (status === "already_redeemed") throw new ApiError("invalid_request", "该码已被兑换，无法停用；用户权益未改变", false, 409);
        if (status === "not_found") throw new ApiError("invalid_request", "兑换码不存在", false, 404);
        break;
      }
      case "reveal":
      case "export": {
        const key = await codeEncryptionKey();
        const rows = await rpc("admin_read_pro_codes", { p_batch_id: body.action === "export" ? adminUuid(body.batch_id) : null,
          p_code_id: body.action === "reveal" ? adminUuid(body.code_id) : null });
        const codes = await Promise.all((rows as { id: string; ciphertext: string; expires_at: string; batch_label: string }[]).map(async (row) => ({
          id: row.id, code: await decryptCode(key, row.id, row.ciphertext), expires_at: row.expires_at, batch_label: row.batch_label,
        })));
        result = { codes };
        break;
      }
      default: throw new ApiError("invalid_request", "未知管理操作");
    }
    safeLog({ requestId: id, userId, status: "succeeded" });
    return jsonResponse(result, 200, headers);
  } catch (error) {
    safeLog({ requestId: id, userId, status: error instanceof ApiError ? error.code : "internal_error" });
    return errorResponse(error, id, headers);
  }
}
