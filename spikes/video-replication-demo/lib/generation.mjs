import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Ported from apps/desktop/src-tauri/src/codex/jimeng_video.rs and cli_credentials.rs.
// The CLI owns OAuth. This module neither reads nor copies credential contents.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const RATIOS = new Set(['1:1', '3:4', '16:9', '4:3', '9:16', '21:9']);
const TRANSIENT = /context deadline exceeded|Client\.Timeout exceeded|i\/o timeout|TLS handshake timeout|connection reset by peer/i;

function failure(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

async function isFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

function appDirectory(config) {
  if (config.bowerbirdAppData) return path.resolve(config.bowerbirdAppData);
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'com.bowerbird.desktop');
  if (process.platform === 'darwin' && process.env.HOME) return path.join(process.env.HOME, 'Library/Application Support/com.bowerbird.desktop');
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, 'com.bowerbird.desktop');
  if (process.env.HOME) return path.join(process.env.HOME, '.local/share/com.bowerbird.desktop');
  throw failure('CLI_PROFILE_MISSING', '无法定位本机即梦授权目录，请先打开 Bowerbird 完成即梦登录。');
}

export async function discoverJimengBinary(config = {}) {
  const explicit = config.jimengBinary || process.env.BOWERBIRD_DREAMINA_BINARY;
  if (explicit) {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(explicit)) {
      throw failure('CLI_BINARY_INVALID', '请将 JIMENG_BINARY 设置为即梦原生 exe 文件，不支持命令脚本。');
    }
    return await isFile(explicit) ? path.resolve(explicit) : null;
  }
  const name = process.platform === 'win32' ? 'dreamina.exe' : 'dreamina';
  const userDirectory = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  const candidates = [];
  if (userDirectory) candidates.push(path.join(userDirectory, process.platform === 'win32' ? 'bin' : '.local/bin', name));
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(directory, name));
  for (const candidate of candidates) if (await isFile(candidate)) return path.resolve(candidate);
  return null;
}

async function invocation(config) {
  const binary = await discoverJimengBinary(config);
  if (!binary) throw failure('CLI_MISSING', '未找到本机即梦 CLI。请在 Bowerbird 安装即梦，或填写 JIMENG_BINARY。');
  // Matches the desktop protocol: Unix uses the existing CLI session directly.
  if (process.platform !== 'win32') return { executable: binary, prefix: [], env: { ...process.env } };
  const app = appDirectory(config);
  let launcher = config.jimengLauncher;
  if (!launcher) {
    const runtime = path.join(app, 'cli-runtime');
    let entries = [];
    try { entries = await readdir(runtime, { withFileTypes: true }); } catch { /* Report the missing launcher below. */ }
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) {
      const candidate = path.join(runtime, entry.name, 'cli-launcher.exe');
      if (await isFile(candidate) && await isFile(path.join(path.dirname(candidate), 'cli-registry.dll'))) { launcher = candidate; break; }
    }
  }
  if (!launcher || !await isFile(launcher) || !await isFile(path.join(path.dirname(launcher), 'cli-registry.dll'))) {
    throw failure('CLI_PROFILE_MISSING', '未找到 Bowerbird 即梦授权启动器。请先打开已安装的 Bowerbird 完成即梦登录，再启动 Demo。');
  }
  const profile = config.jimengProfileDir || path.join(app, 'cli-profiles', 'dreamina');
  const env = { ...process.env, USERPROFILE: profile, HOME: profile,
    APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(profile, '.config'), XDG_DATA_HOME: path.join(profile, '.local/share'),
    BOWERBIRD_DREAMINA_REGISTRY: 'Software\\Bowerbird\\CliAuth\\Dreamina' };
  return { executable: path.resolve(launcher), prefix: [binary], env };
}

function rejectVideoReference(input) {
  const { config = {} } = input;
  if (Object.hasOwn(input, 'videoPath') || Object.hasOwn(input, 'referenceDuration')
    || Object.hasOwn(config, 'videoPath') || Object.hasOwn(config, 'referenceDuration')) {
    throw failure('VIDEO_REFERENCE_FORBIDDEN', '生成阶段仅接受制作文字和用户上传的替换图片，不能发送原视频或视频片段。');
  }
}

