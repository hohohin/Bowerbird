export const FILE_SPEECH_OPERATION = "file-speech-transcription";
export const FILE_SPEECH_SERVICE = "library_file_speech";
export const FILE_SPEECH_KEY_PREFIX = "file-speech:";
export const FILE_SPEECH_MAX_DURATION_MS = 7_200_000;
export const FILE_SPEECH_AUDIO_TOLERANCE_MS = 250;
export const FILE_SPEECH_MAX_AUDIO_BYTES = 32_000_000;
export const FILE_SPEECH_MAX_RESULT_BYTES = 4 * 1024 * 1024;
export const FILE_SPEECH_MIME = "audio/mpeg";
export const FILE_SPEECH_BUCKET = "generation-temp";
export const FILE_SPEECH_AUDIO_NAME = "speech-audio.mp3";

export interface FileSpeechAudio {
  bytes: number;
  sha256: string;
  duration_ms: number;
  source_duration_ms: number;
}

export function fileSpeechAudioKey(jobId: string): string {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(jobId)) throw new Error("invalid_file_speech_job_id");
  return `understand/${jobId}/inputs/${FILE_SPEECH_AUDIO_NAME}`;
}

export function parseFileSpeechAudio(value: unknown): FileSpeechAudio {
  const { bytes, sha256, duration_ms, source_duration_ms } = (value ?? {}) as Partial<FileSpeechAudio>;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > FILE_SPEECH_MAX_AUDIO_BYTES ||
      typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) ||
      typeof source_duration_ms !== "number" || !Number.isSafeInteger(source_duration_ms) ||
      source_duration_ms <= 0 || source_duration_ms > FILE_SPEECH_MAX_DURATION_MS ||
      typeof duration_ms !== "number" || !Number.isSafeInteger(duration_ms) || duration_ms <= 0 ||
      duration_ms > source_duration_ms + FILE_SPEECH_AUDIO_TOLERANCE_MS) {
    throw new Error("invalid_file_speech_audio");
  }
  return { bytes, sha256, duration_ms, source_duration_ms };
}
