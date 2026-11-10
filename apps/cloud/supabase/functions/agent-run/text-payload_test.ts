import { assert, assertEquals } from "jsr:@std/assert@1";

// Run both real Edge handlers against isolated Auth/Storage/PostgREST responses.
const handlers: Array<(request: Request) => Promise<Response>> = [];
const serve = Deno.serve;
Deno.serve = ((handler: typeof handlers[number]) => { handlers.push(handler); return {}; }) as typeof Deno.serve;
try {
  await import("./index.ts");
  await import("../agent-worker/index.ts");
} finally { Deno.serve = serve; }

Deno.test("long Agent input, checkpoint and result pass Edge without losing identity or text", async () => {
  const env = { SUPABASE_URL: "http://supabase.invalid", SUPABASE_PUBLISHABLE_KEY: "test-key",
    SUPABASE_SECRET_KEY: "test-secret", AGENT_WORKER_TOKEN: "test-worker" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  const originalFetch = globalThis.fetch;
  const source = '中文🙂\\"\n'.repeat(1700000) + "最后一行";
  const manifest = { schemaVersion: 1, goal: "保留原文".repeat(2000), textRewrite: { source }, references: [],
    htmlOutput: { viewport: { widthCssPx: 1080, heightCssPx: 1440, deviceScaleFactor: 1 }, capture: { mode: "full_page" }, background: "opaque" } };
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const hash = async (value: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value))).map(v => v.toString(16).padStart(2, "0")).join("");
  let bytes = encode(manifest), updated = 0, checkpointCommitted = 0;
  const run = { id: "11111111-1111-4111-8111-111111111111", user_id: "user", billing: { auth_user_id: "user" }, conversation_id: "conversation", status: "uploading",
    skill_id: "bowerbird-unified-agent", input_count: 0, input_manifest_hash: await hash(bytes), request_object_key: "runs/input.json",
    visual_profile_id: null, visual_profile_version: null, visual_profile_hash: null,
    lease_id: "lease", lease_expires_at: new Date(Date.now() + 60000).toISOString() };
  let savedEvents: Array<{ display_payload: { text: string } }> = [];
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assertEquals(url.origin, "http://supabase.invalid");
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "user" });
    if (url.pathname.startsWith("/storage/v1/object/")) return new Response(bytes, { headers: { "content-type": "application/json" } });
    if (url.pathname === "/rest/v1/agent_runs") {
      if (init?.method === "PATCH") { updated++; return new Response(null, { status: 204 }); }
      return Response.json([run]);
    }
    if (url.pathname === "/rest/v1/rpc/commit_agent_checkpoint") { checkpointCommitted++; return Response.json({}); }
    if (url.pathname === "/rest/v1/agent_events") {
      savedEvents = JSON.parse(String(init?.body)); return new Response(null, { status: 201 });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  }) as typeof fetch;
  const call = (worker: boolean, body: Record<string, unknown>) => handlers[worker ? 1 : 0](new Request("http://edge.invalid/agent", {
    method: "POST", headers: { authorization: `Bearer ${worker ? "test-worker" : "user"}`, "x-worker-id": "isolated", "content-type": "application/json" },
    body: JSON.stringify({ runId: run.id, leaseId: run.lease_id, ...body }),
  }));
  try {
    assert(bytes.length > 64 * 1024);
    const enqueued = await call(false, { action: "enqueue" });
    assertEquals(enqueued.status, 200, await enqueued.text()); assertEquals(updated, 1);
    run.input_manifest_hash = "0".repeat(64);
    assertEquals((await call(false, { action: "enqueue" })).status, 400); assertEquals(updated, 1);
    for (const invalid of [{ ...manifest, textRewrite: { source: " " } }, { ...manifest, textRewrite: undefined, extra: source }]) {
      bytes = encode(invalid); run.input_manifest_hash = await hash(bytes);
      assertEquals((await call(false, { action: "enqueue" })).status, 400); assertEquals(updated, 1);
    }
    bytes = encode({ schemaVersion: 1, input: manifest, textResult: source, phase: "succeeded" });
    assert(bytes.length > 1024 * 1024);
    const checkpointHash = await hash(bytes);
    const committed = await call(true, { action: "checkpoint_commit", checkpointHash, snapshotSchemaVersion: 1, progress: 100 });
    assertEquals(committed.status, 200, await committed.text()); assertEquals(checkpointCommitted, 1);
    assertEquals((await call(true, { action: "checkpoint_commit", checkpointHash: "0".repeat(64), snapshotSchemaVersion: 1 })).status, 409);
    assertEquals(checkpointCommitted, 1);
    const result = await call(true, { action: "events", events: [{ seq: 90, type: "text.result", progress: 100, displayPayload: { schemaVersion: 1, text: source } }] });
    assertEquals(result.status, 200, await result.text()); assertEquals(savedEvents[0].display_payload.text, source);
    run.lease_id = "expired";
    assertEquals((await call(true, { action: "checkpoint_commit", leaseId: "lease", checkpointHash, snapshotSchemaVersion: 1 })).status, 409);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value); }
  }
});
