import { createHash } from "node:crypto";
import { FILE_SPEECH_AUDIO_TOLERANCE_MS, FILE_SPEECH_BUCKET, FILE_SPEECH_MAX_DURATION_MS, fileSpeechAudioKey, type FileSpeechAudio } from "../../../cloud/supabase/functions/_shared/file-speech.ts";
import { downloadBoundedMedia, probeMonoSpeechMp3 } from "../cloud-generation/video.ts";
import type { WorkerFetch } from "../cloud-generation/runtime.ts";
import { queryFileSpeech, submitFileSpeech } from "./file-speech.ts";

type Control = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
export interface FileSpeechClaim {
  submittedAt: string | null;
  audioUrl: string | null;
  sourceDurationMs: number;
}

function signedAudioUrl(jobId: string, raw: string | null): string {
  if (raw === null) throw new Error("file_speech_audio_url_missing");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      url.pathname !== `/storage/v1/object/sign/${FILE_SPEECH_BUCKET}/${fileSpeechAudioKey(jobId)}` ||
      url.searchParams.getAll("token").length !== 1 || !url.searchParams.get("token")) {
    throw new Error("file_speech_audio_url_invalid");
  }
  return raw;
}

export async function runFileSpeechJob(
  audio: FileSpeechAudio | null,
  claim: FileSpeechClaim,
  identity: { jobId: string; leaseId: string },
  config: { apiKey?: string; mock: boolean },
  control: Control,
  fetch: WorkerFetch,
  probe = probeMonoSpeechMp3,
): Promise<void> {
  const call = (action: string, data: Record<string, unknown> = {}) => control({ action, ...identity, ...data });
  const fail = (safeErrorCode: string, safeMessage: string) => call("file_speech_fail", { safeErrorCode, safeMessage });
  const sourceDurationMs = claim.sourceDurationMs;
  if (!Number.isSafeInteger(sourceDurationMs) || sourceDurationMs <= 0 || sourceDurationMs > FILE_SPEECH_MAX_DURATION_MS) {
    throw new Error("file_speech_invalid_source_duration");
  }
  if (config.mock) {
    if (claim.submittedAt) await call("defer_file_speech");
    else await fail("not_configured", "豆包录音文件识别尚未配置");
    return;
  }
  if (!claim.submittedAt) {
    if (!audio || audio.source_duration_ms !== sourceDurationMs) throw new Error("file_speech_invalid_manifest");
    if (!config.apiKey) {
      await fail("not_configured", "豆包录音文件识别尚未配置");
      return;
    }
    const audioUrl = signedAudioUrl(identity.jobId, claim.audioUrl);
    const bytes = await downloadBoundedMedia(fetch, audioUrl, audio.bytes, AbortSignal.timeout(45_000));
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    const duration = actualHash === audio.sha256 && bytes.length === audio.bytes
      ? await probe(bytes).catch(() => NaN) * 1000 : NaN;
    if (!Number.isFinite(duration) || Math.abs(duration - audio.duration_ms) > FILE_SPEECH_AUDIO_TOLERANCE_MS ||
        duration > audio.source_duration_ms + FILE_SPEECH_AUDIO_TOLERANCE_MS) {
      await fail("file_speech_audio_mismatch", "音轨内容、格式或时长与已确认的文件不一致，请重新提取");
      return;
    }
    // The committed UUID is already the Bowerbird job ID. Only a positive
    // acknowledgement of the submit fence permits making the provider POST.
    await call("submitted");
    const submitted = await submitFileSpeech({ requestId: identity.jobId, audioUrl }, config.apiKey, fetch);
    if (submitted.status === "failed") {
      await fail(submitted.code, "豆包录音文件识别未受理，请检查音轨或服务配置");
      return;
    }
    // There is a single POST even when the acknowledgement was dropped.
    await call("defer_file_speech");
    return;
  }
  const result = await queryFileSpeech(
    { requestId: identity.jobId, durationMs: sourceDurationMs }, config.apiKey, fetch,
  );
  switch (result.status) {
    case "completed":
    case "no_speech":
      await call("file_speech_finish", { resultText: result.resultText });
      return;
    case "failed":
      await fail(result.code, "豆包录音文件识别未返回有效文稿，请重新转录");
      return;
    case "pending":
    case "unknown":
      await call("defer_file_speech");
  }
}
