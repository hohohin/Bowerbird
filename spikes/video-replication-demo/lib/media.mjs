import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export async function findMediaBinary(name, configured = '') {
  if (configured) { try { await access(configured); return configured; } catch { throw new Error(`找不到配置的 ${name}，请在配置中选择可用的程序路径。`); } }
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    join(repoRoot, '.tmp/video-integration/tools/local', name + suffix),
    ...(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').map(dir => join(dir, name + suffix)),
  ];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch {} }
  throw new Error(`未找到 ${name}。请在配置中填写已安装程序的完整路径。`);
}

export function runProcess(binary, args, { signal, cwd, timeoutMs = 180000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, cause;
    const abort = () => { cause = signal?.reason || new Error('操作已停止。'); child.kill(); };
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { cause = new Error('媒体处理超时，请检查视频文件后重试。'); child.kill(); }, timeoutMs);
    const collect = key => chunk => { size += chunk.length; if (size > maxBytes) { cause = new Error('媒体工具返回内容过多，已停止处理。'); child.kill(); } else if (key === 'out') stdout += chunk; else stderr += chunk; };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    child.once('error', error => { cause = error; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (cause) reject(cause);
      else if (code !== 0) { const error = new Error('媒体处理失败，请确认视频可以播放且包含所需音轨。'); error.diagnostic = stderr.slice(-4000); reject(error); }
      else resolvePromise({ stdout, stderr });
    });
  });
}

export async function probeMedia(path, config = {}, signal) {
  const binary = await findMediaBinary('ffprobe', config.ffprobeBinary);
  const { stdout } = await runProcess(binary, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], { signal });
  const info = JSON.parse(stdout), video = info.streams?.find(stream => stream.codec_type === 'video');
  const audio = info.streams?.find(stream => stream.codec_type === 'audio');
  const duration = Number(info.format?.duration || video?.duration || audio?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取有效时长，请换一个可播放的视频。');
  const rotation = Number(video?.side_data_list?.find(item => item.rotation !== undefined)?.rotation || video?.tags?.rotate || 0);
  const rotated = Math.abs(rotation % 180) === 90;
  return { duration, width: Number(rotated ? video?.height : video?.width) || 0, height: Number(rotated ? video?.width : video?.height) || 0, hasAudio: Boolean(audio) };
}

export async function prepareSource(path, outputDir, config, signal) {
  const meta = await probeMedia(path, config, signal);
  if (!meta.width || !meta.height || meta.duration > 120) throw new Error('Demo 支持最长 120 秒的视频，请先截取需要复刻的部分。');
  const binary = await findMediaBinary('ffmpeg', config.ffmpegBinary);
  await mkdir(outputDir, { recursive: true });
  await runProcess(binary, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-frames:v', '1', '-vf', "scale='min(960,iw)':-2", join(outputDir, 'source.jpg')], { signal });
  if (meta.hasAudio) await runProcess(binary, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', join(outputDir, 'source.wav')], { signal });
  return meta;
}

export async function concatenateVideos(paths, outputPath, config, signal) {
  const binary = await findMediaBinary('ffmpeg', config.ffmpegBinary);
  const first = await probeMedia(paths[0], config, signal);
  const width = Math.max(2, Math.floor(first.width / 2) * 2), height = Math.max(2, Math.floor(first.height / 2) * 2);
  const dir = join(dirname(outputPath), 'assembly'); await mkdir(dir, { recursive: true });
  const normalized = [];
  for (let i = 0; i < paths.length; i++) {
    const meta = await probeMedia(paths[i], config, signal), name = `part-${i}.mp4`, target = join(dir, name);
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', paths[i]];
    if (!meta.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    args.push('-map', '0:v:0', '-map', meta.hasAudio ? '0:a:0' : '1:a:0', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-t', String(meta.duration), target);
    await runProcess(binary, args, { signal }); normalized.push(`file '${name}'`);
  }
  const list = join(dir, 'concat.txt'); await writeFile(list, normalized.join('\n'));
  await runProcess(binary, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', list, '-c', 'copy', '-movflags', '+faststart', outputPath], { signal });
  return probeMedia(outputPath, config, signal);
}

export async function validateImage(path, config) {
  const binary = await findMediaBinary('ffprobe', config.ffprobeBinary);
  const { stdout } = await runProcess(binary, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path]);
  const image = JSON.parse(stdout).streams?.[0];
  if (!image?.width || !image?.height || image.width * image.height > 60_000_000) throw new Error('图片无法读取或像素过大，请上传普通 PNG、JPEG 或 WebP 图片。');
  return image;
}
