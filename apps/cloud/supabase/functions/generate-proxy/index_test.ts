import { assertEquals, assert } from "jsr:@std/assert@1";

let handler: (request: Request) => Promise<Response>;
const serve = Deno.serve;
Deno.serve = ((callback: typeof handler) => { handler = callback; return {}; }) as typeof Deno.serve;
try { await import("./index.ts"); } finally { Deno.serve = serve; }

async function requestService(media: "image" | "video", service: string, state: "active" | "inactive" | "unreadable") {
  const env = { SUPABASE_URL: "http://supabase.invalid", SUPABASE_PUBLISHABLE_KEY: "test-public", SUPABASE_SECRET_KEY: "test-secret", BOWERBIRD_CLOUD_MOCK: "false" };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assertEquals(url.origin, "http://supabase.invalid");
    calls.push(url.pathname);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "11111111-1111-4111-8111-111111111111" });
    if (url.pathname === "/rest/v1/rpc/ensure_daily_credits") return Response.json([{ daily_balance: 0, sub_balance: 0, topup_balance: 100 }]);
    if (url.pathname === "/rest/v1/service_costs") {
      assertEquals(url.searchParams.get("service"), `eq.${service}`);
      assertEquals(url.searchParams.get("active"), "eq.true");
      if (state === "unreadable") return Response.json({ message: "private database detail" }, { status: 500 });
      return Response.json(state === "active" ? [{ service, unit_cost: 20, parameters: {} }] : []);
    }
    // Stop at preauthorization: prove active services pass selection without any paid request.
    if (url.pathname.startsWith("/rest/v1/rpc/credit_hold_bcoin_")) return Response.json({ details: "insufficient_credits" }, { status: 400 });
    throw new Error(`Unexpected call: ${url.pathname}`);
  }) as typeof globalThis.fetch;
  try {
    const response = await handler(new Request("http://edge.invalid/generate-proxy", { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, body: JSON.stringify({
      idempotency_key: "synthetic-service-check", media, service, prompt: "Synthetic transport test", reference_images: [], ratio: "16:9",
      ...(media === "video" ? { video_options: { kind: "text2video", model_version: "seedance2.5", duration: 5, video_resolution: "480p" } } : {}),
    }) }));
    return { status: response.status, body: await response.json(), calls };
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of Object.entries(before)) { if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value); }
  }
}

Deno.test("inactive video reports unavailable, not a media mismatch, before preauthorization", async () => {
  const result = await requestService("video", "video_seedance25_480p", "inactive");
  assertEquals(result.status, 503);
  assertEquals(result.body.error.code, "not_configured");
  assertEquals(result.body.error.message, "当前云视频服务尚未开放，请选择其他生成渠道");
  assert(!result.calls.some(path => path.includes("credit_hold_bcoin")));
});

Deno.test("inactive image reports unavailable before preauthorization", async () => {
  const result = await requestService("image", "image_hd", "inactive");
  assertEquals(result.status, 503);
  assertEquals(result.body.error.code, "not_configured");
  assertEquals(result.body.error.message, "当前云图片服务暂不可用，请刷新模型列表或选择其他模型");
  assert(!result.calls.some(path => path.includes("credit_hold_bcoin")));
});

Deno.test("database lookup failure is not mistaken for an inactive or mismatched service", async () => {
  const result = await requestService("image", "image_hd", "unreadable");
  assertEquals(result.status, 500);
  assertEquals(result.body.error.code, "internal_error");
  assertEquals(result.body.error.message, "生成服务状态读取失败，请稍后重试");
  assert(!JSON.stringify(result.body).includes("private database detail"));
  assert(!result.calls.some(path => path.includes("credit_hold_bcoin")));
});

Deno.test("actual media or resolution mismatch stays a validation error", async () => {
  for (const [media, service] of [["image", "video_seedance25_480p"], ["video", "image_hd"], ["video", "video_seedance25_720p"]] as const) {
    const result = await requestService(media, service, "active");
    assertEquals(result.status, 400);
    assertEquals(result.body.error.message, "service 与生成媒体类型不匹配");
    assert(!result.calls.includes("/rest/v1/service_costs"));
  }
});

Deno.test("active Pro and Lite still reach the original preauthorization RPC", async () => {
  for (const service of ["image_hd", "image_lite", "image_pro_1k", "image_pro_15k"]) {
    const result = await requestService("image", service, "active");
    assertEquals(result.status, 402);
    assertEquals(result.body.error.code, "insufficient_credits");
    assertEquals(result.calls.filter(path => path.includes("credit_hold_bcoin")), ["/rest/v1/rpc/credit_hold_bcoin_image"]);
  }
});
