import { requireUser } from "../_shared/auth.ts";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { corsHeaders } from "../_shared/limits.ts";
import { assertComfyDownloadAccess, comfyDownloadFile, signComfyDownload } from "../_shared/comfy-download.ts";

Deno.serve(async request => {
  const id = requestId(request);
  let headers: HeadersInit = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
  try {
    headers = { ...headers, ...corsHeaders(request) };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 POST", false, 405);
    // Bound streaming bodies too, not just the caller's Content-Length.
    const reader = request.body?.getReader();
    if (!reader) throw new ApiError("invalid_request", "下载请求无效");
    let body = "", size = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2048) throw new ApiError("payload_too_large", "下载请求过大");
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally { await reader.cancel(); }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new ApiError("invalid_request", "下载请求无效"); }
    const file = comfyDownloadFile(parsed);
    const { user, admin } = await requireUser(request);
    const { data: subscription, error } = await admin.from("subscriptions").select("tier,status,current_period_end").eq("user_id", user.id).maybeSingle();
    if (error) throw new ApiError("internal_error", "读取下载权益失败", true);
    assertComfyDownloadAccess(user.app_metadata, subscription);
    const grant = await signComfyDownload(file.file, Deno.env.get("COMFY_TOS_ACCESS_KEY_ID") ?? "", Deno.env.get("COMFY_TOS_SECRET_ACCESS_KEY") ?? "");
    safeLog({ requestId: id, userId: user.id, service: "comfy-download", status: "authorized" });
    return jsonResponse({ ...grant, file: file.file, size: file.size, sha256: file.sha256 }, 200, headers);
  } catch (error) {
    safeLog({ requestId: id, service: "comfy-download", status: error instanceof ApiError ? error.code : "internal_error" });
    return errorResponse(error, id, headers);
  }
});
