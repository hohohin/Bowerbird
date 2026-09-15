import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { ArkVideoClient, ArkVideoError, type VideoFetch } from "./ark-video.ts";
import { SEEDANCE_MODEL, validateVideoInput, type VideoInput } from "../../../cloud/supabase/functions/_shared/video-contract.ts";
import type { WorkerFetch } from "./runtime.ts";

type Control = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export async function probeVideo(bytes: Uint8Array, image = false): Promise<{ duration: number; width: number; height: number; fps: number }> {
  const folder = await mkdtemp(join(tmpdir(), "bowerbird-video-probe-"));
  try {
    const path = join(folder, "video.mp4");
    await writeFile(path, bytes);
    const output = await new Promise<string>((resolve, reject) => {
      execFile("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration:stream=codec_type,width,height,avg_frame_rate", "-of", "json", path], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(new Error("video_probe_failed")) : resolve(String(stdout)));
    });
    const info = JSON.parse(output);
    const stream = info.streams?.find((item: { codec_type?: string }) => item.codec_type === "video");
    const [num, den] = String(stream?.avg_frame_rate).split("/").map(Number);
    const result = { duration: Number(info.format?.duration), width: Number(stream?.width), height: Number(stream?.height), fps: num / den };
    const required = image ? [result.width, result.height] : Object.values(result);
    if (required.some(number => !Number.isFinite(number) || number <= 0)) throw new Error("video_probe_invalid");
    return result;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

async function download(fetch: WorkerFetch, url: string, limit: number): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hostname === "localhost" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(parsed.hostname)) throw new Error("video_url_invalid");
  const response = await fetch(url, { method: "GET", redirect: "error" });
  if (!response.ok) throw new Error("video_download_failed");
  const length = Number(response.headers.get("content-length"));
  if (length > limit) throw new Error("video_download_limit");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("video_download_stream_missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value) continue;
      size += chunk.value.length;
      if (size > limit) throw new Error("video_download_limit");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (!bytes.length || bytes.length > limit) throw new Error("video_download_limit");
  return bytes;
}

/** A claimed task with an upstream ID executes GET only, including after process restart. */
export async function executeVideo(input: VideoInput, job: { id: string; leaseId: string; upstreamTaskId?: string }, apiKey: string, control: Control, fetch: WorkerFetch, probe: typeof probeVideo = probeVideo): Promise<void> {
  const identity = { jobId: job.id, leaseId: job.leaseId };
  let taskId = job.upstreamTaskId;
  let submitting = false;
  try {
    validateVideoInput(input);
    const client = new ArkVideoClient(apiKey, fetch as VideoFetch);
    if (!taskId) {
      for (const image of input.reference_images) {
        const info = await probe(Buffer.from(image.base64, "base64"), true);
        if (Math.min(info.width, info.height) < 300 || Math.max(info.width, info.height) > 6000 || info.width / info.height < 0.4 || info.width / info.height > 2.5) throw new Error("video_image_spec_invalid");
      }
      const urls: string[] = [];
      let totalSeconds = 0;
      for (const reference of input.reference_videos) {
        const signed = await control({ action: "video_input_url", ...identity, objectKey: reference.object_key, bytes: reference.bytes });
        if (typeof signed.url !== "string") throw new Error("video_input_url_invalid");
        const bytes = await download(fetch, signed.url, reference.bytes);
        if (bytes.length !== reference.bytes) throw new Error("video_input_size_mismatch");
        const info = await probe(bytes);
        const ratio = info.width / info.height;
        if (info.duration < 2 || info.duration > 30 || ratio < 0.4 || ratio > 2.5 || info.width < 300 || info.height < 300 || info.width > 6000 || info.height > 6000 || info.width * info.height < 407696 || info.width * info.height > 8295044 || info.fps < 24 || info.fps > 60) throw new Error("video_reference_spec_invalid");
        totalSeconds += info.duration;
        if (totalSeconds > 30) throw new Error("video_reference_duration_limit");
        urls.push(signed.url);
      }
      const heartbeat = await control({ action: "heartbeat", ...identity });
      if (heartbeat.cancelRequested) { await control({ action: "cancelled", ...identity }); return; }
      // Durable submitting boundary precedes the one and only chargeable POST.
      await control({ action: "submitted", ...identity });
      submitting = true;
      taskId = await client.submit(input, urls);
      console.log(JSON.stringify({ event: "video_upstream_created", job_id: job.id, task_id: taskId, model: SEEDANCE_MODEL }));
      await control({ action: "submitted", ...identity, providerRequestId: taskId });
    }
    const task = await client.query(taskId);
    if (task.model && task.model !== SEEDANCE_MODEL) throw new Error("video_model_mismatch");
    if (task.status === "queued" || task.status === "running") {
      await control({ action: "video_defer", ...identity });
      return;
    }
    if (task.status !== "succeeded") {
      await control({ action: task.status === "cancelled" ? "cancelled" : "fail", ...identity, safeErrorCode: task.errorCode ?? `video_${task.status}`, safeMessage: "方舟视频任务未成功，冻结积分将退回" });
      return;
    }
    const bytes = await download(fetch, task.videoUrl!, MAX_VIDEO_BYTES);
    await probe(bytes);
    const upload = await control({ action: "output_upload", ...identity, mime: "video/mp4" });
    if (typeof upload.uploadUrl !== "string" || typeof upload.objectKey !== "string") throw new Error("video_output_upload_invalid");
    const uploaded = await fetch(upload.uploadUrl, { method: "PUT", headers: { "content-type": "video/mp4", "x-upsert": "true" }, body: bytes });
    if (!uploaded.ok) throw new Error("video_output_upload_failed");
    await control({ action: "finish", ...identity, objectKey: upload.objectKey, mime: "video/mp4", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), completionTokens: task.completionTokens });
  } catch (error) {
    const code = error instanceof ArkVideoError ? error.code : "video_processing_failed";
    if (taskId) {
      // Never fail/refund a task whose provider outcome or downloaded output can still recover.
      // An expired lease reclaims the persisted ID; if saving that ID failed, leave outcome unknown.
      try { await control({ action: "submitted", ...identity, providerRequestId: taskId }); await control({ action: "video_defer", ...identity }); }
      catch { console.error(JSON.stringify({ event: "video_recovery_pending", job_id: job.id, task_id: taskId, error: code })); }
    } else {
      const known = error instanceof ArkVideoError && error.definitive;
      await control({ action: !submitting || known ? "fail" : "outcome_unknown", ...identity, safeErrorCode: code, safeMessage: submitting && !known ? "视频提交结果未知，请等待核对；不会自动重新生成" : "视频任务提交失败" });
    }
  }
}
