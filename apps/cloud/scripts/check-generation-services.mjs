// One-off live check: entitlement Edge returns the data-driven generation_services list.
// Usage: node apps/cloud/scripts/check-generation-services.mjs
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
  const response = await fetch(`${baseUrl}/functions/v1/entitlement`, {
    headers: { apikey: publishableKey, authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`entitlement HTTP ${response.status}: ${await response.text()}`);
  const body = await response.json();
  console.log("generation_services =", JSON.stringify(body.generation_services, null, 2));
  if (!Array.isArray(body.generation_services) || body.generation_services.length < 3) {
    throw new Error("generation_services 缺失或少于 3 档");
  }
  const policy = body.policy;
  if (policy?.can_use_agent_runs !== true || policy?.max_parallel_agent_runs !== 1 ||
      !policy?.allowed_agent_skills?.includes("bowerbird-controlled-image-edit") ||
      !policy?.agent_budget_options?.includes("controlled-min") ||
      !policy?.agent_budget_options?.includes("controlled-standard")) {
    throw new Error("免费档 Agent FeaturePolicy 缺失或不一致");
  }
  console.log("agent_feature_policy =", JSON.stringify({
    can_use_agent_runs: policy.can_use_agent_runs,
    max_parallel_agent_runs: policy.max_parallel_agent_runs,
    allowed_agent_skills: policy.allowed_agent_skills,
    agent_budget_options: policy.agent_budget_options,
  }, null, 2));
  console.log("ENTITLEMENT_SERVICES_OK");
} finally {
  await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, { method: "DELETE", headers: adminHeaders });
}
