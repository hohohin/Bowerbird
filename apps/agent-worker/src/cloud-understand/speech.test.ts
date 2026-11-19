import { test } from "node:test";
import { deepEqual, equal, throws, rejects } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { configFromEnv, runUnderstandWorker } from "./runtime.ts";
import { normalizeSpeech, recognizeSpeech } from "./speech.ts";
import { validateReplication, replicationService } from "../../../cloud/supabase/functions/_shared/replication.ts";
import { validateSpeechInput } from "../../../cloud/supabase/functions/_shared/replication-speech.ts";

function audio() {
  const bytes = new Uint8Array(32044), view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const)
    [...text].forEach((char, i) => { bytes[offset + i] = char.charCodeAt(0); });
  view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 32000, true);
  return { mime: "audio/wav" as const, base64: Buffer.from(bytes).toString("base64"), duration: 1 };
}
const raw = { result: { text: "你好。", utterances: [{ text: "你好。", start_time: 100, end_time: 800,
  words: [{ text: "你", start_time: 100, end_time: 300 }, { text: "好", start_time: 400, end_time: 800 }] }] } };
test("speech validates actual WAV duration and rejects mixed operations", () => {
  validateSpeechInput(audio());
  validateReplication({ operation: "speech-transcription", audio: audio() });
  equal(replicationService("speech-transcription"), "replication_speech_transcription");
  throws(() => validateSpeechInput({ ...audio(), duration: 10 }));
  throws(() => validateSpeechInput({ ...audio(), base64: "aGVsbG8=" }));
  throws(() => validateReplication({ operation: "speech-transcription", audio: audio(), rewrite: {} }));
});
test("speech retains provider word evidence without inventing alignment", () => {
  const result = JSON.parse(normalizeSpeech(raw, 1));
  deepEqual(result.utterances[0].words[1], { text: "好", startMs: 400, endMs: 800 });
  const sentence = { result: { text: "你好。", utterances: [{ text: "你好。", start_time: 100, end_time: 800 }] } };
  deepEqual(JSON.parse(normalizeSpeech(sentence, 1)).utterances[0].words, []);
  throws(() => normalizeSpeech(raw, 0.1));
  throws(() => normalizeSpeech({ result: { text: "你好", utterances: [] } }, 1));
});
test("speech sends one official request and handles silence", async () => {
  let calls = 0;
  const result = await recognizeSpeech(audio(), "test-key", async (url, request) => {
    calls++;
    equal(url, "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash");
    equal(request?.headers?.["X-Api-Resource-Id"], "volc.bigasr.auc_turbo");
    equal(JSON.parse(String(request?.body)).request.show_utterances, true);
    return { ok: true, status: 200, headers: { get: () => "20000003" }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
  });
  equal(calls, 1); equal(JSON.parse(result).text, "");
  await rejects(() => recognizeSpeech(audio(), "test-key", async () => { calls++; throw new Error("connection_reset"); }));
  equal(calls, 2);
});

test("speech ignores only untimed whitespace and rejects malformed spoken words", () => {
  const sample = structuredClone(raw);
  sample.result.utterances[0].words.splice(1, 0, { text: " ", start_time: -1, end_time: -1 });
  deepEqual(normalizeSpeech(sample, 1), normalizeSpeech(raw, 1));
  sample.result.utterances[0].words[1].text = "bad";
  throws(() => normalizeSpeech(sample, 1));
});

test("complete but invalid speech response is refundable rather than uncertain", async () => {
  await rejects(() => recognizeSpeech(audio(), "test-key", async () => ({
    ok: true, status: 200, headers: { get: () => "20000000" },
    text: async () => JSON.stringify({ result: { text: "bad", utterances: [] } }), arrayBuffer: async () => new ArrayBuffer(0),
  })), (error: Error & { safeCode?: string }) => error.safeCode === "invalid_provider_response");
});

test("durable speech queue finishes, fails before submission without key, and preserves ambiguous outcomes", async () => {
  for (const mode of ["success", "missing-key", "disconnect"] as const) {
    const input = JSON.stringify({ schema_version: 1, operation: "speech-transcription", audio: audio(), image: null });
    const stop = { requested: false }, actions: string[] = [];
    let claimed = false, providerCalls = 0;
    const config = configFromEnv({ UNDERSTAND_CONTROL_URL: "https://control.test", UNDERSTAND_WORKER_TOKEN: "test",
      ARK_API_KEY: "unused", ARK_VISION_MODEL: "unused", DOUBAO_SPEECH_API_KEY: mode === "missing-key" ? undefined : "test",
      UNDERSTAND_HEARTBEAT_INTERVAL_MS: "1", UNDERSTAND_POLL_INTERVAL_MS: "1" });
    await runUnderstandWorker(config, async (url, request) => {
      const respond = (body: unknown, code: string | null = null) => ({ ok: true, status: 200, headers: { get: () => code },
        text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });
      if (url === "https://input.test") return { ...respond(null), text: async () => input };
      if (url === "https://control.test") {
        const body = JSON.parse(String(request?.body)); actions.push(body.action);
        if (body.action === "claim") {
          if (claimed) { stop.requested = true; return respond({ job: null }); }
          claimed = true;
          return respond({ job: { id: "job", inputManifestHash: createHash("sha256").update(input).digest("hex"), attempt: 1 },
            lease: { leaseId: "lease", leaseSeconds: 90 }, inputUrl: "https://input.test" });
        }
        if (body.action === "finish") equal(JSON.parse(body.resultText).utterances[0].words[1].startMs, 400);
        return respond({});
      }
      providerCalls++;
      if (mode === "disconnect") throw new Error("connection_reset");
      return respond(raw, "20000000");
    }, stop);
    equal(providerCalls, mode === "missing-key" ? 0 : 1);
    deepEqual(actions.filter(action => action !== "heartbeat"), mode === "success" ? ["claim", "submitted", "finish", "claim"]
      : mode === "missing-key" ? ["claim", "fail", "claim"] : ["claim", "submitted", "outcome_unknown", "claim"]);
  }
});
