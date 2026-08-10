import { ApiError } from "./errors.ts";

const DEFAULT_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];

export function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? DEFAULT_ORIGINS.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) throw new ApiError("unauthorized", "不允许的请求来源");
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, apikey, content-type, x-request-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "Origin",
  };
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(Deno.env.get(name) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function assertBodySize(request: Request): void {
  const maxBytes = envInt("MAX_REQUEST_BODY_MB", 20) * 1024 * 1024;
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > maxBytes) throw new ApiError("payload_too_large", "请求内容过大");
}

export function assertReferenceImages(images: unknown, maxCount = 10): void {
  if (!Array.isArray(images)) throw new ApiError("invalid_request", "reference_images 必须是数组");
  if (images.length > maxCount) throw new ApiError("invalid_request", `参考图最多 ${maxCount} 张`);

  const maxBytes = envInt("MAX_REQUEST_BODY_MB", 20) * 1024 * 1024;
  let approximateBytes = 0;
  for (const image of images) {
    if (!image || typeof image !== "object") throw new ApiError("invalid_request", "参考图格式错误");
    const { mime, base64 } = image as Record<string, unknown>;
    if (typeof mime !== "string" || !["image/jpeg", "image/png", "image/webp"].includes(mime)) {
      throw new ApiError("invalid_request", "参考图格式仅支持 JPEG/PNG/WebP");
    }
    if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      throw new ApiError("invalid_request", "参考图 base64 无效");
    }
    approximateBytes += Math.floor(base64.length * 0.75);
  }
  if (approximateBytes > maxBytes) throw new ApiError("payload_too_large", "参考图总大小超限");
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  const timeout = timeoutMs ?? envInt("UPSTREAM_TIMEOUT_MS", 120_000);
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new ApiError("upstream_timeout", "上游处理超时", true)),
          timeout,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
