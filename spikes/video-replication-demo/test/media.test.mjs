import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSource, concatenateVideos, probeMedia, runProcess } from '../lib/media.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const suffix = process.platform === 'win32' ? '.exe' : '';
const config = {
  ffmpegBinary: join(repoRoot, '.tmp/video-integration/tools/local', `ffmpeg${suffix}`),
  ffprobeBinary: join(repoRoot, '.tmp/video-integration/tools/local', `ffprobe${suffix}`),
};
let available = true;
try { await Promise.all([access(config.ffmpegBinary), access(config.ffprobeBinary)]); } catch { available = false; }
const realMediaTest = (name, fn) => test(name, { skip: !available && 'Local FFmpeg/ffprobe fixture tools are unavailable.' }, fn);
let directory, source, silent;
const ffmpeg = args => runProcess(config.ffmpegBinary, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeoutMs: 30_000 });
const streams = async file => JSON.parse((await runProcess(config.ffprobeBinary,
  ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])).stdout);
const decode = file => ffmpeg(['-xerror', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-']);

before(async () => {
  if (!available) return;
  directory = await mkdtemp(join(tmpdir(), 'replication-real-media-'));
  source = join(directory, '有声参考.mp4');
  silent = join(directory, '无声竖屏.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=24:d=3',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=6',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', source]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=90x160:r=24:d=1.25', '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silent]);
});

after(async () => {
  if (!directory) return;
  // This fixture owns only its fresh, direct child of the OS temp directory.
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true });
});

realMediaTest('prepareSource extracts real 16 kHz mono PCM audio and a decodable thumbnail', async () => {
  const outputDir = join(directory, 'prepared');
  const meta = await prepareSource(source, outputDir, config);
  assert.equal(meta.width, 160); assert.equal(meta.height, 90); assert.equal(meta.hasAudio, true);
  assert.ok(Math.abs(meta.duration - 6) < 0.1);
  const audio = (await streams(join(outputDir, 'source.wav'))).streams;
  assert.equal(audio.length, 1); assert.equal(audio[0].codec_type, 'audio');
  assert.equal(audio[0].sample_rate, '16000'); assert.equal(audio[0].channels, 1);
  assert.equal(audio[0].codec_name, 'pcm_s16le');
  const poster = (await streams(join(outputDir, 'source.jpg'))).streams[0];
  assert.equal(poster.width, 160); assert.equal(poster.height, 90);
  assert.ok((await stat(join(outputDir, 'source.jpg'))).size > 0);
  await ffmpeg(['-xerror', '-i', join(outputDir, 'source.jpg'), '-f', 'null', '-']);
});

realMediaTest('concatenation normalizes mixed sizes and supplies audio for the silent clip', async () => {
  const output = join(directory, 'assembled', 'result.mp4');
  const meta = await concatenateVideos([source, silent], output, config);
  assert.equal(meta.width, 160); assert.equal(meta.height, 90); assert.equal(meta.hasAudio, true);
  assert.ok(Math.abs(meta.duration - 7.25) < 0.15, `Expected the sum of clip durations, got ${meta.duration}`);
  const info = await streams(output), audio = info.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(audio.sample_rate, '48000'); assert.equal(audio.channels, 2);
  const normalizedSilent = await probeMedia(join(directory, 'assembled', 'assembly', 'part-1.mp4'), config);
  assert.equal(normalizedSilent.hasAudio, true); assert.equal(normalizedSilent.width, 160); assert.equal(normalizedSilent.height, 90);
  // Decode every output stream: metadata alone would miss a broken concat boundary.
  await decode(output);
});
