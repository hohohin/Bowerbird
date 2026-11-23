import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { libraryVisualCredits, libraryVisualVideoKey, parseLibraryVisualVideo } from "../../../cloud/supabase/functions/_shared/library-visual.ts";
import { describeLibraryVisual, libraryVisualMessages, loadLibraryVisualMedia, parseLibraryVisualResult } from "./library-visual.ts";
import type { WorkerFetch } from "../cloud-generation/runtime.ts";
import { probeSilentH264Mp4 } from "../cloud-generation/video.ts";
import { configFromEnv, runUnderstandWorker } from "./runtime.ts";

const payload = new Uint8Array([1, 2, 3]);
function response(bytes: Uint8Array, status = 200, requestId?: string): Awaited<ReturnType<WorkerFetch>> {
  return {
    status,
    ok: status < 300,
    headers: { get: name => name === "x-request-id" ? requestId ?? null : null },
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
    text: async () => new TextDecoder().decode(bytes),
    body: {
      getReader() {
        let read = false;
        return {
          async read() { if (read) return { done: true }; read = true; return { done: false, value: bytes }; },
          async cancel() {},
        };
      },
    },
  };
}
const jsonResponse = (body: unknown, status: number, requestId: string) =>
  response(new TextEncoder().encode(JSON.stringify(body)), status, requestId);
const video = {
  mime: "video/mp4", sha256: createHash("sha256").update(payload).digest("hex"),
  bytes: payload.length, duration_ms: 5000, start_ms: 7200000, end_ms: 7205000, source_duration_ms: 7205000,
};

test("allows a bounded last segment beyond two hours and rounds once from original duration", () => {
  assert.deepEqual(parseLibraryVisualVideo(video), video);
  assert.equal(libraryVisualCredits(7200000, 3), 6);
  assert.equal(libraryVisualCredits(video.source_duration_ms, 3), 7);
  assert.throws(() => parseLibraryVisualVideo({ ...video, start_ms: 0 }), /invalid_library_visual_video/);
  assert.throws(() => parseLibraryVisualVideo({ ...video, duration_ms: 8000 }), /invalid_library_visual_video/);
  assert.throws(() => parseLibraryVisualVideo({ ...video, mime: "video/webm" }), /invalid_library_visual_video/);
  assert.throws(() => libraryVisualVideoKey("../other/asset"), /invalid_library_visual_job_id/);
});

test("checks the uploaded bytes before probing and rejects mismatched or oversized media", async () => {
  const jobId = "00000000-0000-0000-0000-000000000001";
  const url = `https://storage.example/storage/v1/object/sign/generation-temp/${libraryVisualVideoKey(jobId)}?token=opaque`;
  const fetch: WorkerFetch = async () => response(payload);
  const manifest = parseLibraryVisualVideo(video);
  const probe = async () => ({ width: 480, height: 270, fps: 1, durationMs: 5000 });
  assert.deepEqual(await loadLibraryVisualMedia(fetch, url, jobId, manifest, probe), payload);
  await assert.rejects(() => loadLibraryVisualMedia(fetch, url.replace(jobId, "00000000-0000-0000-0000-000000000002"), jobId, manifest, probe), /library_visual_signed_url_invalid/);
  await assert.rejects(() => loadLibraryVisualMedia(fetch, url, jobId, { ...manifest, sha256: "a".repeat(64) }, async () => {
    assert.fail("do not probe an unexpected object");
  }), /library_visual_upload_mismatch/);
  await assert.rejects(() => loadLibraryVisualMedia(fetch, url, jobId, manifest, async () => ({ ...await probe(), height: 481 })), /library_visual_media_invalid/);
  await assert.rejects(() => loadLibraryVisualMedia(fetch, url, jobId, manifest, async () => ({ ...await probe(), durationMs: 5300 })), /library_visual_media_invalid/);
});

test("uses the configured vision model and one silent video message in the provider request", async () => {
  const result = await describeLibraryVisual(async (url, request) => {
    assert.equal(url, "https://ark.example/chat/completions");
    assert.equal(request?.redirect, "error");
    assert.equal(request?.headers?.authorization, "Bearer test-only");
    const body = JSON.parse(String(request?.body));
    assert.equal(body.model, "visual-model");
    assert.equal(body.max_tokens, 500);
    assert.equal(body.messages[0].content[0].video_url.fps, 0.2);
    assert.equal(body.messages[0].content[0].video_url.url, "data:video/mp4;base64,AQID");
    return jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "蓝色球场" } }] }, 200, "request-123");
  }, { baseUrl: "https://ark.example", apiKey: "test-only", model: "visual-model" }, payload);
  assert.equal(result.text, "蓝色球场");
  assert.equal(result.requestId, "request-123");
});

