import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import type { WorkerFetch } from "../cloud-generation/runtime.ts";
import { queryFileSpeech, submitFileSpeech } from "./file-speech.ts";

const requestId = "180c19c1-1ceb-4b04-ba2e-c3b00df05e8c";
const audioUrl = "https://storage.test/storage/v1/object/sign/transcripts/audio.mp3?token=worker-only";
const submitInput = { requestId, audioUrl };
const queryInput = { requestId, durationMs: 7_200_000 };
const apiRoot = "https://openspeech.bytedance.com/api/v3/auc/bigmodel";

type HttpResponse = Awaited<ReturnType<WorkerFetch>>;

function reply(code: string, body?: unknown, status = 200, echoedId?: string): HttpResponse {
  const text = JSON.stringify(body) ?? "";
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => ({ "x-api-status-code": code, "x-api-request-id": echoedId })[name] ?? null },
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
    body: text ? { getReader() {
      let done = false;
      return {
        async read() {
          if (done) return { done: true };
          done = true;
          return { done: false, value: new TextEncoder().encode(text) };
        },
        async cancel() { done = true; },
      };
    } } : null,
  };
}

test("submits a full MP3 URL once and queries the same UUID on the standard 2.0 resource", async () => {
  const calls: string[] = [];
  const fetchImpl: WorkerFetch = async (url, request) => {
    calls.push(url);
    equal(request?.method, "POST");
    equal(request?.redirect, "error");
    ok(request?.signal);
    equal(request?.headers?.["X-Api-Key"], "test-key");
    equal(request?.headers?.["X-Api-Resource-Id"], "volc.seedasr.auc");
    equal(request?.headers?.["X-Api-Request-Id"], requestId);
    if (url === `${apiRoot}/submit`) {
      equal(request?.headers?.["X-Api-Sequence"], "-1");
      deepEqual(JSON.parse(String(request?.body)), {
        audio: { url: audioUrl, format: "mp3", codec: "raw", rate: 16000, bits: 16, channel: 1 },
        request: { model_name: "bigmodel", show_utterances: true, enable_itn: true, enable_punc: true, enable_ddc: false, vad_segment: true },
      });
      return reply("20000000", undefined, 200, requestId);
    }
    equal(request?.headers?.["X-Api-Sequence"], undefined);
    equal(request?.body, "{}");
    return reply(calls.length === 2 ? "20000002" : "20000001");
  };
  deepEqual(await submitFileSpeech(submitInput, "test-key", fetchImpl), { status: "submitted" });
  deepEqual(await queryFileSpeech(queryInput, "test-key", fetchImpl), { status: "pending" });
  deepEqual(await queryFileSpeech(queryInput, "test-key", fetchImpl), { status: "pending" });
  deepEqual(calls, [`${apiRoot}/submit`, `${apiRoot}/query`, `${apiRoot}/query`]);
});

test("does not retry ambiguous submissions or silently swap the provider identity", async () => {
  let calls = 0;
  const disconnected: WorkerFetch = async () => { calls++; throw new Error(`network reset: ${audioUrl}`); };
  deepEqual(await submitFileSpeech(submitInput, "test-key", disconnected), { status: "unknown" });
  equal(calls, 1);
  const mismatch = async () => reply("20000000", undefined, 200, "7283e268-fadf-4013-898b-f0ab26c2237d");
  deepEqual(await submitFileSpeech(submitInput, "test-key", mismatch), { status: "unknown" });
  deepEqual(await queryFileSpeech(queryInput, "test-key", mismatch), { status: "unknown" });
  for (const code of ["45000001", "45000131", "55000001", "55000031", "unknown"]) {
    const response = async () => reply(code, undefined, 503);
    deepEqual(await submitFileSpeech(submitInput, "test-key", response), { status: "unknown" });
    deepEqual(await queryFileSpeech(queryInput, "test-key", response), { status: "unknown" });
  }
});

