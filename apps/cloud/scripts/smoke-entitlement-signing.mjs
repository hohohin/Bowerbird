// Entitlement 非对称签名线上冒烟（P9：7 天离线 Pro 宽限）。
//   node apps/cloud/scripts/smoke-entitlement-signing.mjs
// 前置：apps/cloud/.env 已加载（脚本自行读取）、Edge 已配置 ENTITLEMENT_SIGNING_KEY 并部署。
// 步骤：建临时账号 → 登录取 JWT → GET entitlement → 断言 signature_version=1 →
//       用 BOWERBIRD_ENTITLEMENT_PUBKEY 以与 Edge 相同的规范化 JSON 本地验签 → 清理账号。
// 该脚本会产生一次真实权益读取（不产生任何积分/模型费用）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verify } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).split("#")[0].trim();
}

const baseUrl = env.SUPABASE_URL?.replace(/\/$/, "");
const secretKey = env.SUPABASE_SECRET_KEY;
const publishableKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY;
const pubkeyB64 = env.BOWERBIRD_ENTITLEMENT_PUBKEY;
if (!baseUrl || !secretKey || !publishableKey || !pubkeyB64) {
  console.error("缺少 SUPABASE_URL / SUPABASE_SECRET_KEY / SUPABASE_PUBLISHABLE_KEY / BOWERBIRD_ENTITLEMENT_PUBKEY（.env）");
  process.exit(2);
}

async function jsonRequest(label, url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body?.error?.code ?? body?.code ?? "unknown";
    throw new Error(`${label}失败（HTTP ${response.status}, ${code}）：${body?.error?.message ?? body?.message ?? ""}`);
  }
  return body;
}

// 与 _shared/entitlement-signing.ts（及桌面 Rust canonical_json）逐字节一致。
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value;
  const body = Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",");
  return `{${body}}`;
}

const adminHeaders = { apikey: secretKey, authorization: `Bearer ${secretKey}`, "content-type": "application/json" };
const email = `ent-sign-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@example.test`;
const password = `${crypto.randomUUID()}Aa1!`;
let userId;

try {
  const created = await jsonRequest("创建临时账号", `${baseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  userId = created.id;

  const session = await jsonRequest("临时账号登录", `${baseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const snapshot = await jsonRequest("读取权益快照", `${baseUrl}/functions/v1/entitlement?forceFunctionRegion=ap-northeast-1`, {
    method: "GET",
    headers: { apikey: publishableKey, authorization: `Bearer ${session.access_token}` },
  });

  assert.equal(snapshot.signature_version, 1, "Edge 应返回 signature_version=1（检查 ENTITLEMENT_SIGNING_KEY Secret）");
  assert.ok(typeof snapshot.signature === "string" && snapshot.signature.length > 0, "签名不能为空");

  const payload = canonicalJson({
    v: 1,
    user_id: snapshot.user_id,
    tier: snapshot.tier,
    balances: snapshot.balances,
    policy: snapshot.policy,
    generation_services: snapshot.generation_services,
    prompt_configs: snapshot.prompt_configs,
    issued_at: snapshot.issued_at,
    refresh_after: snapshot.refresh_after,
    grace_until: snapshot.grace_until,
    entitlement_version: snapshot.entitlement_version,
  });
  // env 存原始 32 字节（桌面 Rust VerifyingKey::from_bytes 直用）；Node verify 需要
  // SPKI DER：Ed25519 公钥的固定 12 字节头 + 32 字节键体。
  const raw = Buffer.from(pubkeyB64, "base64");
  assert.equal(raw.length, 32, "BOWERBIRD_ENTITLEMENT_PUBKEY 应为 32 字节 base64");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  const ok = verify(null, Buffer.from(payload, "utf8"), { key: spki, format: "der", type: "spki" }, Buffer.from(snapshot.signature, "base64"));
  assert.ok(ok, "公钥验签失败（Edge 私钥与 BOWERBIRD_ENTITLEMENT_PUBKEY 不成对？）");
  assert.equal(snapshot.tier, "free");

  console.log("Entitlement 签名冒烟通过：signature_version=1，公钥本地验签一致。");
} finally {
  if (userId) {
    await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: adminHeaders,
    }).catch(() => {});
  }
}