export function buildGenerationArguments(input) {
  rejectVideoReference(input);
  const { config = {}, imagePaths = [], prompt, duration, ratio = '9:16' } = input;
  if (!Number.isInteger(duration) || duration < 4 || duration > 30) throw failure('INVALID_DURATION', '生成视频时长须为 4–30 秒的整数。');
  if (!RATIOS.has(ratio)) throw failure('INVALID_RATIO', '视频比例仅支持 1:1、3:4、16:9、4:3、9:16、21:9。');
  if (!['480p', '720p'].includes(config.jimengResolution || '720p')) throw failure('INVALID_RESOLUTION', '当前本机 Seedance 2.5 分辨率仅支持 480p、720p。');
  if (typeof prompt !== 'string' || !prompt.trim()) throw failure('PROMPT_REQUIRED', '请填写替换内容或复刻要求。');
  if (!Array.isArray(imagePaths) || imagePaths.length > 30 || imagePaths.some((file) => typeof file !== 'string' || !IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()))) {
    throw failure('INVALID_REFERENCE', '参考图片最多 30 张，支持 PNG、JPG、JPEG、WebP、BMP。');
  }
  return [imagePaths.length ? 'multimodal2video' : 'text2video', ...imagePaths.flatMap((file) => ['--image', path.resolve(file)]),
    '--prompt', prompt, '--ratio', ratio, '--model_version', 'seedance2.5', '--duration', String(duration),
    '--video_resolution', config.jimengResolution || '720p', '--poll', '0'];
}

function firstJson(text) {
  // Official CLI emits pretty JSON, sometimes preceded by plain-text notices.
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0; let quoted = false; let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

function remoteFailure(value, submitId) {
  const reason = String(value.fail_reason || '');
  let message = '即梦未能完成此次视频生成，请在即梦查看任务详情。';
  if (/AigcComplianceConfirmationRequired/.test(reason)) message = '请先到即梦网页完成首次视频生成授权，再创建任务。';
  else if (/ExceedConcurrencyLimit/.test(reason)) message = '即梦账号已有运行中的任务，请等待原任务完成。';
  else if (/sensitive|moderation|compliance|risk|审核|违规/i.test(reason)) message = '即梦内容审核未通过，请调整参考素材或文案。';
  return failure('GENERATION_FAILED', message, { submitId });
}

async function runCommand(target, args, config, signal, submission = false) {
  if (signal?.aborted) throw failure('ABORTED', '已停止本地等待，已提交的远端任务仍可取回。');
  return new Promise((resolve, reject) => {
    let child; let stdout = ''; let stderr = ''; let stopped; let timer;
    const abort = () => stop('ABORTED');
    const stop = (code) => { stopped ||= code; child?.kill(); };
    try {
      // spawnProcess is a unit-test seam; HTTP request data must never set config.
      child = (config.spawnProcess || spawn)(target.executable, [...target.prefix, ...args], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: target.env,
      });
    } catch { reject(failure('CLI_START_FAILED', '无法启动本机即梦 CLI，请检查安装路径。')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('COMMAND_TIMEOUT'), config.commandTimeoutMs ?? 180_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => { stdout += data; if (stdout.length > 4_000_000) stop('OUTPUT_LIMIT'); });
    child.stderr.on('data', (data) => { stderr += data; if (stderr.length > 1_000_000) stop('OUTPUT_LIMIT'); });
    child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(failure('CLI_START_FAILED', '无法启动本机即梦 CLI，请检查安装路径。')); });
    child.once('close', (exitCode) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const value = firstJson(stdout);
      const submitId = typeof value?.submit_id === 'string' ? value.submit_id : undefined;
      if (stopped) {
        const code = submission ? 'OUTCOME_UNKNOWN' : stopped;
        reject(failure(code, submission ? '提交响应尚未确认。请先到即梦核对任务，勿重复生成。' : '本地查询已中断，原任务编号已保留，可继续取回。', { submitId }));
      } else if (value?.gen_status === 'fail') reject(remoteFailure(value, submitId));
      else if (exitCode !== 0) {
        const auth = /not logged|login required|unauthorized|未登录|登录.*失效/i.test(`${stderr}\n${stdout}`);
        const transient = TRANSIENT.test(`${stderr}\n${stdout}`);
        reject(failure(auth ? 'CLI_LOGIN_REQUIRED' : submission ? 'OUTCOME_UNKNOWN' : 'QUERY_FAILED',
          auth ? '即梦登录已失效，请在 Bowerbird 重新授权后取回原任务。' : submission ? '提交结果尚未确认。请先到即梦核对任务，勿重复生成。' : '暂时无法查询即梦任务，原编号已保留，可稍后继续取回。', { submitId, transient }));
      } else if (!value) reject(failure(submission ? 'OUTCOME_UNKNOWN' : 'INVALID_RESPONSE', '即梦未返回可识别的任务结果。请核对原任务状态，勿重复生成。'));
      else resolve(value);
    });
  });
}