test("a provider timeout is ambiguous and retains usable request and usage evidence", async () => {
  await assert.rejects(() => describeLibraryVisual(async () => jsonResponse({ usage: { prompt_tokens: 22 } }, 504, "timeout-req"),
    { baseUrl: "https://ark.example", apiKey: "test-only", model: "visual-model" }, payload), (error: unknown) => {
    assert.equal((error as { ambiguous: boolean }).ambiguous, true);
    assert.deepEqual((error as { receipt: object }).receipt, { providerId: null, model: null, usage: { prompt_tokens: 22 }, requestId: "timeout-req" });
    return true;
  });
});

function nativeSample(audio: boolean): Uint8Array {
  return execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32:r=2:d=1",
    ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"] : ["-an"]),
    "-c:v", "libx264", "-shortest", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1",
  ]);
}

test("native FFprobe accepts silent H.264 and rejects the same container with audio", async () => {
  assert.deepEqual(await probeSilentH264Mp4(nativeSample(false)), { width: 32, height: 32, durationMs: 1000, fps: 2 });
  await assert.rejects(() => probeSilentH264Mp4(nativeSample(true)), /invalid_silent_video_media/);
});

test("running Worker verifies the staged video and fences submission before provider POST", async () => {
  const bytes = nativeSample(false);
  const jobId = "00000000-0000-0000-0000-000000000001";
  const leaseId = "00000000-0000-0000-0000-000000000002";
  const sha = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
  const manifest = parseLibraryVisualVideo({ mime: "video/mp4", bytes: bytes.length, sha256: sha(bytes), duration_ms: 1000,
    start_ms: 0, end_ms: 1000, source_duration_ms: 1000 });
  const controlUrl = "https://control.example/understand-worker";
  const mediaUrl = `https://storage.example/storage/v1/object/sign/generation-temp/${libraryVisualVideoKey(jobId)}?token=opaque`;
  const stop = { requested: false };
  const events: string[] = [];
  const fetch: WorkerFetch = async (url, request) => {
    if (url === mediaUrl) { events.push("download"); return response(bytes); }
    if (url === "https://ark.example/chat/completions") {
      events.push("provider");
      return jsonResponse({ id: "provider-1", usage: { prompt_tokens: 11 },
        choices: [{ finish_reason: "stop", message: { content: "蓝色画面" } }] }, 200, "provider-request");
    }
    assert.equal(url, controlUrl);
    const body = JSON.parse(String(request?.body));
    events.push(body.action);
    if (body.action === "fail" || body.action === "outcome_unknown") stop.requested = true;
    if (body.action === "claim") {
      assert.equal(body.libraryVisualCapable, true);
      return jsonResponse({ job: { id: jobId, inputManifestHash: sha(JSON.stringify(manifest)) },
        lease: { leaseId, leaseSeconds: 90 }, libraryVisual: { videoUrl: mediaUrl, video: manifest } }, 200, "claim");
    }
    if (body.action === "finish") {
      stop.requested = true;
      assert.equal(body.resultText, "蓝色画面");
      assert.equal(body.providerReceipt.requestId, "provider-request");
      assert.equal(body.providerReceipt.usage.prompt_tokens, 11);
      assert.equal(body.providerReceipt.sourceSegmentMs, 1000);
    }
    assert.equal(body.libraryVisual, true);
    assert.equal(body.leaseId, leaseId);
    return jsonResponse({ status: "ok", leaseExpiresAt: new Date(Date.now() + 90000).toISOString() }, 200, "control");
  };
  await runUnderstandWorker(configFromEnv({
    UNDERSTAND_CONTROL_URL: controlUrl, UNDERSTAND_WORKER_TOKEN: "test-only", ARK_API_KEY: "test-only",
    ARK_VISION_MODEL: "image", ARK_LIBRARY_VISUAL_MODEL: "visual", ARK_BASE_URL: "https://ark.example",
    UNDERSTAND_HEARTBEAT_INTERVAL_MS: "100",
  }), fetch, stop);
  assert.deepEqual(events.filter(action => action !== "heartbeat"), ["claim", "download", "submitted", "provider", "finish"]);
});

test("keeps usage counters without retaining unrelated provider text", () => {
  const valid = {
    id: "response-1", model: "doubao-vision", choices: [{ finish_reason: "stop", message: { content: " 蓝色球场 " } }],
    usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2, video_tokens: 10 }, secret: "drop" },
  };
  assert.deepEqual(parseLibraryVisualResult(valid), {
    text: "蓝色球场", providerId: "response-1", model: "doubao-vision",
    usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2, video_tokens: 10 } },
  });
  assert.throws(() => parseLibraryVisualResult({ ...valid, choices: [{ ...valid.choices[0], finish_reason: "length" }] }), /library_visual_result_invalid/);
  assert.deepEqual(libraryVisualMessages(payload)[0].content.map(item => item.type), ["video_url", "text"]);
});
