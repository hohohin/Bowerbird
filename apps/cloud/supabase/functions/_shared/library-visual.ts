export const LIBRARY_VISUAL_OPERATION = "library-video-analysis";
export const LIBRARY_VISUAL_SERVICE = "library_video_analysis";
export const LIBRARY_VISUAL_PREFIX = "library-visual:";
export const LIBRARY_VISUAL_VIDEO_NAME = "visual-input.mp4";
export const LIBRARY_VISUAL_MAX_SEGMENT_MS = 7_200_000;
export const LIBRARY_VISUAL_MAX_BYTES = 32_000_000;
export const LIBRARY_VISUAL_MAX_EDGE = 480;
export const LIBRARY_VISUAL_DURATION_TOLERANCE_MS = 2_000;

export interface LibraryVisualVideo {
  mime: "video/mp4";
  bytes: number;
  sha256: string;
  duration_ms: number;
  start_ms: number;
  end_ms: number;
  source_duration_ms: number;
}

export function parseLibraryVisualVideo(value: unknown, shot = false): LibraryVisualVideo {
  const { mime, bytes, sha256, duration_ms, start_ms, end_ms, source_duration_ms } = (value ?? {}) as Partial<LibraryVisualVideo>;
  if (mime !== "video/mp4" || typeof bytes !== "number" || !Number.isSafeInteger(bytes) ||
      bytes < 1 || bytes > LIBRARY_VISUAL_MAX_BYTES || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) ||
      typeof duration_ms !== "number" || !Number.isSafeInteger(duration_ms) || duration_ms < 1 ||
      typeof start_ms !== "number" || !Number.isSafeInteger(start_ms) || start_ms < 0 ||
      typeof end_ms !== "number" || !Number.isSafeInteger(end_ms) || end_ms <= start_ms ||
      typeof source_duration_ms !== "number" || !Number.isSafeInteger(source_duration_ms) || end_ms > source_duration_ms ||
      (shot ? end_ms - start_ms > 60_000 || Math.abs(duration_ms - (end_ms - start_ms)) > 1000 :
        start_ms % LIBRARY_VISUAL_MAX_SEGMENT_MS !== 0 || end_ms !== Math.min(start_ms + LIBRARY_VISUAL_MAX_SEGMENT_MS, source_duration_ms)) ||
      Math.abs(duration_ms - (end_ms - start_ms)) > LIBRARY_VISUAL_DURATION_TOLERANCE_MS) {
    throw new Error("invalid_library_visual_video");
  }
  return { mime, bytes, sha256, duration_ms, start_ms, end_ms, source_duration_ms };
}

export function libraryVisualVideoKey(jobId: string): string {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(jobId)) throw new Error("invalid_library_visual_job_id");
  return `understand/${jobId}/inputs/${LIBRARY_VISUAL_VIDEO_NAME}`;
}

export function libraryVisualCredits(durationMs: number, creditsPerHour: number): number {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 ||
      !Number.isSafeInteger(creditsPerHour) || creditsPerHour < 1) throw new Error("invalid_library_visual_quote");
  const credits = Number((BigInt(durationMs) * BigInt(creditsPerHour) + 3_599_999n) / 3_600_000n);
  if (credits > 2_147_483_647) throw new Error("library_visual_quote_exceeds_credit_limit");
  return credits;
}