test("distinguishes silent audio, terminal provider failures, and rejected inputs", async () => {
  const noSpeech = await queryFileSpeech(queryInput, "test-key", async () => reply("20000003"));
  if (noSpeech.status !== "no_speech") throw new Error(`Expected no_speech, received ${noSpeech.status}`);
  deepEqual(JSON.parse(noSpeech.resultText), { text: "", utterances: [], timingSource: "doubao-speech" });
  deepEqual(await queryFileSpeech(queryInput, "test-key", async () => reply("20000000", { result: { text: "", utterances: [] } })), noSpeech);
  for (const code of ["55001010", "55001011"]) {
    deepEqual(await queryFileSpeech(queryInput, "test-key", async () => reply(code)), { status: "failed", code: "provider_failed" });
  }
  for (const code of ["45000002", "45000006", "45000130", "45000132", "45000151"]) {
    const response = async () => reply(code, undefined, 400);
    const expected = { status: "failed", code: "invalid_provider_request" };
    deepEqual(await submitFileSpeech(submitInput, "test-key", response), expected);
    deepEqual(await queryFileSpeech(queryInput, "test-key", response), expected);
  }
  let calls = 0;
  const unused = async () => { calls++; return reply("20000000"); };
  deepEqual(await submitFileSpeech(submitInput, undefined, unused), { status: "failed", code: "not_configured" });
  deepEqual(await queryFileSpeech(queryInput, undefined, unused), { status: "unknown" });
  deepEqual(await submitFileSpeech({ ...submitInput, requestId: "new" }, "test-key", unused), { status: "failed", code: "invalid_provider_request" });
  deepEqual(await submitFileSpeech({ ...submitInput, audioUrl: "http://storage.test/audio.mp3" }, "test-key", unused), { status: "failed", code: "invalid_provider_request" });
  deepEqual(await queryFileSpeech({ ...queryInput, durationMs: -1 }, "test-key", unused), { status: "failed", code: "invalid_provider_request" });
  equal(calls, 0);
});

test("preserves the full two-hour transcript and millisecond timing without word metadata", async () => {
  const spoken = "第一句话需要完整保留并且可以定位到原片时间轴。";
  const segments = Array.from({ length: 2400 }, (_, index) => ({
    text: spoken, start_time: index * 3000 + 50, end_time: index * 3000 + 2990,
    words: [{ text: "第", start_time: 0, end_time: 5 }],
  }));
  const text = spoken.repeat(segments.length);
  const result = await queryFileSpeech(queryInput, "test-key", async () => reply("20000000", { result: { text, utterances: segments } }));
  if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
  ok(new TextEncoder().encode(result.resultText).byteLength > 65536);
  deepEqual(JSON.parse(result.resultText), {
    text,
    utterances: segments.map(segment => ({ text: spoken, startMs: segment.start_time, endMs: segment.end_time })),
    timingSource: "doubao-speech",
  });
});

test("preserves recorded word times, zero-duration points and original utterance text", async () => {
  const text = "中文 AI，1970 年。片尾。";
  const utterances = [
    { text: "中文 AI，1970 年。", start_time: 20, end_time: 700, words: [
      { text: "中", start_time: 20, end_time: 60, confidence: 0 },
      { text: "文", start_time: 60, end_time: 125 },
      { text: " ", start_time: -1, end_time: -1 },
      { text: "AI", start_time: 140, end_time: 200 },
      { text: "，" },
      { text: "一九七零", start_time: 200, end_time: 600 },
      { text: "年", start_time: 600, end_time: 600 },
    ] },
    { text: "片尾。", start_time: 850, end_time: 1120, words: [
      { text: "片", start_time: 900, end_time: 950 },
      { text: "尾", start_time: 950, end_time: 1080 },
      { text: "。", start_time: 1080, end_time: 1100 },
    ] },
  ];
  const result = await queryFileSpeech({ ...queryInput, durationMs: 1000 }, "test-key",
    async () => reply("20000000", { result: { text, utterances } }));
  if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
  deepEqual(JSON.parse(result.resultText), {
    text, timingSource: "doubao-speech", utterances: [
      { text: "中文 AI，1970 年。", startMs: 20, endMs: 700, words: [
        { text: "中", startMs: 20, endMs: 60 },
        { text: "文", startMs: 60, endMs: 125 },
        { text: "AI", startMs: 140, endMs: 200 },
        { text: "一九七零", startMs: 200, endMs: 600 },
        { text: "年", startMs: 600, endMs: 600 },
      ] },
      { text: "片尾。", startMs: 850, endMs: 1120, words: [
        { text: "片", startMs: 900, endMs: 950 },
        { text: "尾", startMs: 950, endMs: 1000 },
      ] },
    ],
  });
});

