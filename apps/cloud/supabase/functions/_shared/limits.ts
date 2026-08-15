import { ApiError } from "./errors.ts";

const DEFAULT_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];
export const DEFAULT_PROXY_TIMEOUT_MS = 140_000;

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
  const maxImageBytes = 10 * 1024 * 1024;
  let approximateBytes = 0;
  for (const image of images) {
    if (!image || typeof image !== "object") throw new ApiError("invalid_request", "参考图格式错误");
    const { mime, base64 } = image as Record<string, unknown>;
    if (typeof mime !== "string" || !["image/jpeg", "image/png"].includes(mime)) {
      throw new ApiError("invalid_request", "参考图必须转换为 JPEG 或 PNG 后上传");
    }
    if (typeof base64 !== "string" || !base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      throw new ApiError("invalid_request", "参考图 base64 无效");
    }
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
    } catch {
      throw new ApiError("invalid_request", "参考图 base64 无效");
    }
    const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    if ((mime === "image/jpeg" && !isJpeg) || (mime === "image/png" && !isPng)) {
      throw new ApiError("invalid_request", "参考图 MIME 与真实文件格式不一致");
    }
    if (bytes.length > maxImageBytes) {
      throw new ApiError("payload_too_large", "单张参考图不能超过 10 MB");
    }
    approximateBytes += bytes.length;
  }
  if (approximateBytes > maxBytes) throw new ApiError("payload_too_large", "参考图总大小超限");
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  const timeout = timeoutMs ?? envInt("PROXY_TIMEOUT_MS", DEFAULT_PROXY_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
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
