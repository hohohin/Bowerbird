import { randomUUID } from "node:crypto";
import { KnownProviderError, type WorkerFetch } from "../cloud-generation/runtime.ts";
import { validateSpeechInput, type ReplicationSpeechInput } from "../../../cloud/supabase/functions/_shared/replication-speech.ts";

export function normalizeSpeech(raw: unknown, duration: number): string {
  const result = (raw as { result?: { text?: unknown; utterances?: unknown } })?.result;
  if (!result || typeof result.text !== "string" || !Array.isArray(result.utterances)) throw new Error("speech_result_invalid");
  const timed = (value: unknown) => {
    const v = value as { text: string; start_time: number; end_time: number };
    if (!v || typeof v.text !== "string" || !Number.isFinite(v.start_time) || !Number.isFinite(v.end_time)
      || v.start_time < 0 || v.end_time <= v.start_time || v.end_time > duration * 1000 + 250) throw new Error("speech_timing_invalid");
    return { text: v.text, startMs: v.start_time, endMs: v.end_time };
  };
  let previous = 0;
  const utterances = result.utterances.map((value: unknown) => {
    const u = timed(value), w = (value as { words?: unknown }).words;
    if (u.startMs < previous) throw new Error("speech_timing_overlap");
    previous = u.endMs;
    // Doubao includes untimed whitespace separators (-1/-1) between English words.
    // They carry no spoken content and must not become alignment evidence.
    const words = Array.isArray(w) ? w.filter(value => {
      const word = value as { text?: unknown; start_time?: unknown; end_time?: unknown };
      return !(typeof word?.text === "string" && !word.text.trim() && word.start_time === -1 && word.end_time === -1);
    }).map(timed) : [];
    let wordEnd = u.startMs;
    for (const word of words) {
      if (word.startMs < wordEnd || word.endMs > u.endMs) throw new Error("speech_word_timing_invalid");
      wordEnd = word.endMs;
    }
    return { ...u, words };
  });
  if (result.text.trim() && !utterances.length) throw new Error("speech_timing_missing");
  const output = JSON.stringify({ text: result.text, utterances, timingSource: "doubao-speech" });
  if (output.length > 65536) throw new Error("speech_result_too_large");
  return output;
}

export async function recognizeSpeech(input: ReplicationSpeechInput, key: string | undefined, fetchImpl: WorkerFetch): Promise<string> {
  validateSpeechInput(input);
  if (!key) throw new KnownProviderError("not_configured", "豆包语音服务尚未配置");
  const request = { method: "POST" as const, redirect: "error" as const,
    headers: { "Content-Type": "application/json", "X-Api-Key": key, "X-Api-Resource-Id": "volc.bigasr.auc_turbo",
      "X-Api-Request-Id": randomUUID(), "X-Api-Sequence": "-1" },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({ user: { uid: "bowerbird" }, audio: { data: input.base64, format: "wav" },
      request: { model_name: "bigmodel", show_utterances: true, enable_itn: true, enable_punc: true, enable_ddc: false } }) };
  const response = await fetchImpl("https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash", request);
  if (response.status === 401 || response.status === 403) throw new KnownProviderError("not_configured", "豆包语音授权未通过");
  const code = response.headers.get("x-api-status-code");
  if (response.ok && code === "20000003") return JSON.stringify({ text: "", utterances: [], timingSource: "doubao-speech" });
  if (["45000001", "45000002", "45000151"].includes(code ?? "")) throw new KnownProviderError("invalid_provider_request", "语音服务无法读取音频，请重新提取音轨");
  if (!response.ok || code !== "20000000") throw new Error("speech_outcome_unknown");
  const body = await response.text();
  try {
    return normalizeSpeech(JSON.parse(body), input.duration);
  } catch {
    // A complete response with unusable timing is a known failure, not a lost request.
    throw new KnownProviderError("invalid_provider_response", "语音服务返回的时间信息无效，本次识别未扣费，请重试");
  }
}
