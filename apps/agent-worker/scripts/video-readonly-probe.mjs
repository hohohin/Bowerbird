// Offline container probe: imports the production generation path and probes a
// synthetic clip under /tmp. No worker loops, user files, or provider requests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../src/cloud-generation/runtime.ts';
import { probeVideo } from '../src/cloud-generation/video.ts';

const directory = await mkdtemp(join(tmpdir(), 'bowerbird-video-container-'));
try {
  const file = join(directory, 'synthetic.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    'color=c=blue:s=320x320:r=24', '-t', '1', '-c:v', 'mpeg4', '-y', file],
    { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
  let bytes = await readFile(file);
  if (process.argv.includes('--max-size')) {
    const padded = Buffer.alloc(500 * 1024 * 1024);
    bytes.copy(padded);
    // A valid MP4 free box exercises the size limit without extending playback.
    padded.writeUInt32BE(padded.length - bytes.length, bytes.length);
    padded.write('free', bytes.length + 4, 'ascii');
    bytes = padded;
  }
  const result = await probeVideo(bytes);
  assert.equal(result.width, 320);
  assert.equal(result.height, 320);
  assert.equal(result.fps, 24);
  assert.ok(result.duration >= 0.9 && result.duration <= 1.1);
  console.log(JSON.stringify({ ok: true, runtimeImport: true, bytes: bytes.length, ffprobe: result }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
