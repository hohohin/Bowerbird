import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, writeFile, stat, unlink, realpath } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { loadConfig, saveConfig, publicConfig } from './lib/config.mjs';
import { createTask, readTask, writeTask, listTasks, taskDirectory, publicTask } from './lib/store.mjs';
import { findMediaBinary, prepareSource, probeMedia, concatenateVideos, validateImage } from './lib/media.mjs';
import { WORKFLOW, createClipPlan, resolveShotImages, makeGenerationPrompt, transcriptToSrt, captionsFromTranscript, dialogueWarning } from './lib/plan.mjs';
import { analyzeReference, discoverAnalysisBinary } from './lib/analysis.mjs';
import { extractAudio, renderCaptionedVideo } from './lib/composition.mjs';
import { fetchDouyinVideo } from './lib/douyin.mjs';
import { transcribeAudio } from './lib/asr.mjs';
import { discoverJimengBinary, submitGeneration, resumeGeneration } from './lib/generation.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.wav': 'audio/wav', '.json': 'application/json; charset=utf-8', '.srt': 'text/plain; charset=utf-8' };
const BUSY = new Set(['downloading', 'transcribing', 'analyzing', 'generating']);
function closestRatio(width, height) {
  return ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'].map(name => {
    const [w, h] = name.split(':').map(Number); return { name, difference: Math.abs(Math.log((width / height) / (w / h))) };
  }).sort((a, b) => a.difference - b.difference)[0].name;
}

function errorMessage(error, fallback) {
  const message = String(error?.message || '');
  return /[\u4e00-\u9fff]/.test(message) && message.length < 500 && !/(?:https?:\/\/|Bearer |api[_-]?key\s*[:=]|\bat\s+.*:\d|[A-Z]:\\)/i.test(message) ? message : fallback;
}
async function jsonBody(request, max = 15 * 1024 * 1024) {
  if (!String(request.headers['content-type']).startsWith('application/json')) throw new Error('请求格式不正确。');
  if (Number(request.headers['content-length'] || 0) > max) throw new Error('上传内容过大。');
  let size = 0; const parts = [];
  for await (const part of request) { size += part.length; if (size > max) throw new Error('上传内容过大。'); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new Error('请求内容无法读取。'); }
}
function send(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); }

