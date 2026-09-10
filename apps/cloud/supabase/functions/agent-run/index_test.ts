import { assertEquals, assert } from "jsr:@std/assert@1";

// Exercise the deployed handler with a fake Supabase transport. No server,
// database, storage upload, or paid provider is contacted.
let handler: (request: Request) => Promise<Response>;
const serve = Deno.serve;
Deno.serve = ((callback: typeof handler) => {
  handler = callback;
  return {};
}) as typeof Deno.serve;
try {
  await import("./index.ts");
} finally {
  Deno.serve = serve;
}

const unified = "bowerbird-unified-agent";
const controlled = "bowerbird-controlled-image-edit";
const html = "bowerbird-html-layout-render";
const accountId = "11111111-1111-4111-8111-111111111111";
const holdId = "22222222-2222-4222-8222-222222222222";
const oldRun = (skill = controlled, runtime = "legacy_kernel") => ({
  id: "33333333-3333-4333-8333-333333333333",
  conversation_id: "44444444-4444-4444-8444-444444444444",
  user_id: accountId,
  status: "awaiting_approval",
  skill_id: skill,
  agent_runtime: runtime,
  input_count: 0,
  input_manifest_hash: "a".repeat(64),
  request_object_key: "runs/old/inputs/request.json",
  image_provider: "cloud",
  budget_credits: skill === html ? 15 : skill === unified ? 30 : 48,
  pricing_version: 1,
  visual_profile_id: null,
  visual_profile_version: null,
  visual_profile_hash: null,
});

