import assert from "node:assert/strict";

let handler: (request: Request) => Promise<Response>;
const serve = Deno.serve;
try {
  Deno.serve = ((callback: typeof handler) => { handler = callback; return {}; }) as typeof Deno.serve;
  await import("./index.ts");
} finally {
  Deno.serve = serve;
}

Deno.test("original queue claims and cleanup work with both optional visual migrations absent", async () => {
  const env = { UNDERSTAND_WORKER_TOKEN: "fixture", SUPABASE_SECRET_KEY: "fixture", SUPABASE_URL: "https://supabase.invalid" };
  const before = new Map(Object.keys(env).map(key => [key, Deno.env.get(key)]));
  const original = globalThis.fetch;
  const paths: string[] = [];
  let legacyJob = true;
  try {
    for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
    globalThis.fetch = (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, env.SUPABASE_URL);
      const endpoint = url.pathname.split("/").pop()!;
      paths.push(endpoint);
      let response;
      if (endpoint === "claim_understand_job") {
        response = Response.json(legacyJob ? { id: "old", operation: "caption", request_object_key: "old-input" } : null);
      } else if (endpoint === "old-input") {
        response = Response.json({ signedURL: "/object/sign/generation-temp/old-input?token=fixture" });
      } else if (["control_library_visual_segment", "control_library_shot"].includes(endpoint)) {
        response = Response.json({ code: "PGRST202", message: "function absent" }, { status: 404 });
      } else if (["library_shot_jobs", "library_visual_segments"].includes(endpoint)) {
        response = Response.json({ code: "PGRST205", message: "table absent" }, { status: 404 });
      } else {
        assert.ok(["reconcile_stale_understand_jobs", "cleanup_classification", "expire_unsubmitted_text_jobs", "understand_jobs"].includes(endpoint));
        response = Response.json([]);
      }
      return Promise.resolve(response);
    };
    const call = async (action: string) => {
      paths.length = 0;
      const response = await handler(new Request("https://edge.invalid/understand-worker", {
        method: "POST", headers: { authorization: "Bearer fixture", "x-worker-id": "local" },
        body: JSON.stringify({ action, libraryVisualCapable: true, libraryShotCapable: true, libraryVisualCleanup: true, libraryShotCleanup: true }),
      }));
      assert.equal(response.status, 200);
      return await response.json();
    };
    assert.equal((await call("claim")).job.id, "old");
    assert.deepEqual(paths, ["reconcile_stale_understand_jobs", "claim_understand_job", "old-input"]);
    legacyJob = false;
    assert.deepEqual(await call("claim"), { job: null });
    assert.deepEqual(paths.slice(-2), ["control_library_shot", "control_library_visual_segment"]);
    assert.deepEqual(await call("cleanup_expired"), { expiredJobs: 0, removedObjects: 0 });
    assert.deepEqual(paths.slice(-2), ["library_shot_jobs", "library_visual_segments"]);
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of before) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
