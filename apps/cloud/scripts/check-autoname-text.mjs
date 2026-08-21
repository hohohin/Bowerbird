// One-off live check: text-only understand (autoname from dimension data, image=null)
// is accepted by understand-proxy and executes end-to-end (VPS worker -> Ark text-only).
// Usage: node apps/cloud/scripts/check-autoname-text.mjs
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].replace(/\s+#.*$/, "").trim();
  }
  return env;
}

const env = parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8"));
const baseUrl = env.SUPABASE_URL?.replace(/\/$/, "");
const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = env.SUPABASE_SECRET_KEY;
if (!baseUrl || !publishableKey || !secretKey) throw new Error("缺少 SUPABASE_URL/PUBLISHABLE/SECRET");

const adminHeaders = {
  apikey: secretKey,
  authorization: `Bearer ${secretKey}`,
  "content-type": "application/json",
};

const email = `svc-check-${randomUUID().slice(0, 8)}@bowerbird.test`;
const password = randomUUID();
const created = await fetch(`${baseUrl}/auth/v1/admin/users`, {
  method: "POST",
  headers: adminHeaders,
  body: JSON.stringify({ email, password, email_confirm: true }),
});
if (!created.ok) throw new Error(`创建账号失败 HTTP ${created.status}`);
const userId = (await created.json()).id;
try {
  const session = await fetch(`${baseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const token = (await session.json()).access_token;
  const headers = { apikey: publishableKey, authorization: `Bearer ${token}`, "content-type": "application/json" };
  const endpoint = `${baseUrl}/functions/v1/understand-proxy`;

  const instruction =
    "下面是这张图片的生成参数（按【维度】标注）。请根据这些内容给图片取一个不超过 8 个字的中文名字。只回复名字本身，不要标点符号、不要描述、不要解释。\n\n" +
    "【主体】：一只戴墨镜的橘猫坐在海边礁石上\n【风格】：电影感摄影，黄昏暖光\n【氛围】：慵懒惬意";
  const create = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "create",
      idempotency_key: randomUUID(),
      operation: "autoname",
      image: null,
      instruction,
    }),
  });
  const createBody = await create.json();
  console.log("create HTTP", create.status, JSON.stringify(createBody));
  if (create.status === 400) throw new Error("understand-proxy 拒绝了 image=null 请求");
  const jobId = createBody.job_id;
  if (!jobId) throw new Error("create 未返回 job_id");

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const poll = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "get", job_id: jobId }),
    });
    const body = await poll.json();
    console.log("poll:", body.status, body.text ?? body.error?.message ?? "");
    if (body.status === "succeeded") {
      console.log("AUTONAME_TEXT_OK, name =", JSON.stringify(body.text));
      process.exit(0);
    }
    if (["failed", "cancelled", "outcome_unknown"].includes(body.status)) {
      throw new Error(`任务终态 ${body.status}: ${body.error?.message ?? ""}`);
    }
  }
  throw new Error("轮询超时");
} finally {
  await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, { method: "DELETE", headers: adminHeaders });
}
