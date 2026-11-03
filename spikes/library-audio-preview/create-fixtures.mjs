// Synthetic audio only. FFmpeg generates test inputs; the preview decoder must not depend on it.
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = resolve(repository, '.tmp/audio-preview-fixtures');
const ffmpeg = process.env.BOWERBIRD_FFMPEG_BINARY || resolve(repository, '.tmp/video-integration/tools/local/ffmpeg.exe');
await mkdir(directory, { recursive: true });
const samples = [
  { id: 'chime', name: '晨间提示.wav', file: 'chime.wav', duration: 12, input: String.raw`aevalsrc=0.12*(sin(2*PI*440*t)+0.5*sin(2*PI*660*t))*exp(-3*mod(t\,2)):s=48000:d=12`, codec: ['-c:a', 'pcm_s16le'] },
  { id: 'rain', name: '雨落窗边.flac', file: 'rain.flac', duration: 24, input: 'anoisesrc=color=pink:amplitude=0.08:sample_rate=48000:duration=24:seed=42', filter: 'lowpass=f=2800', codec: ['-c:a', 'flac'] },
  { id: 'rhythm', name: '机械节奏.mp3', file: 'rhythm.mp3', duration: 18, input: String.raw`aevalsrc=0.15*sin(2*PI*160*t)*exp(-18*mod(t\,0.6)):s=48000:d=18`, codec: ['-c:a', 'libmp3lame', '-q:a', '4'] },
  { id: 'space', name: '空间氛围.m4a', file: 'space.m4a', duration: 36, input: 'aevalsrc=0.035*(sin(2*PI*220*t)+sin(2*PI*277.18*t)+sin(2*PI*329.63*t))*(0.55+0.45*sin(2*PI*t/9)):s=48000:d=36', codec: ['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'] },
  { id: 'steps', name: '门厅脚步.wav', file: 'steps.wav', duration: 8, input: String.raw`aevalsrc=0.1*(sin(2*PI*82*t)+sin(2*PI*113*t))*exp(-25*mod(t\,0.7)):s=48000:d=8`, codec: ['-c:a', 'pcm_s16le'] },
  { id: 'long-mp3', name: '一小时环境录音.mp3', file: 'long-vbr.mp3', duration: 3600, input: 'sine=frequency=233:sample_rate=48000:duration=3600', codec: ['-c:a', 'libmp3lame', '-q:a', '4'] },
  { id: 'long-flac', name: 'long.flac', file: 'long.flac', duration: 3600, input: 'sine=frequency=233:sample_rate=48000:duration=3600', codec: ['-c:a', 'flac'] },
  { id: 'ten-minute-wav', name: 'ten-minute.wav', file: 'ten-minute.wav', duration: 600, input: 'sine=frequency=233:sample_rate=48000:duration=600', codec: ['-c:a', 'pcm_s16le'] },
];
for (const sample of samples) {
  const path = resolve(directory, sample.file);
  const exists = await stat(path).catch(() => null);
  if (!exists?.size) {
    const args = ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', sample.input,
      ...(sample.filter ? ['-af', sample.filter] : []), '-ac', '2', ...sample.codec, path];
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', data => { error += data; });
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
    if (code) throw new Error(`${sample.file}: ${error}`);
  }
  console.log(`${sample.file}: ${(await stat(path)).size} bytes`);
}
const manifest = samples.slice(0, 6).map(({ id, name, file, duration }) => ({
  id, name, duration, url: `/audio-fixtures/${file}`, peaksUrl: `/audio-fixtures/${id}.peaks.json`,
}));
await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(resolve(directory, 'sources.json'), JSON.stringify(samples.map(({ id, file, duration }) => ({ id, file, duration })), null, 2));
console.log(`Manifest: ${resolve(directory, 'manifest.json')}`);
