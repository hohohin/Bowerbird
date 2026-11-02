import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { probeVideo } from "./video.ts";

test("worker probes actual WAV and MP3 bytes, rejects renamed non-audio and corrupt input", async () => {
  for (const format of ["wav", "mp3"]) {
    const bytes = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-f", format, "pipe:1"], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const info = await probeVideo(bytes, "audio");
    assert.ok(info.duration >= 2 && info.duration < 2.1, `${format}: ${info.duration}`);
  }
  const flac = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=2", "-f", "flac", "pipe:1"], { windowsHide: true });
  await assert.rejects(() => probeVideo(flac, "audio"), /audio_probe_invalid/);
  await assert.rejects(() => probeVideo(new Uint8Array([1, 2, 3]), "audio"));
});
