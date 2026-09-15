import { test } from "node:test";
import assert from "node:assert/strict";
import { executeVideo } from "./video.ts";
import type { WorkerFetch } from "./runtime.ts";
import type { VideoInput } from "../../../cloud/supabase/functions/_shared/video-contract.ts";

const input = (): VideoInput => ({ schema_version: 1, media: "video", prompt: "test", ratio: "16:9", reference_images: [], reference_videos: [], video_options: { kind: "text2video", model_version: "seedance2.5", duration: 4, video_resolution: "480p" } });
function fixture(options: { failSave?: boolean; timeout?: boolean; status?: string; cancel?: boolean } = {}) {
  const http: Array<{ url: string; method: string }> = [];
  const actions: Array<Record<string, unknown>> = [];
  const fetch: WorkerFetch = async (url, req) => {
    const method = req?.method ?? "GET"; http.push({ url, method });
    if (method === "POST" && options.timeout) throw new Error("timeout");
    const value = method === "POST" ? { id: "upstream-one" } : { id: "upstream-one", status: options.status ?? "running", content: { video_url: "https://result.example/video.mp4" }, usage: { completion_tokens: 38430 } };
    let read = false;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(value), arrayBuffer: async () => new ArrayBuffer(4), body: { getReader: () => ({ read: async () => { if (read) return { done: true }; read = true; return { done: false, value: new Uint8Array([1,2,3,4]) }; }, cancel: async () => {} }) } };
  };
  const control = async (body: Record<string, unknown>) => {
    actions.push(body);
    if (body.providerRequestId && options.failSave) throw new Error("control unavailable");
    if (body.action === "heartbeat") return { cancelRequested: options.cancel ?? false };
    if (body.action === "output_upload") return { uploadUrl: "https://storage.example/output", objectKey: "jobs/local/outputs/result.mp4" };
    return {};
  };
  return { fetch, control, http, actions };
}
const probe = async () => ({ duration: 4, width: 864, height: 480, fps: 24 });

test("durable submit boundary precedes exactly one POST; pending result defers", async () => {
  const f = fixture();
  await executeVideo(input(), { id: "local", leaseId: "lease" }, "fake", f.control, f.fetch, probe);
  assert.deepEqual(f.http.map(c => c.method), ["POST", "GET"]);
  assert.deepEqual(f.actions.map(a => a.action), ["heartbeat", "submitted", "submitted", "video_defer"]);
  assert.equal(f.actions[2].providerRequestId, "upstream-one");
});
test("restart with saved ID queries same task without submitting or refunding", async () => {
  const f = fixture();
  await executeVideo(input(), { id: "local", leaseId: "new-lease", upstreamTaskId: "upstream-one" }, "fake", f.control, f.fetch, probe);
  assert.deepEqual(f.http.map(c => c.method), ["GET"]);
  assert.ok(f.http[0].url.endsWith("/upstream-one"));
  assert.deepEqual(f.actions.map(a => a.action), ["video_defer"]);
});
test("failed ID persistence retains unknown state without a second POST or refund", async () => {
  const f = fixture({ failSave: true });
  await executeVideo(input(), { id: "local", leaseId: "lease" }, "fake", f.control, f.fetch, probe);
  assert.deepEqual(f.http.map(c => c.method), ["POST"]);
  assert.ok(!f.actions.some(a => a.action === "fail" || a.action === "cancelled"));
});
test("transport timeout becomes outcome_unknown; pre-submit cancellation makes no request", async () => {
  const f = fixture({ timeout: true });
  await executeVideo(input(), { id: "local", leaseId: "lease" }, "fake", f.control, f.fetch, probe);
  assert.deepEqual(f.http.map(c => c.method), ["POST"]);
  assert.equal(f.actions.at(-1)?.action, "outcome_unknown");
  const cancelled = fixture({ cancel: true });
  await executeVideo(input(), { id: "local", leaseId: "lease" }, "fake", cancelled.control, cancelled.fetch, probe);
  assert.equal(cancelled.http.length, 0); assert.equal(cancelled.actions.at(-1)?.action, "cancelled");
});
test("verified download and upload precede settlement using actual provider tokens", async () => {
  const f = fixture({ status: "succeeded" });
  await executeVideo(input(), { id: "local", leaseId: "lease", upstreamTaskId: "upstream-one" }, "fake", f.control, f.fetch, probe);
  assert.deepEqual(f.http.map(c => c.method), ["GET", "GET", "PUT"]);
  const finish = f.actions.at(-1)!;
  assert.equal(finish.action, "finish"); assert.equal(finish.completionTokens, 38430); assert.equal(finish.bytes, 4);
});
test("failed output validation keeps provider result recoverable and never refunds", async () => {
  const f = fixture({ status: "succeeded" });
  await executeVideo(input(), { id: "local", leaseId: "lease", upstreamTaskId: "upstream-one" }, "fake", f.control, f.fetch, async () => { throw new Error("invalid mp4"); });
  assert.ok(!f.actions.some(a => a.action === "fail" || a.action === "finish"));
  assert.equal(f.actions.at(-1)?.action, "video_defer");
});
test("invalid mode/image/reference input is rejected before chargeable submission", async () => {
  const f = fixture(); const invalid = input(); invalid.video_options.duration = 31;
  await executeVideo(invalid, { id: "local", leaseId: "lease" }, "fake", f.control, f.fetch, probe);
  assert.equal(f.http.length, 0); assert.equal(f.actions.at(-1)?.action, "fail");
});
