import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAudio, renderCaptionedVideo } from '../lib/composition.mjs';
import { probeMedia, runProcess } from '../lib/media.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const suffix = process.platform === 'win32' ? '.exe' : '';
const config = {
  ffmpegBinary: join(repoRoot, '.tmp/video-integration/tools/local', `ffmpeg${suffix}`),
  ffprobeBinary: join(repoRoot, '.tmp/video-integration/tools/local', `ffprobe${suffix}`),
};
let available = true;
try { await Promise.all([access(config.ffmpegBinary), access(config.ffprobeBinary)]); } catch { available = false; }
const realTest = (name, fn) => test(name, { skip: !available && 'Local FFmpeg/ffprobe fixture tools are unavailable.' }, fn);
const ffmpeg = args => runProcess(config.ffmpegBinary, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeoutMs: 30_000 });
const inspect = async file => JSON.parse((await runProcess(config.ffprobeBinary,
  ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])).stdout);
const frameHash = async (file, seconds) => {
  const { stdout } = await ffmpeg(['-ss', String(seconds), '-i', file, '-map', '0:v:0', '-frames:v', '1', '-an', '-f', 'framemd5', '-']);
  return stdout.split(/\r?\n/).filter(line => line && !line.startsWith('#')).at(-1).split(',').at(-1).trim();
};
const audioHash = async file => (await ffmpeg(['-i', file, '-map', '0:a:0', '-vn', '-f', 'md5', '-'])).stdout.trim();
let directory, source, srt;

before(async () => {
  if (!available) return;
  directory = await mkdtemp(join(tmpdir(), "replication 字幕's-"));
  source = join(directory, "原始 视频's.mp4");
  srt = join(directory, "新字幕's [最终].srt");
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=10:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', source]);
  await writeFile(srt, "1\n00:00:01,000 --> 00:00:02,000\n新的台词 'hello' 与产品\n", 'utf8');
});

after(async () => {
  if (!directory) return;
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true });
});

realTest('burns timed Chinese subtitles without moving the picture and preserves the generated audio', async () => {
  const output = join(directory, "导出 成片's.mp4");
  const meta = await renderCaptionedVideo(source, srt, output, config);
  assert.equal(meta.width, 320); assert.equal(meta.height, 180); assert.equal(meta.hasAudio, true);
  assert.ok(Math.abs(meta.duration - 3) < 0.1);
  const beforeCaption = await frameHash(output, 0.3), duringCaption = await frameHash(output, 1.5), afterCaption = await frameHash(output, 2.7);
  assert.equal(beforeCaption, afterCaption, 'Caption must disappear outside its time interval');
  assert.equal(beforeCaption, await frameHash(source, 0.3), 'Outside the overlay interval the picture stays unchanged');
  assert.notEqual(duringCaption, beforeCaption, 'The subtitle must produce actual visible pixels');
  assert.equal(await audioHash(output), await audioHash(source), 'Burning captions must preserve the original audio samples');
  await ffmpeg(['-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);

  const wav = join(directory, "新音轨's.wav");
  assert.equal(await extractAudio(output, wav, config), wav);
  const audio = (await inspect(wav)).streams;
  assert.equal(audio.length, 1); assert.equal(audio[0].codec_type, 'audio');
  assert.equal(audio[0].codec_name, 'pcm_s16le'); assert.equal(audio[0].sample_rate, '16000'); assert.equal(audio[0].channels, 1);
  assert.ok(Math.abs((await probeMedia(wav, config)).duration - 3) < 0.1);
});

realTest('empty SRT copies the video byte for byte and returns playable metadata', async () => {
  const empty = join(directory, "空 字幕's.srt"), output = join(directory, "原样 成片's.mp4");
  await writeFile(empty, '\uFEFF \n\r\n', 'utf8');
  const meta = await renderCaptionedVideo(source, empty, output, config);
  assert.equal(meta.width, 320); assert.equal(meta.height, 180); assert.equal(meta.hasAudio, true);
  assert.deepEqual(await readFile(output), await readFile(source));
});

realTest('audio extraction supports generated media longer than the 120-second source limit', async () => {
  const generatedAudio = join(directory, 'long-generated.wav'), extractedAudio = join(directory, 'long-extracted.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=8000:duration=121', '-c:a', 'pcm_s16le', generatedAudio]);
  await extractAudio(generatedAudio, extractedAudio, config);
  const meta = await probeMedia(extractedAudio, config), audio = (await inspect(extractedAudio)).streams[0];
  assert.ok(Math.abs(meta.duration - 121) < 0.01);
  assert.equal(audio.sample_rate, '16000'); assert.equal(audio.channels, 1);
});

realTest('caption output cannot overwrite the original media', async () => {
  const beforeBytes = await readFile(source);
  await assert.rejects(renderCaptionedVideo(source, srt, source, config), /不能覆盖原视频/);
  await assert.rejects(extractAudio(source, source, config), /不能覆盖原视频/);
  assert.deepEqual(await readFile(source), beforeBytes);
});
