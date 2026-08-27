import { assertEquals } from "jsr:@std/assert@1";
import {
  _resetEntitlementSigningKeyCacheForTests,
  canonicalJson,
  entitlementSigningPayload,
  signEntitlement,
  type EntitlementSigningInput,
} from "./entitlement-signing.ts";

// 跨语言测试向量：同一密钥/快照在 Edge TS 与桌面 Rust（entitlement.rs 测试）两侧
// 必须产出逐字节相同的 payload 与签名。私钥仅测试用，不是任何环境的真实密钥。
const VECTOR_PRIVATE_KEY =
  "MC4CAQAwBQYDK2VwBCIEIMBnBWDt/XghwyUH+Rvjgq2hnmf5TTCSyV3vg02rXNuY";
const VECTOR_SIGNATURE =
  "FpKmT6I4a1UC6VVXMzgKiWUVjP99FEva91aq+O7iFUQOD4RSWeSECP8Rx+vNdaUgD3WwxkA7NuHocrGReTenBg==";
const VECTOR_PAYLOAD = String.raw`{"balances":{"daily":12,"sub":340,"topup":0},"entitlement_version":2,"generation_services":[{"credits":5,"label":"Pro 高质量","service":"image_pro"},{"credits":1,"label":"Lite 极速","service":"image_lite"}],"grace_until":"2026-09-03T08:00:00.000Z","issued_at":"2026-08-27T08:00:00.000Z","policy":{"agent_budget_options":["controlled-min","controlled-standard"],"allowed_agent_skills":["bowerbird-controlled-image-edit"],"can_hd_export":false,"can_use_agent_runs":true,"can_use_byo":true,"can_use_cloud":true,"can_use_priority_queue":false,"can_use_visual_profiles":true,"max_parallel_agent_runs":2,"max_parallel_jobs":4,"understand_daily_limit":null},"prompt_configs":[{"key":"understand_autoname","value":"给这张图取名\n第二行描述","version":3}],"refresh_after":"2026-08-27T14:00:00.000Z","tier":"pro","user_id":"11111111-2222-3333-4444-555555555555","v":1}`;

function vectorInput(): EntitlementSigningInput {
  return {
    v: 1,
    user_id: "11111111-2222-3333-4444-555555555555",
    tier: "pro",
    balances: { daily: 12, sub: 340, topup: 0 },
    policy: {
      can_use_byo: true,
      can_use_cloud: true,
      max_parallel_jobs: 4,
      understand_daily_limit: null,
      can_use_priority_queue: false,
      can_hd_export: false,
      can_use_agent_runs: true,
      max_parallel_agent_runs: 2,
      allowed_agent_skills: ["bowerbird-controlled-image-edit"],
      agent_budget_options: ["controlled-min", "controlled-standard"],
      can_use_visual_profiles: true,
    },
    generation_services: [
      { service: "image_pro", label: "Pro 高质量", credits: 5 },
      { service: "image_lite", label: "Lite 极速", credits: 1 },
    ],
    prompt_configs: [
      { key: "understand_autoname", value: "给这张图取名\n第二行描述", version: 3 },
    ],
    issued_at: "2026-08-27T08:00:00.000Z",
    refresh_after: "2026-08-27T14:00:00.000Z",
    grace_until: "2026-09-03T08:00:00.000Z",
    entitlement_version: 2,
  };
}

Deno.test("canonical json sorts keys recursively and keeps unicode raw", () => {
  assertEquals(canonicalJson({ b: 1, a: [true, null, "x"], "中": 2 }), String.raw`{"a":[true,null,"x"],"b":1,"中":2}`);
  assertEquals(canonicalJson(undefined), "null");
});

Deno.test("entitlement signing payload matches the rust-verified canonical vector", () => {
  assertEquals(entitlementSigningPayload(vectorInput()), VECTOR_PAYLOAD);
});

Deno.test("signed vector reproduces the cross-language signature", async () => {
  Deno.env.set("ENTITLEMENT_SIGNING_KEY", VECTOR_PRIVATE_KEY);
  _resetEntitlementSigningKeyCacheForTests();
  try {
    assertEquals(await signEntitlement(vectorInput()), VECTOR_SIGNATURE);
  } finally {
    Deno.env.delete("ENTITLEMENT_SIGNING_KEY");
    _resetEntitlementSigningKeyCacheForTests();
  }
});

Deno.test("signing falls back to null when the key is unconfigured", async () => {
  Deno.env.delete("ENTITLEMENT_SIGNING_KEY");
  _resetEntitlementSigningKeyCacheForTests();
  assertEquals(await signEntitlement(vectorInput()), null);
});
