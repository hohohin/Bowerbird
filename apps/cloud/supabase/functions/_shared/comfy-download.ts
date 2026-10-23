import { ApiError } from "./errors.ts";
import { accountTestMarker, activeTier } from "./feature-policy.ts";
import manifest from "./comfy-download-manifest.json" with { type: "json" };

export { manifest };
export function assertComfyDownloadAccess(metadata: unknown, subscription: Parameters<typeof activeTier>[0]) {
  if (!accountTestMarker(metadata) && !["pro", "studio"].includes(activeTier(subscription))) {
    throw new ApiError("upgrade_required", "本地 H3 视频需要有效的 Pro／Studio 权益或测试账号资格");
  }
}
export function comfyDownloadFile(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalid_request", "下载请求无效");
  const value = body as Record<string, unknown>;
  const file = manifest.files.find(item => item.file === value.file);
  if (value.version !== manifest.version || !file || Object.keys(value).some(key => !["version", "file"].includes(key))) {
    throw new ApiError("invalid_request", "不支持的安装资源，请更新客户端");
  }
  return file;
}

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const bytes = (value: string) => new TextEncoder().encode(value);
const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, "0")).join("");
async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, bytes(value)));
}

// Fixed GET-only TOS4 signing. No client-selected bucket, host, method or object prefix.
// https://docs.volcengine.com/docs/TorchObjectStorage/URLcontainsasignature
export async function signComfyDownload(file: string, accessKey: string, secretKey: string, now = new Date()) {
  comfyDownloadFile({ version: manifest.version, file });
  if (!accessKey || !secretKey) throw new ApiError("not_configured", "安装下载服务尚未配置");
  const region = "cn-guangzhou", host = "bowerbird.tos-cn-guangzhou.volces.com", expires = 3600;
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const scope = `${date.slice(0, 8)}/${region}/tos/request`;
  const path = `/comfyui/${manifest.version}/${file}`.split("/").map(encode).join("/");
  const params: Record<string, string> = {
    "X-Tos-Algorithm": "TOS4-HMAC-SHA256", "X-Tos-Credential": `${accessKey}/${scope}`,
    "X-Tos-Date": date, "X-Tos-Expires": String(expires), "X-Tos-SignedHeaders": "host",
  };
  const query = Object.keys(params).sort().map(key => `${encode(key)}=${encode(params[key])}`).join("&");
  const canonical = `GET\n${path}\n${query}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const digest = hex(await crypto.subtle.digest("SHA-256", bytes(canonical)));
  let key = await hmac(bytes(secretKey), date.slice(0, 8));
  for (const value of [region, "tos", "request"]) key = await hmac(key, value);
  const signature = hex((await hmac(key, `TOS4-HMAC-SHA256\n${date}\n${scope}\n${digest}`)).buffer as ArrayBuffer);
  return { url: `https://${host}${path}?${query}&X-Tos-Signature=${signature}`, expiresAt: new Date(now.getTime() + expires * 1000).toISOString() };
}