test("isolates invalid optional word arrays from the transcript and other sentences", async () => {
  const first = { text: "甲。", start_time: 100, end_time: 500 };
  const second = { text: "乙。", start_time: 600, end_time: 900, words: [{ text: "乙", start_time: 650, end_time: 800 }] };
  for (const words of [
    null, [{ text: "甲", start_time: 99, end_time: 200 }],
    [{ text: "甲", start_time: 100.5, end_time: 200 }],
    [{ text: "甲", start_time: -1, end_time: -1 }],
    [{ text: "甲", start_time: 150, end_time: 149 }],
    [{ text: "甲", start_time: 150, end_time: 501 }],
    [{ text: "甲", start_time: 150, end_time: 300 }, { text: "乙", start_time: 299, end_time: 400 }],
  ]) {
    const result = await queryFileSpeech(queryInput, "test-key", async () => reply("20000000", {
      result: { text: first.text + second.text, utterances: [{ ...first, words }, second] },
    }));
    if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
    deepEqual(JSON.parse(result.resultText).utterances, [
      { text: first.text, startMs: 100, endMs: 500 },
      { text: second.text, startMs: 600, endMs: 900, words: [{ text: "乙", startMs: 650, endMs: 800 }] },
    ]);
  }
});

test("delivers all sentences when two hours of validated word timings exceed the result budget", async () => {
  const spoken = "字".repeat(24) + "。";
  const segments = Array.from({ length: 3600 }, (_, index) => {
    const start = index * 2000;
    return {
      text: spoken, start_time: start, end_time: start + 2000,
      words: Array.from({ length: 24 }, (_, word) => ({
        text: "字", start_time: start + word * 80, end_time: start + (word + 1) * 80,
      })),
    };
  });
  const text = spoken.repeat(segments.length);
  const result = await queryFileSpeech(queryInput, "test-key", async () => reply("20000000", {
    result: { text, utterances: segments },
  }));
  if (result.status !== "completed") throw new Error(`Expected completed, received ${result.status}`);
  deepEqual(JSON.parse(result.resultText), {
    text, timingSource: "doubao-speech",
    utterances: segments.map(({ text, start_time, end_time }) => ({ text, startMs: start_time, endMs: end_time })),
  });
});

test("rejects missing or invalid timing and bounds normalized UTF-8 results", async () => {
  const read = (text: string, utterances: unknown[]) =>
    queryFileSpeech({ ...queryInput, durationMs: 1_000 }, "test-key", async () => reply("20000000", { result: { text, utterances } }));
  const first = { text: "你好", start_time: 40, end_time: 800 };
  const invalid = { status: "failed", code: "invalid_provider_response" };
  deepEqual(await read("你好", []), invalid);
  deepEqual(await read("你好", [null]), invalid);
  deepEqual(await read("你好", [{ ...first, end_time: 1251 }]), invalid);
  deepEqual(await read("你好", [first, { ...first, start_time: 799, end_time: 1000 }]), invalid);
  const largeText = "超".repeat(750_000);
  deepEqual(await read(largeText, [{ ...first, text: largeText }]), invalid);
});

test("bounds streamed provider data even when the response omits Content-Length", async () => {
  const chunk = new Uint8Array(8 * 1024 * 1024);
  let cancelled = false;
  const response: HttpResponse = { ...reply("20000000"), body: { getReader: () => ({
    read: async () => ({ done: false, value: chunk }),
    cancel: async () => { cancelled = true; },
  }) } };
  deepEqual(await queryFileSpeech(queryInput, "test-key", async () => response), { status: "failed", code: "invalid_provider_response" });
  equal(cancelled, true);
});

test("queries the original task after an interrupted result read", async () => {
  const response: HttpResponse = { ...reply("20000000"), body: { getReader: () => ({
    read: async () => { throw new Error("interrupted"); },
    cancel: async () => {},
  }) } };
  deepEqual(await queryFileSpeech(queryInput, "test-key", async () => response), { status: "unknown" });
});
