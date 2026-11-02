import { assert, assertEquals } from "jsr:@std/assert@1";

type Handler = (request: Request) => Promise<Response>;
let handler: Handler;
const serve = Deno.serve;
Deno.serve = ((callback: Handler) => { handler = callback; return {}; }) as typeof Deno.serve;
try { await import("./index.ts"); } finally { Deno.serve = serve; }
const generate = handler!;
Deno.serve = ((callback: Handler) => { handler = callback; return {}; }) as typeof Deno.serve;
try { await import("../generation-worker/index.ts"); } finally { Deno.serve = serve; }
const worker = handler!;

Deno.test("audio manifests upload privately, freeze input, replay once, and restrict signed worker reads", async () => {
  const env = { SUPABASE_URL: "https://storage.invalid", SUPABASE_PUBLISHABLE_KEY: "public-test", SUPABASE_SECRET_KEY: "secret-test", BOWERBIRD_CLOUD_MOCK: "false", GENERATION_WORKER_TOKEN: "worker-test" };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  const original = globalThis.fetch;
  const id = "11111111-1111-4111-8111-111111111111";
  let job: Record<string, unknown> | null = null, manifest = "", uploaded = false, queues = 0;
  const holds: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assertEquals(url.origin, "https://storage.invalid");
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const raw = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.text() : "";
    const body = raw ? JSON.parse(raw) : {};
    const path = url.pathname;
    if (path === "/auth/v1/user") return Response.json({ id });
    if (path.endsWith("/rpc/ensure_daily_credits")) return Response.json([{ daily_balance: 0, sub_balance: 0, topup_balance: 1000 }]);
    if (path.endsWith("/service_costs")) return Response.json([{ service: "video_seedance25_480p", active: true, unit_cost: 0 }]);
    if (path.endsWith("/rpc/credit_hold_bcoin_video")) { holds.push(body); return Response.json([{ hold_id: id, estimated_amount: 110, pricing_version: 20261023 }]); }
    if (path.endsWith("/credit_holds")) return Response.json({ video_pricing_snapshot: { max_tokens: 100, provider_cny_per_million: 70 } });
    if (path.endsWith("/rpc/reserve_managed_usage")) return Response.json([{ already_reserved: false }]);
    if (path.endsWith("/generation_jobs")) {
      if (method === "POST") { job = { ...body, status: "uploading" }; return Response.json(job); }
      return Response.json(job ? [job] : []);
    }
    if (path.endsWith("/rpc/enqueue_generation_job")) { queues++; job!.status = "queued"; return Response.json(job); }
    if (path.endsWith("/request.json")) { manifest = raw; return Response.json({ Key: path }); }
    if (path.endsWith("/object/list/generation-temp")) return Response.json(uploaded ? [{ name: "audio-0.wav", metadata: { size: 32044 } }] : []);
    if (path.includes("/object/upload/sign/")) return Response.json({ url: `/object/upload/sign/generation-temp/jobs/${id}/inputs/audio-0.wav?token=synthetic` });
    if (path.includes("/object/sign/")) return Response.json({ signedURL: `/object/sign/generation-temp/jobs/${id}/inputs/audio-0.wav?token=synthetic` });
    throw new Error(`Unexpected test request: ${path}`);
  }) as typeof fetch;
  const request = (body: unknown, target = generate) => target(new Request("https://edge.invalid", { method: "POST", headers: { authorization: `Bearer ${target === worker ? "worker-test" : "user-test"}`, "x-worker-id": "isolated", "content-type": "application/json" }, body: JSON.stringify(body) }));
  const payload = { idempotency_key: "audio-case", media: "video", service: "video_seedance25_480p", prompt: "按音乐生成", ratio: "16:9", reference_images: [], reference_videos: [], reference_audios: [{ object_key: "untrusted/path.wav", bytes: 32044, duration: 2, mime: "audio/wav" }], video_options: { kind: "multimodal2video", model_version: "seedance2.5", duration: 5, video_resolution: "480p" } };
  try {
    assertEquals(await (await request({ action: "video_capabilities" })).json(), { reference_audio: true });
    assertEquals(holds.length, 0);
    let response = await request(payload); assertEquals(response.status, 202);
    const pending = await response.json();
    assertEquals(pending.reference_uploads[0].kind, "audio");
    assertEquals(pending.reference_uploads[0].object_key, `jobs/${id}/inputs/audio-0.wav`);
    assertEquals(queues, 0); assertEquals(job!.input_count, 1);
    const frozen = manifest;
    assert(!manifest.includes("untrusted"));
    assertEquals(holds[0].p_has_video, false);
    uploaded = true;
    response = await request(payload); assertEquals(response.status, 202);
    assertEquals((await response.json()).status, "queued"); assertEquals(queues, 1); assertEquals(manifest, frozen);
    await request(payload); assertEquals(queues, 1);
    response = await request({ ...payload, reference_audios: [{ ...payload.reference_audios[0], duration: 3 }] }); assertEquals(response.status, 409);
    const beforeInvalid = holds.length;
    response = await request({ ...payload, reference_audios: [{ ...payload.reference_audios[0], duration: 31 }] }); assertEquals(response.status, 400);
    assertEquals(holds.length, beforeInvalid);
    Object.assign(job!, { status: "leased", lease_id: "lease" });
    const read = { action: "video_input_url", jobId: id, leaseId: "lease", objectKey: `jobs/${id}/inputs/audio-0.wav`, bytes: 32044 };
    assertEquals((await request(read, worker)).status, 200);
    assertEquals((await request({ ...read, objectKey: "jobs/other/inputs/audio-0.wav" }, worker)).status, 400);
    assertEquals((await request({ ...read, bytes: 15 * 1024 * 1024 + 1 }, worker)).status, 400);
    assertEquals((await request({ ...read, leaseId: "wrong" }, worker)).status, 409);
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of Object.entries(before)) { if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value); }
  }
});
