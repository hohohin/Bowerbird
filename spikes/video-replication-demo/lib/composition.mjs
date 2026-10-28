import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { findMediaBinary, probeMedia, runProcess } from './media.mjs';

function distinctOutput(inputPath, outputPath) {
  const input = resolve(inputPath), output = resolve(outputPath);
  if ((process.platform === 'win32' ? input.toLowerCase() : input)
    === (process.platform === 'win32' ? output.toLowerCase() : output)) {
    throw new Error('请为处理结果选择新文件，不能覆盖原视频。');
  }
  return { input, output };
}

export async function extractAudio(inputPath, outputWav, config = {}, signal) {
  const { input, output } = distinctOutput(inputPath, outputWav);
  const binary = await findMediaBinary('ffmpeg', config.ffmpegBinary);
  await mkdir(dirname(output), { recursive: true });
  await runProcess(binary, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output], { signal });
  return output;
}

async function captionFont() {
  if (process.platform === 'win32' && process.env.WINDIR) {
    try { await access(join(process.env.WINDIR, 'Fonts', 'msyh.ttc')); return 'Microsoft YaHei'; } catch { /* Use the explicit fallback below. */ }
  }
  return 'Arial';
}

export async function renderCaptionedVideo(inputPath, srtPath, outputPath, config = {}, signal) {
  const { input, output } = distinctOutput(inputPath, outputPath);
  const captions = await readFile(srtPath, 'utf8');
  if (signal?.aborted) throw signal.reason || new Error('字幕合成已停止。');
  await mkdir(dirname(output), { recursive: true });
  if (!captions.replace(/^\uFEFF/, '').trim()) {
    await copyFile(input, output);
    return probeMedia(output, config, signal);
  }
  const binary = await findMediaBinary('ffmpeg', config.ffmpegBinary);
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'replication-captions-'));
  try {
    // Only a fixed filename enters the filter language. User paths (including
    // Windows drive colons, spaces, apostrophes and Chinese) remain argv entries.
    await copyFile(srtPath, join(directory, 'captions.srt'));
    const font = await captionFont();
    const style = `FontName=${font},FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=1,Outline=1.2,Shadow=0,Alignment=2,MarginV=16`;
    await runProcess(binary, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
      '-map', '0:v:0', '-map', '0:a?', '-vf', `subtitles=filename=captions.srt:charenc=UTF-8:force_style='${style}'`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', '-movflags', '+faststart', output], { signal, cwd: directory });
    return await probeMedia(output, config, signal);
  } finally {
    // mkdtemp owns a direct child of the selected temporary directory only.
    if (dirname(resolve(directory)) !== temporaryRoot) throw new Error('字幕临时目录无法安全清理。');
    await rm(directory, { recursive: true, force: true });
  }
}
