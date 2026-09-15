import { test } from "node:test";
import assert from "node:assert/strict";
import { ArkVideoClient, ArkVideoError, type VideoFetch } from "./ark-video.ts";
import { arkVideoBody, SEEDANCE_MODEL, validateVideoInput, videoReservationTokens, type VideoInput } from "../../../cloud/supabase/functions/_shared/video-contract.ts";

const input = (): VideoInput => ({ schema_version: 1, media: "video", prompt: "蓝色玻璃球在白色桌面缓慢旋转，无文字", ratio: "16:9", reference_images: [], reference_videos: [], video_options: { model_version: "seedance2.5", kind: "text2video", duration: 4, video_resolution: "480p", generate_audio: false } });
function fixture(replies: Array<{ status: number; value: unknown } | Error>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetch: VideoFetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected request");
    if (reply instanceof Error) throw reply;
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, text: async () => JSON.stringify(reply.value) };
  };
  return { client: new ArkVideoClient("test-only", fetch), calls };
}
test("domestic model and four-second strong body never inherit CLI/image defaults", () => {
  const body = arkVideoBody(input());
  assert.equal(body.model, SEEDANCE_MODEL);
  assert.equal(body.duration, 4); assert.equal(body.ratio, "16:9");
  assert.equal(body.resolution, "480p"); assert.equal(body.generate_audio, false);
  assert.equal(body.output_format, "mp4"); assert.equal("tools" in body, false);
  assert.ok(videoReservationTokens(input()) >= 38_430);
  const weak = input(); weak.prompt += " --dur 30";
  assert.throws(() => arkVideoBody(weak), /parameters_forbidden/);
});
test("Cloud frame roles preserve order and reject unsupported ratio; supports 1080p", () => {
  const value = input(); value.video_options.kind = "frames2video"; value.video_options.video_resolution = "1080p";
  value.reference_images = [{ mime: "image/png", base64: "Zmlyc3Q=" }, { mime: "image/png", base64: "bGFzdA==" }];
  assert.throws(() => validateVideoInput(value), /adaptive/);
  value.ratio = null;
  const body = arkVideoBody(value);
  assert.equal(body.ratio, "adaptive");
  assert.deepEqual(body.content.slice(1).map(item => "role" in item ? item.role : undefined), ["first_frame", "last_frame"]);
});
test("multimodal reference is explicit and no client URL enters provider payload", () => {
  const value = input(); value.video_options.kind = "multimodal2video";
  value.reference_videos = [{ object_key: "user/input.mp4", bytes: 123 }];
  assert.throws(() => arkVideoBody(value), /urls_invalid/);
  const body = arkVideoBody(value, ["https://trusted.example/signed"]);
  assert.equal(body.omni_reference_task_type, "reference");
  assert.equal(body.content[1].type, "video_url");
});
test("submission is exactly one POST on timeout, 5xx, or malformed successful response", async () => {
  for (const reply of [new Error("timeout"), { status: 500, value: {} }, { status: 200, value: {} }]) {
    const h = fixture([reply]);
    await assert.rejects(() => h.client.submit(input()), (error: unknown) => error instanceof ArkVideoError && !error.definitive);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].method, "POST");
    assert.ok(h.calls[0].url.startsWith("https://ark.cn-beijing.volces.com/"));
  }
});
test("explicit rejection is distinguished from an unknown submission", async () => {
  const h = fixture([{ status: 403, value: { error: { code: "AccessDenied" } } }]);
  await assert.rejects(() => h.client.submit(input()), (error: unknown) => error instanceof ArkVideoError && error.definitive);
});
test("query preserves token usage for trusted server settlement", async () => {
  const h = fixture([{ status: 200, value: { id: "task-1", status: "succeeded", content: { video_url: "https://result.example/video.mp4" }, usage: { completion_tokens: 38430 } } }]);
  assert.equal((await h.client.query("task-1")).completionTokens, 38430);
  assert.equal(h.calls[0].method, "GET");
});
test("cancel never issues DELETE for running or completed tasks", async () => {
  for (const status of ["running", "failed", "expired", "cancelled"]) {
    const h = fixture([{ status: 200, value: { id: "task-1", status } }]);
    assert.equal((await h.client.inspectAfterLocalCancellation("task-1")).status, status);
    assert.deepEqual(h.calls.map(call => call.method), ["GET"]);
  }
});
test("queued cancellation retains the upstream task because DELETE is not conditional", async () => {
  const h = fixture([{ status: 200, value: { id: "task-1", status: "queued" } }]);
  assert.equal((await h.client.inspectAfterLocalCancellation("task-1")).status, "queued");
  assert.deepEqual(h.calls.map(call => call.method), ["GET"]);
});