async function outputVideos(directory) {
  const videos = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) videos.push(...await outputVideos(file));
    else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase()) && (await stat(file)).size > 0) videos.push(file);
  }
  return videos.sort();
}

async function pollGeneration({ config, submitId, outputDir, signal, onProgress }, target) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(submitId || '')) throw failure('INVALID_SUBMIT_ID', '缺少有效的原任务编号，无法取回视频。');
  if (!outputDir || !path.isAbsolute(outputDir)) throw failure('INVALID_OUTPUT_DIR', '无法定位本次任务的输出目录。');
  await mkdir(outputDir, { recursive: true });
  const expires = Date.now() + (config.generationTimeoutMs ?? 30 * 60_000);
  let retries = 0;
  try {
    while (Date.now() < expires) {
      let value;
      try {
        value = await runCommand(target, ['query_result', '--submit_id', submitId, '--download_dir', outputDir], config, signal);
        retries = 0;
      } catch (error) {
        if ((error.transient || error.code === 'COMMAND_TIMEOUT') && retries++ < 3) {
          await onProgress?.('即梦查询暂时中断，正在继续查询原任务。');
          await delay(config.queryIntervalMs ?? 10_000, undefined, { signal });
          continue;
        }
        throw error;
      }
      if (value.gen_status === 'success') {
        const videoPaths = await outputVideos(outputDir);
        if (!videoPaths.length) throw failure('DOWNLOAD_MISSING', '任务已完成，但视频尚未成功下载。可继续取回原任务。');
        return { submitId, videoPaths, videoPath: videoPaths[0] };
      }
      if (value.gen_status !== 'querying') throw failure('UNKNOWN_STATUS', '即梦返回了未知任务状态，请稍后取回原任务。');
      await onProgress?.('即梦正在生成视频，可稍后继续取回。');
      await delay(config.queryIntervalMs ?? 10_000, undefined, { signal });
    }
    throw failure('QUERY_TIMEOUT', '等待已结束，远端任务状态尚未确认。请继续取回原任务，勿重新生成。');
  } catch (error) {
    if (error.name === 'AbortError') throw failure('ABORTED', '已停止本地等待，远端任务仍可取回。', { submitId });
    error.submitId = submitId;
    throw error;
  }
}

export async function submitGeneration(input) {
  const args = buildGenerationArguments(input);
  const { config = {}, imagePaths = [], outputDir, onSubmitted, signal, onProgress } = input;
  for (const file of imagePaths) if (!await isFile(file) || (await stat(file)).size === 0) throw failure('REFERENCE_MISSING', '替换图片不存在或为空，请重新上传图片。');
  if (!outputDir || !path.isAbsolute(outputDir)) throw failure('INVALID_OUTPUT_DIR', '无法定位本次任务的输出目录。');
  await mkdir(outputDir, { recursive: true });
  await access(outputDir, constants.W_OK);
  const target = await invocation(config);
  await onProgress?.('正在向本机订阅的即梦渠道提交视频。');
  let value;
  try { value = await runCommand(target, args, config, signal, true); }
  catch (error) {
    if (error.submitId) {
      try { await onSubmitted?.(error.submitId); }
      catch { throw failure('TASK_SAVE_FAILED', '任务可能已提交，但本地保存编号失败。请记录此任务编号后取回，勿重新生成。', { submitId: error.submitId }); }
    }
    throw error;
  }
  const submitId = typeof value.submit_id === 'string' && value.submit_id.trim() ? value.submit_id : undefined;
  if (!submitId) throw failure('OUTCOME_UNKNOWN', '即梦未返回任务编号。请先到即梦核对任务，勿重复生成。');
  try { await onSubmitted?.(submitId); }
  catch { throw failure('TASK_SAVE_FAILED', '任务已提交，但本地保存编号失败。请记录此任务编号后取回，勿重新生成。', { submitId }); }
  return pollGeneration({ config, submitId, outputDir, signal, onProgress }, target);
}

export async function resumeGeneration(input) {
  rejectVideoReference(input);
  const { config = {}, submitId, outputDir, signal, onProgress } = input;
  const target = await invocation(config);
  return pollGeneration({ config, submitId, outputDir, signal, onProgress }, target);
}
