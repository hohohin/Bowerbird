/**
 * Entitlement 权益快照的非对称签名（P9 收官项：7 天离线 Pro 宽限的前提）。
 *
 * 方案：Edge 持 Ed25519 私钥（Secret `ENTITLEMENT_SIGNING_KEY`，base64 PKCS#8 DER），
 * 对快照中参与门控的字段做规范化 JSON（键排序、无空白）后签名；桌面端内置对应公钥
 * 验签（Rust 侧逐字节镜像本文件的 canonicalJson / entitlementSigningPayload）。
 *
 * - Secret 未配置 / 运行时不支持 Ed25519 → 返回 null，函数回落 signature_version=0
 *   （在线可信、离线不可解锁付费权益，与历史行为一致）。
 * - 轮换：换 Secret + 换桌面内置公钥一起发布；旧签名验签失败自动降级 free，用户
 *   在线重同步即可，无需额外迁移。
 */

export const ENTITLEMENT_SIGNATURE_VERSION = 1;

/** 参与签名的快照子集（时间字段一律 toISOString() 的毫秒精度字符串）。 */
export interface EntitlementSigningInput {
  v: number;
  user_id: string;
  tier: string;
  balances: { daily: number; sub: number; topup: number };
  policy: Record<string, unknown>;
  generation_services: { service: string; label: string; credits: number }[];
  prompt_configs: { key: string; value: string; version: number }[];
  issued_at: string;
  refresh_after: string;
  grace_until: string;
  entitlement_version: number;
}

/** 递归键排序 + 无空白 JSON。与桌面 Rust `canonical_json` 逐字节一致：
 *  数字按 JS/serde_json 的最短往返表示（本子集只有整数）、字符串转义规则两边相同、
 *  键按 UTF-16 码元升序（Rust String 字节序对 ASCII 键等价——本子集键全为 ASCII）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const body = Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",");
  return `{${body}}`;
}

export function entitlementSigningPayload(snapshot: EntitlementSigningInput): string {
  return canonicalJson(snapshot);
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

let signingKeyPromise: Promise<CryptoKey | null> | null = null;

async function loadSigningKey(): Promise<CryptoKey | null> {
  const secret = Deno.env.get("ENTITLEMENT_SIGNING_KEY")?.trim();
  if (!secret) return null;
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      base64ToBytes(secret),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
  } catch (error) {
    console.error("entitlement signing key import failed", error);
    return null;
  }
}

/** 签署规范化 payload；返回 base64 签名，未配置/失败返回 null（回落 unsigned）。 */
export async function signEntitlementPayload(payload: string): Promise<string | null> {
  signingKeyPromise ??= loadSigningKey();
  const key = await signingKeyPromise;
  if (!key) return null;
  try {
    const signature = await crypto.subtle.sign(
      { name: "Ed25519" },
      key,
      new TextEncoder().encode(payload),
    );
    return bytesToBase64(new Uint8Array(signature));
  } catch (error) {
    console.error("entitlement signing failed", error);
    return null;
  }
}

export async function signEntitlement(
  snapshot: EntitlementSigningInput,
): Promise<string | null> {
  return signEntitlementPayload(entitlementSigningPayload(snapshot));
}

/** 仅测试用：清空模块级密钥缓存，允许用例各自设置/删除 ENTITLEMENT_SIGNING_KEY。 */
export function _resetEntitlementSigningKeyCacheForTests(): void {
  signingKeyPromise = null;
}
