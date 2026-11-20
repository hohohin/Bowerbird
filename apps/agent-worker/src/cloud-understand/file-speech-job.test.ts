import { deepEqual, equal, rejects } from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { WorkerFetch } from "../cloud-generation/runtime.ts";
import { runFileSpeechJob } from "./file-speech-job.ts";
import { configFromEnv, runUnderstandWorker } from "./runtime.ts";

const jobId = "b1e77d80-9da8-4ff5-b455-bb99879e88f2";
const url = `https://project.supabase.co/storage/v1/object/sign/generation-temp/understand/${jobId}/inputs/speech-audio.mp3?token=signed`;
const bytes = new Uint8Array([3, 1, 4]);
const audio = {
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  duration_ms: 7_199_050,
  source_duration_ms: 7_199_000,
};
const auth = { apiKey: "mock-secret", mock: false };
const probe = async () => 7_199.05;
const newClaim = { submittedAt: null, audioUrl: url, sourceDurationMs: audio.source_duration_ms };
const resumedClaim = { submittedAt: "original", audioUrl: null, sourceDurationMs: audio.source_duration_ms };

const FetchResponse = (globalThis as unknown as {
  Response: new (body: Uint8Array | string | null, options?: { headers: Record<string, string> }) => Awaited<ReturnType<WorkerFetch>>;
}).Response;

function fixture() {
  const actions: Record<string, unknown>[] = [];
  const providerCalls: { action: string; id: string | undefined }[] = [];
  let reads = 0;
  let queried = false;
  const fetch: WorkerFetch = async (address, request) => {
    if (address === url) {
      reads++;
      return new FetchResponse(bytes);
    }
    const action = address.split("/").at(-1)!;
    providerCalls.push({ action, id: request?.headers?.["X-Api-Request-Id"] });
    if (action === "submit") throw new Error("server accepted but connection was lost");
    if (!queried) {
      queried = true;
      return new FetchResponse(null, { headers: { "x-api-status-code": "20000002" } });
    }
    return new FetchResponse(JSON.stringify({ result: {
      text: "尾段可被索引",
      utterances: [{ text: "尾段可被索引", start_time: 7_198_000, end_time: 7_198_999 }],
    } }), { headers: { "x-api-status-code": "20000000" } });
  };
  return {
    actions, providerCalls, fetch,
    reads: () => reads,
    control: async (body: Record<string, unknown>) => { actions.push(body); return {}; },
  };
}

test("missing submission reply and process replacement recover only by the original provider UUID", async () => {
  const { actions, providerCalls, fetch, reads, control } = fixture();
  await runFileSpeechJob(audio, newClaim, { jobId, leaseId: "first" }, auth, control, fetch, probe);
  await runFileSpeechJob(null, resumedClaim, { jobId, leaseId: "second" }, auth, control, fetch, probe);
  await runFileSpeechJob(null, resumedClaim, { jobId, leaseId: "third" }, auth, control, fetch, probe);
  deepEqual(providerCalls, ["submit", "query", "query"].map(action => ({ action, id: jobId })));
  deepEqual(actions.map(item => item.action), ["submitted", "defer_file_speech", "defer_file_speech", "file_speech_finish"]);
  equal(reads(), 1);
  const result = JSON.parse(String(actions.at(-1)?.resultText));
  equal(result.text, "尾段可被索引");
  equal(result.utterances[0].endMs, 7_198_999);
});

test("lost submit-fence acknowledgement never authorizes a provider POST", async () => {
  const { fetch, providerCalls } = fixture();
  await rejects(() => runFileSpeechJob(audio, newClaim, { jobId, leaseId: "first" },
    auth, async () => { throw new Error("fence acknowledgement lost"); }, fetch, probe), /acknowledgement lost/);
  equal(providerCalls.length, 0);
});

test("replacement audio is rejected before the submit fence", async () => {
  const { actions, fetch, control, providerCalls } = fixture();
  await runFileSpeechJob({ ...audio, sha256: "0".repeat(64) }, newClaim,
    { jobId, leaseId: "first" }, auth, control, fetch, probe);
  deepEqual(actions.map(item => item.action), ["file_speech_fail"]);
  equal(providerCalls.length, 0);
});

test("a mock worker defers a submitted recording without replacing its transcript", async () => {
  const { actions, fetch, control, providerCalls } = fixture();
  await runFileSpeechJob(null, resumedClaim,
    { jobId, leaseId: "recovered" }, { mock: true }, control, fetch, probe);
  deepEqual(actions.map(item => item.action), ["defer_file_speech"]);
  equal(providerCalls.length, 0);
});

test("runtime reclaims a recording after restart without signing or reading either temporary object", async () => {
  const stop = { requested: false };
  const actions: string[] = [];
  const providerCalls: string[] = [];
  const controlUrl = "https://worker.test/control";
  const config = configFromEnv({
    UNDERSTAND_CONTROL_URL: controlUrl, UNDERSTAND_WORKER_TOKEN: "mock",
    ARK_API_KEY: "unused", ARK_VISION_MODEL: "unused", DOUBAO_FILE_SPEECH_API_KEY: "mock",
    UNDERSTAND_POLL_INTERVAL_MS: "1", UNDERSTAND_HEARTBEAT_INTERVAL_MS: "1",
  });
  const json = (body: unknown) => new FetchResponse(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fetch: WorkerFetch = async (address, request) => {
    if (address === controlUrl) {
      const body = JSON.parse(String(request?.body));
      actions.push(body.action);
      if (body.action === "claim") {
        equal(body.fileSpeechCapable, true);
        stop.requested = true;
        return json({ job: { id: jobId }, lease: { leaseId: "restart", leaseSeconds: 90 }, fileSpeech: resumedClaim });
      }
      if (body.action === "file_speech_finish") {
        equal(body.jobId, jobId);
        equal(body.leaseId, "restart");
        equal(JSON.parse(body.resultText).text, "");
      }
      return json({});
    }
    providerCalls.push(address);
    return new FetchResponse(null, { headers: { "x-api-status-code": "20000003" } });
  };
  await runUnderstandWorker(config, fetch, stop);
  deepEqual(providerCalls, ["https://openspeech.bytedance.com/api/v3/auc/bigmodel/query"]);
  deepEqual(actions.filter(action => action !== "heartbeat"), ["claim", "file_speech_finish"]);
});