export async function createDemoServer({ root = here, dataDir = join(root, 'data'), adapters = {} } = {}) {
  const ops = { fetchDouyinVideo, transcribeAudio, analyzeReference, discoverAnalysisBinary, discoverJimengBinary, submitGeneration, resumeGeneration,
    prepareSource, probeMedia, concatenateVideos, extractAudio, renderCaptionedVideo, validateImage, ...adapters };
  const token = randomBytes(32).toString('hex'), active = new Map(), writes = new Map(), mutationLocks = new Set();
  let generationOwner = null;
  await mkdir(join(dataDir, 'tasks'), { recursive: true });
  const save = task => {
    const snapshot = structuredClone(task);
    const promise = (writes.get(task.id) || Promise.resolve()).catch(() => {}).then(() => writeTask(dataDir, snapshot));
    writes.set(task.id, promise); return promise;
  };
  for (const task of await listTasks(dataDir)) if (BUSY.has(task.status)) {
    task.status = 'interrupted'; task.message = '上次运行已中断，已保存进度。';
    for (const run of task.runs || []) if (run.status === 'running') {
      run.status = 'interrupted';
      for (const chunk of run.chunks) if (chunk.status === 'submitting' && !chunk.submitId) {
        chunk.status = 'unknown'; run.status = 'unknown'; task.message = '有一次视频提交尚未确认结果，请先在即梦任务历史核对，避免重复生成。';
      }
    }
    await save(task);
  }
  const environment = async config => {
    const result = {};
    for (const name of ['ffmpeg', 'ffprobe']) {
      try { result[name] = { ready: true, path: await findMediaBinary(name, config[`${name}Binary`]) }; }
      catch { result[name] = { ready: false }; }
    }
    for (const [name, discover] of [['jimeng', ops.discoverJimengBinary], ['codex', ops.discoverAnalysisBinary]]) {
      try { const path = await discover(config); result[name] = { ready: Boolean(path), path: path || undefined }; }
      catch { result[name] = { ready: false }; }
    }
    return result;
  };
  const requireIdle = task => { if (active.has(task.id)) throw new Error('当前步骤正在运行，请等待完成后再修改。'); };
  async function launch(task, status, action) {
    requireIdle(task);
    const controller = new AbortController(); active.set(task.id, controller);
    task.status = status; delete task.error;
    try { await save(task); } catch (error) { active.delete(task.id); throw error; }
    const progress = async message => { task.message = message; await save(task); };
    // Every state-changing action is registered before returning to the browser.
    void (async () => {
      try { await action(controller.signal, progress); }
      catch (error) {
        task.status = 'failed'; task.error = errorMessage(error, '这一步未能完成，请检查配置后重试。已完成的内容仍然保留。'); task.message = task.error;
        const run = task.runs.at(-1);
        if (status === 'generating' && run && run.status === 'running') {
          const current = run.chunks.find(chunk => ['submitting', 'submitted', 'preparing'].includes(chunk.status));
          if (current && error.submitId && !current.submitId) current.submitId = error.submitId;
          if (error.code === 'GENERATION_FAILED') { if (current) current.status = 'failed'; run.status = 'failed'; }
          else if (current && !current.submitId && current.status === 'submitting') {
            const definitelyNotSubmitted = /^(INVALID_|VIDEO_REFERENCE_FORBIDDEN$|CLI_MISSING$|CLI_BINARY_INVALID$|CLI_PROFILE_MISSING$|CLI_LOGIN_REQUIRED$|CLI_START_FAILED$|REFERENCE_MISSING$|PROMPT_REQUIRED$)/.test(error.code || '');
            current.status = definitelyNotSubmitted ? 'pending' : 'unknown';
            run.status = definitelyNotSubmitted ? 'interrupted' : 'unknown';
          } else run.status = 'interrupted';
        }
      } finally {
        try { await save(task); } finally { active.delete(task.id); if (generationOwner === task.id) generationOwner = null; }
      }
    })();
  }
  async function acquire(task) {
    const config = await loadConfig(root), dir = taskDirectory(dataDir, task.id);
    await launch(task, 'downloading', async (signal, onProgress) => {
      task.message = '正在打开独立采集窗口…';
      let downloaded = false;
      try { await access(join(dir, 'source.mp4')); downloaded = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!downloaded) {
        const result = await ops.fetchDouyinVideo({ input: task.input, outputPath: join(dir, 'source.mp4'), profileDir: join(dataDir, 'douyin-profile'), browserExecutable: config.browserExecutable || undefined, signal, onProgress,
          validateVideo: async file => { const meta = await ops.probeMedia(file, config, signal); if (!meta.width || !meta.height || meta.duration < 4 || meta.duration > 120) throw new Error('请使用可解码的 4–120 秒抖音视频。'); },
        });
        task.title = result.title || '抖音参考视频'; task.videoId = result.videoId;
      }
      await onProgress('视频已下载，正在读取画面和音轨…');
      task.meta = await ops.prepareSource(join(dir, 'source.mp4'), dir, config, signal);
      task.status = 'ready'; task.message = task.meta.hasAudio ? '视频已就绪，可以进行豆包语音转写。' : '视频没有音轨，可记录为空转写后继续替换画面。';
    });
  }
  function validateEdits(value) {
    const { fullText = '', direction = '', replacements = {}, shots = {} } = value;
    if (typeof fullText !== 'string' || fullText.length > 12000 || typeof direction !== 'string' || direction.length > 4000 || !replacements || Array.isArray(replacements) || typeof replacements !== 'object') throw new Error('替换文案格式不正确或文字过长。');
    for (const [key, text] of Object.entries(replacements)) if (!/^\d+$/.test(key) || typeof text !== 'string' || text.length > 4000) throw new Error('逐句替换内容不正确。');
    if (!shots || typeof shots !== 'object' || Array.isArray(shots) || Object.keys(shots).length > 24) throw new Error('分镜修改格式不正确。');
    for (const [id, fields] of Object.entries(shots)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('分镜修改格式不正确。');
      for (const [key, text] of Object.entries(fields)) {
        if (key === 'imageIds') {
          if (!Array.isArray(text) || text.length > 30 || new Set(text).size !== text.length || text.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))) throw new Error('每个镜头最多选择 30 张不同的人物或产品图片。');
        } else if (!['visual', 'camera', 'action', 'dialogue'].includes(key) || typeof text !== 'string' || text.length > 4000) throw new Error('分镜描述不正确或文字过长。');
      }
    }
    return { fullText, direction, replacements, shots };
  }
  const planned = task => createClipPlan(task.meta?.duration * 1000, task.transcript, task.edits, task.analysis)
    .map(chunk => {
      const images = resolveShotImages(chunk, task.images);
      return { ...chunk, images: images.map(({ id, name, role }) => ({ id, name, role })), prompt: makeGenerationPrompt(chunk, task.edits, images) };
    });
  async function generate(task, newRun) {
    requireIdle(task);
    if (!task.transcript || !task.meta) throw new Error('请先完成视频获取与转写。');
    if (generationOwner) throw new Error('另一项视频正在生成。本机订阅渠道按任务顺序运行，请稍后再试。');
    let run = task.runs.at(-1);
    if (run?.status === 'unknown') throw new Error('上一次提交的结果尚未确认，请先在即梦任务历史中核对；Demo 不会自动再提交。');
    if (newRun && run && !['succeeded', 'failed'].includes(run.status)) throw new Error('原任务尚未结束，请先继续原任务，取得结果后再生成新版本。');
    if (run?.status === 'succeeded' && !newRun) return;
    if (run?.status === 'failed' && !newRun) throw new Error('即梦已确认这次生成失败。请调整内容后选择生成新版本。');
    // Reserve synchronously, before reading configuration or probing the executable.
    generationOwner = task.id;
    try {
    const config = await loadConfig(root);
    if (!(await ops.discoverJimengBinary(config))) throw new Error('未找到即梦官方 CLI，请在配置中填写程序路径，并先在 Bowerbird 完成本机即梦登录。');
    if (!run || newRun) {
      const chunks = planned(task);
      const issue = chunks.find(chunk => chunk.dialogueIssue);
      if (issue) throw new Error(`分镜 ${issue.index + 1}：${issue.dialogueIssue}`);
      if (chunks.some(chunk => chunk.dialogue.trim()) && !publicConfig(config).speechConfigured) throw new Error('生成后的实际语音需要重新对齐，请先配置豆包语音 Key。');
      run = { id: randomUUID(), workflow: WORKFLOW, inputVideoCount: 0, createdAt: new Date().toISOString(), status: 'running',
        edits: structuredClone(task.edits), images: structuredClone(task.images.filter(image => chunks.some(chunk => chunk.imageIds.includes(image.id)))), chunks: chunks.map(chunk => ({ ...chunk, status: 'pending' })) };
      task.runs.push(run);
    } else {
      run.status = 'running';
    }
    task.message = '已保存分镜计划，生成仅提交镜头文字和替换图片…';
      await launch(task, 'generating', async (signal, onProgress) => {
        const dir = taskDirectory(dataDir, task.id), runDir = join(dir, 'runs', run.id);
        await mkdir(runDir, { recursive: true });
        await writeFile(join(runDir, 'plan.json'), JSON.stringify({ ...run, note: 'Source video and extracted frames are analysis evidence only; they are not video-generation inputs.' }, null, 2));
        run.stage = 'shots';
        for (const chunk of run.chunks) {
          if (chunk.status === 'succeeded' || chunk.status === 'cancelled') continue;
          if (chunk.status === 'unknown' || (chunk.status === 'submitting' && !chunk.submitId)) throw new Error('某段提交结果尚未确认，请先核对即梦历史任务。');
          const prefix = `镜头 ${chunk.index + 1}/${run.chunks.length}：`;
          const partDir = join(runDir, `part-${chunk.index}`);
          const outputDir = join(partDir, 'generated'); await mkdir(outputDir, { recursive: true });
          const report = message => onProgress(prefix + message);
          let result;
          if (chunk.submitId) {
            chunk.status = 'submitted'; await save(task);
            result = await ops.resumeGeneration({ config, submitId: chunk.submitId, outputDir, signal, onProgress: report });
          } else {
            if (run.workflow !== WORKFLOW) { chunk.status = 'cancelled'; await save(task); continue; }
            await report('按分镜描述生成，不上传原视频…');
            chunk.status = 'submitting'; await save(task);
            result = await ops.submitGeneration({ config,
              imagePaths: resolveShotImages({ ...chunk, imageIds: chunk.imageIds ?? run.images.map(image => image.id) }, run.images).map(image => join(dir, 'assets', image.file)), prompt: chunk.prompt, duration: chunk.duration,
              ratio: closestRatio(task.meta.width, task.meta.height), outputDir, signal, onProgress: report,
              onSubmitted: async submitId => { chunk.submitId = submitId; chunk.status = 'submitted'; await save(task); },
            });
          }
          const output = result.videoPath || result.videoPaths?.[0];
          if (!output) throw new Error('即梦任务已返回，但尚未取得视频文件。请继续查询原任务。');
          const outputMeta = await ops.probeMedia(output, config, signal);
          if (!outputMeta.width || !outputMeta.height) throw new Error('生成结果无法解码，请继续查询原任务。');
          chunk.outputPath = output; chunk.outputMeta = outputMeta; chunk.status = 'succeeded'; await save(task);
          if (run.workflow === WORKFLOW && chunk.dialogue?.trim() && !outputMeta.hasAudio) {
            run.status = 'failed'; throw new Error(`镜头 ${chunk.index + 1} 的生成素材没有音轨，无法对齐台词。请检查生成内容后决定是否生成新版本。`);
          }
        }
        if (run.chunks.some(chunk => chunk.status === 'cancelled')) {
          run.status = 'failed'; task.status = 'failed'; task.message = '旧方案已提交的镜头已取回；未提交部分已停止。请完成画面拆解后生成新版本。'; return;
        }
        run.stage = 'assembly'; await onProgress('镜头已齐，正在按分镜顺序合成…');
        const assembled = join(runDir, 'assembled.mp4');
        const assembledMeta = await ops.concatenateVideos(run.chunks.map(chunk => chunk.outputPath), assembled, config, signal);
        const expected = run.chunks.map(chunk => chunk.dialogue || '').join('');
        if (run.workflow === WORKFLOW && expected.trim()) {
          if (!assembledMeta.hasAudio) {
            run.status = 'failed'; throw new Error('生成素材没有音轨，无法对齐台词。请检查镜头结果后生成新版本。');
          }
          run.stage = 'alignment'; await onProgress('正在识别新视频的实际语音时间，用于独立字幕…');
          if (!run.transcript) {
            const audioPath = join(runDir, 'generated.wav'); await ops.extractAudio(assembled, audioPath, config, signal);
            run.transcript = await ops.transcribeAudio({ audioPath, config, signal, onProgress }); await save(task);
          }
          await writeFile(join(runDir, 'transcript.json'), JSON.stringify(run.transcript, null, 2));
          run.warning = dialogueWarning(expected, run.transcript.text);
        }
        const srt = transcriptToSrt(captionsFromTranscript(run.transcript || { utterances: [] }));
        if (run.transcript?.text?.trim() && !srt.trim()) {
          delete run.transcript; await save(task);
          throw new Error('新语音转写未返回有效字幕时间戳。请继续原任务重试语音识别，已生成镜头会直接复用。');
        }
        await writeFile(join(runDir, 'captions.srt'), srt); run.captionsReady = true;
        run.stage = 'captions'; await onProgress('正在本机叠加字幕并导出成片…');
        run.resultMeta = await ops.renderCaptionedVideo(assembled, join(runDir, 'captions.srt'), join(runDir, 'result.mp4'), config, signal);
        run.stage = 'complete'; run.status = 'succeeded'; run.completedAt = new Date().toISOString(); task.status = 'succeeded';
        task.message = run.warning || '镜头生成与字幕合成完成，可以对照原片验收。';
      });
    } catch (error) { if (generationOwner === task.id) generationOwner = null; throw error; }
  }
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let status = 400, mutationId;
    try {
      const host = request.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { send(response, 403, { error: '仅允许本机访问。' }); return; }
      const url = new URL(request.url, `http://${host}`), path = url.pathname;
      if (!['GET', 'HEAD'].includes(request.method)) {
        if (request.headers['x-demo-token'] !== token || (request.headers.origin && request.headers.origin !== `http://${host}`)) { send(response, 403, { error: '页面会话已过期，请刷新 Demo 后重试。' }); return; }
      }
      if (path === '/api/bootstrap' && request.method === 'GET') { const config = await loadConfig(root); send(response, 200, { token, config: publicConfig(config), environment: await environment(config), tasks: (await listTasks(dataDir)).map(publicTask) }); return; }
      if (path === '/api/config' && request.method === 'POST') { const config = await saveConfig(root, await jsonBody(request, 64000)); send(response, 200, { config, environment: await environment(await loadConfig(root)) }); return; }
      if (path === '/api/tasks' && request.method === 'GET') { send(response, 200, { tasks: (await listTasks(dataDir)).map(publicTask) }); return; }
      if (path === '/api/tasks' && request.method === 'POST') {
        const { input } = await jsonBody(request, 16000);
        if (typeof input !== 'string' || !input.trim() || input.length > 8000) throw new Error('请粘贴一个抖音视频分享链接。');
        const task = await createTask(dataDir, input.trim()); await acquire(task); send(response, 202, { task: publicTask(task) }); return;
      }
      const match = /^\/api\/tasks\/([0-9a-f-]{36})(?:\/(.*))?$/.exec(path);
      if (match) {
        if (!['GET', 'HEAD'].includes(request.method)) {
          if (active.has(match[1]) || mutationLocks.has(match[1])) throw new Error('当前步骤正在运行，请等待完成后再修改。');
          mutationId = match[1]; mutationLocks.add(mutationId);
        }
        let task;
        try { task = await readTask(dataDir, match[1]); } catch (error) { if (error.code === 'ENOENT') { status = 404; throw new Error('未找到此任务。'); } throw error; }
        const action = match[2] || '';
        if (!action && request.method === 'GET') { send(response, 200, { task: publicTask(task) }); return; }
        if (action === 'plan' && request.method === 'GET') { send(response, 200, { workflow: WORKFLOW, inputVideoCount: 0, chunks: planned(task) }); return; }
        requireIdle(task);
        if (action === 'acquire' && request.method === 'POST') { if (task.meta) throw new Error('该任务已有视频，请新建任务来更换来源。'); await acquire(task); send(response, 202, { task: publicTask(task) }); return; }
        if (action === 'transcribe' && request.method === 'POST') {
          if (!task.meta) throw new Error('请先获取视频。');
          if (task.transcript) { send(response, 200, { task: publicTask(task) }); return; }
          const config = await loadConfig(root), dir = taskDirectory(dataDir, task.id);
          if (task.meta.hasAudio && !publicConfig(config).speechConfigured) throw new Error('请先在配置中填写豆包语音 API Key。');
          task.message = '正在准备语音转写…';
          await launch(task, 'transcribing', async (signal, onProgress) => {
            task.transcript = task.meta.hasAudio ? await ops.transcribeAudio({ audioPath: join(dir, 'source.wav'), config, signal, onProgress })
              : { text: '', utterances: [], words: [], durationMs: task.meta.duration * 1000, noSpeech: true };
            await writeFile(join(dir, 'transcript.json'), JSON.stringify(task.transcript, null, 2));
            await writeFile(join(dir, 'source.srt'), transcriptToSrt(task.transcript));
            task.status = 'transcribed'; task.message = task.transcript.text ? '转写已完成，可以开始画面拆解。' : '没有识别到语音，可以继续画面拆解。';
          }); send(response, 202, { task: publicTask(task) }); return;
        }
        if (action === 'analyze' && request.method === 'POST') {
          if (!task.meta || !task.transcript) throw new Error('请先获取视频并完成原声转写。');
          if (task.analysis) { send(response, 200, { task: publicTask(task) }); return; }
          const config = await loadConfig(root), dir = taskDirectory(dataDir, task.id);
          if (!(await ops.discoverAnalysisBinary(config))) throw new Error('未找到本机 Codex，请在服务配置中填写程序路径，并在 Bowerbird 完成登录。');
          task.message = '正在本机抽帧，准备镜头分析…';
          await launch(task, 'analyzing', async (signal, onProgress) => {
            const analysis = await ops.analyzeReference({ videoPath: join(dir, 'source.mp4'), meta: task.meta, transcript: task.transcript,
              outputDir: join(dir, 'analysis'), config, signal, onProgress });
            createClipPlan(task.meta.duration * 1000, task.transcript, {}, analysis);
            task.analysis = analysis; await writeFile(join(dir, 'analysis.json'), JSON.stringify(analysis, null, 2));
            task.status = 'analyzed'; task.message = '画面拆解完成。请查看分镜，并替换台词、人物或产品。';
          }); send(response, 202, { task: publicTask(task) }); return;
        }
        if (action === 'edits' && request.method === 'POST') { task.edits = validateEdits(await jsonBody(request, 512000)); await save(task); send(response, 200, { task: publicTask(task) }); return; }
        if (action === 'assets' && request.method === 'POST') {
          if (!task.meta) throw new Error('请先获取参考视频。');
          const body = await jsonBody(request), image = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(body.dataUrl || '');
          if (!image || !['person', 'product'].includes(body.role)) throw new Error('请上传 PNG、JPEG 或 WebP 图片，并选择人物或产品用途。');
          const bytes = Buffer.from(image[2], 'base64'); if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('每张图片需要小于 10 MB。');
          const id = randomUUID(), file = `${id}.${image[1] === 'jpeg' ? 'jpg' : image[1]}`, dir = join(taskDirectory(dataDir, task.id), 'assets');
          await mkdir(dir, { recursive: true }); const filePath = join(dir, file); await writeFile(filePath, bytes);
          try { await ops.validateImage(filePath, await loadConfig(root)); } catch (error) { await unlink(filePath); throw error; }
          task.images.push({ id, file, role: body.role, name: String(body.name || '参考图片').slice(0, 120) }); await save(task); send(response, 200, { task: publicTask(task) }); return;
        }
        if (/^assets\/[0-9a-f-]{36}$/.test(action) && request.method === 'DELETE') {
          const id = action.split('/')[1]; task.images = task.images.filter(image => image.id !== id);
          for (const shot of Object.values(task.edits.shots || {})) if (Array.isArray(shot.imageIds)) shot.imageIds = shot.imageIds.filter(imageId => imageId !== id);
          // Older runs retain their frozen image references; detach from the new edit only.
          await save(task); send(response, 200, { task: publicTask(task) }); return;
        }
        if (action === 'generate' && request.method === 'POST') { const body = await jsonBody(request, 1000); await generate(task, body.newRun === true); send(response, 202, { task: publicTask(task) }); return; }
      }
      let file;
      if (path.startsWith('/media/')) {
        const media = /^\/media\/([0-9a-f-]{36})\/(source\.(mp4|jpg|wav|srt)|transcript\.json|assets\/[0-9a-f-]{36}\.(png|jpg|webp)|analysis\/[A-Za-z0-9_-]+\/frame-[A-Za-z0-9_-]+\.jpg|runs\/[0-9a-f-]{36}\/(result\.mp4|captions\.srt|transcript\.json))$/.exec(path);
        if (!media) { status = 404; throw new Error('未找到文件。'); }
        const base = await realpath(taskDirectory(dataDir, media[1])); file = await realpath(join(base, media[2]));
        if (!file.startsWith(base + sep)) throw new Error('文件路径无效。');
      } else {
        const files = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
        if (!files[path] || !['GET', 'HEAD'].includes(request.method)) { send(response, 404, { error: '未找到页面。' }); return; }
        file = join(here, 'public', files[path]);
      }
      const info = await stat(file); response.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Accept-Ranges', 'bytes');
      let start = 0, end = info.size - 1;
      if (request.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (!range || (!range[1] && !range[2])) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
        if (!range[1]) start = Math.max(0, info.size - Number(range[2]));
        else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
        if (start > end || start >= info.size) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
        response.statusCode = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      }
      response.setHeader('Content-Length', Math.max(0, end - start + 1));
      if (request.method === 'HEAD') response.end(); else { const stream = createReadStream(file, { start, end }); stream.on('error', () => response.destroy()); stream.pipe(response); }
    } catch (error) {
      if (!response.headersSent) send(response, status, { error: errorMessage(error, '操作未完成，请检查输入和本机配置后重试。') }); else response.destroy();
    } finally { if (mutationId) mutationLocks.delete(mutationId); }
  });
  return { server, dataDir, async close() { for (const controller of active.values()) controller.abort(new Error('Demo 已停止，已保存的任务可在重启后恢复。')); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createDemoServer();
  const port = Number(process.env.REPLICATION_DEMO_PORT || 1768);
  app.server.listen(port, '127.0.0.1', () => console.log(`Replication Lab: http://127.0.0.1:${port}`));
  app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Demo 端口已被使用，请打开现有页面或更换 REPLICATION_DEMO_PORT。' : 'Demo 启动失败。'); process.exitCode = 1; });
  process.on('SIGINT', async () => { await app.close(); });
  process.on('SIGTERM', async () => { await app.close(); });
}