Deno.test("Agent create retires new legacy routes while preserving immutable replay", async (t) => {
  async function run(options: {
    skill?: string;
    runtime?: string;
    existing?: ReturnType<typeof oldRun>;
    testAccount?: boolean;
    dshEnabled?: string;
    unifiedEnabled?: string;
    manifestHash?: string;
  } = {}) {
    const env = {
      SUPABASE_URL: "http://supabase.invalid",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SECRET_KEY: "test-secret",
      AGENT_ACCESS_MODE: "",
      AGENT_DSH_RUNTIME_SELECTION_ENABLED: options.dshEnabled ?? "true",
      AGENT_UNIFIED_DSH_ENABLED: options.unifiedEnabled ?? "true",
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, Deno.env.get(key)]));
    for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
    const fetch = globalThis.fetch;
    const calls: { path: string; body: Record<string, unknown> | null }[] = [];
    const reply = (body: unknown, headers = {}) => Response.json(body, { headers });
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      assertEquals(url.origin, "http://supabase.invalid");
      const path = url.pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ path, body });
      if (path === "/auth/v1/user") return reply({ id: accountId, app_metadata: { bowerbird_test: options.testAccount !== false } });
      if (path === "/rest/v1/billing_accounts") return reply([{ id: accountId }]);
      if (path === "/rest/v1/subscriptions") return reply([]);
      if (path === "/rest/v1/credit_holds") {
        assertEquals(url.searchParams.get("user_id"), `eq.${accountId}`);
        return reply(options.existing ? [{
          id: holdId, status: "held", pricing_version: 1,
          estimated_amount: options.existing.budget_credits,
          service: options.existing.skill_id === html ? "agent_html_layout_render"
            : options.existing.skill_id === unified ? "agent_unified_test" : "agent_controlled_image_edit",
        }] : []);
      }
      if (path === "/rest/v1/agent_runs") {
        return reply(options.existing && url.searchParams.has("hold_id") ? [options.existing] : [], { "content-range": "*/0" });
      }
      if (path === "/rest/v1/rpc/ensure_daily_credits") return reply([{ daily_balance: 100, sub_balance: 0, topup_balance: 0 }]);
      if (path === "/rest/v1/rpc/credit_hold") return reply([{ hold_id: holdId, estimated_amount: 30, pricing_version: 1 }]);
      if (path === "/rest/v1/rpc/create_agent_run_guarded") {
        return reply({ id: body.p_run_id, conversation_id: body.p_conversation_id, request_object_key: body.p_request_object_key });
      }
      if (path === "/rest/v1/rpc/reserve_managed_usage") return reply([{ already_reserved: !!options.existing }]);
      if (path.startsWith("/storage/v1/object/upload/sign/")) return reply({ url: "/object/upload/sign/agent-temp/request.json?token=test" });
      throw new Error(`Unexpected transport call: ${path}`);
    }) as typeof globalThis.fetch;
    try {
      const response = await handler(new Request("http://edge.invalid/agent-run", {
        method: "POST", headers: { authorization: "Bearer test-user", "content-type": "application/json" },
        body: JSON.stringify({
          action: "create", skillId: options.skill ?? unified, agentRuntime: options.runtime,
          goal: "测试统一入口", inputCount: 0, inputManifestHash: options.manifestHash ?? "a".repeat(64),
          idempotencyKey: "entry-test-replay", imageProvider: "cloud",
        }),
      }));
      return { status: response.status, body: await response.json(), calls };
    } finally {
      globalThis.fetch = fetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
      }
    }
  }

  for (const [skill, runtime] of [[controlled, undefined], [controlled, "dsh"], [html, "legacy_kernel"], [unified, "legacy_kernel"]]) {
    await t.step(`rejects new ${skill}/${runtime ?? "omitted"} before billing`, async () => {
      const result = await run({ skill, runtime });
      assertEquals(result.status, 409);
      assert(!result.calls.some((call) => call.path.includes("/rpc/")));
    });
  }
  for (const options of [{ testAccount: false }, { dshEnabled: "false" }, { unifiedEnabled: "false" }]) {
    await t.step(`keeps unified account/environment gate ${JSON.stringify(options)}`, async () => {
      const result = await run(options);
      assertEquals(result.status, "testAccount" in options ? 403 : 503);
      assert(!result.calls.some((call) => call.path.includes("/rpc/")));
    });
  }
  await t.step("defaults new unified Agent to DSH and passes only that selection to RPC", async () => {
    const result = await run();
    assertEquals(result.status, 200);
    const create = result.calls.filter((call) => call.path.endsWith("/create_agent_run_guarded"));
    assertEquals(create.length, 1);
    assertEquals(create[0].body?.p_skill_id, unified);
    assertEquals(create[0].body?.p_agent_runtime, "dsh");
    assertEquals(result.body.agentRuntime, "dsh");
  });
  for (const [skill, runtime] of [[controlled, "legacy_kernel"], [controlled, "dsh"], [html, "legacy_kernel"]]) {
    await t.step(`replays existing ${skill}/${runtime} while new DSH creation is disabled`, async () => {
      const result = await run({ skill, runtime: runtime === "legacy_kernel" ? undefined : runtime, existing: oldRun(skill, runtime), dshEnabled: "false", unifiedEnabled: "false" });
      assertEquals(result.status, 200);
      assertEquals(result.body.reused, true);
      assertEquals(result.body.runId, oldRun().id);
      assertEquals(result.body.agentRuntime, runtime);
      assert(!result.calls.some((call) => call.path.endsWith("/create_agent_run_guarded")));
    });
  }
  await t.step("reissues an interrupted legacy upload without creating a replacement Run", async () => {
    const result = await run({ skill: controlled, existing: { ...oldRun(), status: "uploading" }, dshEnabled: "false" });
    assertEquals(result.status, 200);
    assertEquals(result.body.reused, true);
    assertEquals(result.body.agentRuntime, "legacy_kernel");
    assert(typeof result.body.uploadUrl === "string");
    assert(!result.calls.some((call) => call.path.endsWith("/create_agent_run_guarded")));
  });
  for (const options of [{ runtime: "dsh" }, { manifestHash: "b".repeat(64) }, { skill: unified, runtime: "dsh" }]) {
    await t.step(`rejects changed replay snapshot ${JSON.stringify(options)}`, async () => {
      const result = await run({ skill: controlled, existing: oldRun(), ...options });
      assertEquals(result.status, 409);
      assert(!result.calls.some((call) => call.path.endsWith("/create_agent_run_guarded")));
    });
  }
});
