import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { get as httpGet, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDemoServer } from '../server.mjs';
import { readTask, writeTask } from '../lib/store.mjs';

const SOURCE = Buffer.from('fixture source video bytes');
const RESULT = Buffer.from('fixture generated video bytes');
const FAKE_KEY = 'test-only-fake-speech-key-never-send';
const META = { duration: 8, width: 720, height: 1280, hasAudio: true };
const TRANSCRIPT = {
  text: '原来的台词。第二句。', durationMs: 8000,
  utterances: [{ text: '原来的台词。', startMs: 500, endMs: 3200 }, { text: '第二句。', startMs: 4000, endMs: 7000 }],
  words: [{ text: '原来', startMs: 500, endMs: 1100 }, { text: '的台词', startMs: 1100, endMs: 3200 }],
  raw: { fixtureDiagnostic: 'raw-provider-output' },
};
const GENERATED_TRANSCRIPT = {
  text: '替换后的台词。第二句。', durationMs: 8000,
  utterances: [{ text: '替换后的台词。', startMs: 1200, endMs: 3600 }, { text: '第二句。', startMs: 4800, endMs: 7400 }],
  words: [{ text: '替换后的台词', startMs: 1200, endMs: 3600 }],
};
const ANALYSIS = {
  summary: '人物面向镜头介绍桌面产品。', style: '柔和自然光、简洁背景', provider: 'codex', frames: [],
  shots: [{ id: 'shot-1', startMs: 0, endMs: 8000, visual: '人物站在桌旁展示产品', camera: '正面中景', action: '举起产品并介绍', transition: 'cut' }],
};

async function fixture(mode = 'success', hooks = {}) {
  const root = await mkdtemp(join(tmpdir(), 'replication-demo-server-'));
  const dataDir = join(root, 'data');
  const binary = join(root, 'fixture-binary');
  await writeFile(binary, 'not executable; all media and generation operations are injected');
  await writeFile(join(root, '.env.local'), [
    `DOUBAO_SPEECH_API_KEY=${JSON.stringify(FAKE_KEY)}`,
    `FFMPEG_BINARY=${JSON.stringify(binary)}`, `FFPROBE_BINARY=${JSON.stringify(binary)}`,
  ].join('\n'));
  const calls = { fetch: 0, transcribe: 0, transcribePaths: [], analyze: 0, submit: [], resume: [], cuts: [], validated: 0, extractAudio: 0, render: [], assemble: 0 };
  const adapters = {
    async discoverJimengBinary() { return binary; },
    async discoverAnalysisBinary() { return binary; },
    async fetchDouyinVideo(options) {
      calls.fetch++;
      assert.equal(options.profileDir, join(dataDir, 'douyin-profile'));
      assert.match(options.input, /v\.douyin\.com/);
      await options.onProgress('离线夹具：读取参考视频');
      await writeFile(options.outputPath, SOURCE);
      return { path: options.outputPath, title: '离线参考视频', videoId: '1234567890123456' };
    },
    async prepareSource(path, dir) {
      assert.deepEqual(await readFile(path), SOURCE);
      await writeFile(join(dir, 'source.wav'), 'fixture audio');
      await writeFile(join(dir, 'source.jpg'), 'fixture poster');
      return { ...META };
    },
    async transcribeAudio(options) {
      calls.transcribe++;
      calls.transcribePaths.push(basename(options.audioPath));
      assert.equal(options.config.speechApiKey, FAKE_KEY);
      const generated = basename(options.audioPath) === 'generated.wav';
      assert.equal(await readFile(options.audioPath, 'utf8'), generated ? 'fixture generated audio' : 'fixture audio');
      const generatedOverride = generated ? await hooks.transcribeGenerated?.(options) : undefined;
      await options.onProgress('离线夹具：转写完成');
      return structuredClone(generated ? generatedOverride || GENERATED_TRANSCRIPT : TRANSCRIPT);
    },
    async analyzeReference(options) {
      calls.analyze++;
      assert.deepEqual(await readFile(options.videoPath), SOURCE);
      assert.deepEqual(options.transcript.utterances, TRANSCRIPT.utterances);
      await options.onProgress('离线夹具：画面拆解完成');
      return structuredClone(hooks.analysis || ANALYSIS);
    },
    async probeMedia(path) { return await hooks.probeMedia?.(path) || { ...META }; },
    async cutReference(source, outputPath, chunk) {
      calls.cuts.push(structuredClone(chunk));
      assert.deepEqual(await readFile(source), SOURCE);
      await writeFile(outputPath, SOURCE);
      return outputPath;
    },
    async submitGeneration(options) {
      assert.equal(Object.hasOwn(options, 'videoPath'), false, 'Source video must never enter generation');
      assert.equal(Object.hasOwn(options.config, 'referenceDuration'), false, 'Reference-video compatibility must not survive silently');
      calls.submit.push({ prompt: options.prompt, images: [...options.imagePaths], ratio: options.ratio, duration: options.duration });
      await hooks.submitGeneration?.(options);
      if (mode === 'unknown') throw Object.assign(new Error('synthetic transport failure before submission receipt'), { code: 'OUTCOME_UNKNOWN' });
      await options.onSubmitted('fixture-known-submit-id');
      if (mode === 'recover') throw new Error('synthetic transport failure after submission receipt');
      const path = join(options.outputDir, 'generated.mp4');
      await writeFile(path, RESULT);
      return { videoPath: path };
    },
    async resumeGeneration(options) {
      calls.resume.push(options.submitId);
      const path = join(options.outputDir, 'generated.mp4');
      await writeFile(path, RESULT);
      return { videoPath: path };
    },
    async concatenateVideos(paths, outputPath) {
      calls.assemble++;
      assert.ok(paths.length > 0);
      assert.deepEqual(await readFile(paths[0]), RESULT);
      await writeFile(outputPath, RESULT);
      return { ...META };
    },
    async extractAudio(inputPath, outputWav) {
      calls.extractAudio++;
      assert.deepEqual(await readFile(inputPath), RESULT);
      await writeFile(outputWav, 'fixture generated audio');
      return outputWav;
    },
    async renderCaptionedVideo(inputPath, srtPath, outputPath) {
      assert.deepEqual(await readFile(inputPath), RESULT);
      const srt = await readFile(srtPath, 'utf8');
      calls.render.push(srt);
      await hooks.renderCaptionedVideo?.({ srt, inputPath, outputPath });
      await writeFile(outputPath, RESULT);
      return { ...META };
    },
    async validateImage(path) {
      calls.validated++;
      assert.ok((await readFile(path)).length > 0);
      await hooks.validateImage?.(path);
      return { width: 100, height: 100 };
    },
  };
  let app, base, token;
  const start = async () => {
    app = await createDemoServer({ root, dataDir, adapters });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(`${base}/api/bootstrap`);
    assert.equal(response.status, 200);
    const bootstrap = await response.json();
    token = bootstrap.token;
    assert.equal(typeof token, 'string');
    assert.equal(bootstrap.config.speechConfigured, true);
    assert.equal(bootstrap.config.speechApiKeyConfigured, true);
    assert.equal(bootstrap.config.speechApiKey, undefined);
    assert.ok(!JSON.stringify(bootstrap).includes(FAKE_KEY));
    return bootstrap;
  };
  try { await start(); }
  catch (error) { await app?.close(); await rm(root, { recursive: true, force: true }); throw error; }
  const request = (path, body, options = {}) => fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Demo-Token': token, Origin: base }), ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options,
  });
  return {
    root, dataDir, calls, request,
    get base() { return base; }, get token() { return token; }, get server() { return app.server; },
    async restart() { await app.close(); await start(); },
    async close() { await app.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function json(response, expectedStatus = 200) {
  const body = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  assert.ok(!JSON.stringify(body).includes(FAKE_KEY));
  return body;
}

async function waitForTask(f, id, wanted) {
  const deadline = Date.now() + 5000;
  let task;
  do {
    ({ task } = await json(await f.request(`/api/tasks/${id}`)));
    if (wanted.includes(task.status)) { await delay(10); return task; }
    await delay(15);
  } while (Date.now() < deadline);
  assert.fail(`Task did not enter ${wanted.join('/')}: ${JSON.stringify(task)}`);
}

async function readyTask(f, { analyze = true } = {}) {
  const { task } = await json(await f.request('/api/tasks', { input: '分享 https://v.douyin.com/fixture123/' }), 202);
  await waitForTask(f, task.id, ['ready']);
  await json(await f.request(`/api/tasks/${task.id}/transcribe`, {}), 202);
  const transcribed = await waitForTask(f, task.id, ['transcribed']);
  if (!analyze) return transcribed;
  await json(await f.request(`/api/tasks/${task.id}/analyze`, {}), 202);
  return waitForTask(f, task.id, ['analyzed']);
}

test('HTTP demo completes source ASR → visual analysis → edits → generation without source video → new ASR and captions', async () => {
  const f = await fixture();
  try {
    const task = await readyTask(f), endpoint = `/api/tasks/${task.id}`;
    assert.deepEqual(task.meta, META);
    assert.deepEqual(task.transcript.utterances, TRANSCRIPT.utterances);
    assert.deepEqual(task.transcript.words, TRANSCRIPT.words);
    assert.equal(task.transcript.raw, undefined);
    assert.deepEqual(task.analysis, ANALYSIS);
    assert.match(await (await f.request(task.srtUrl)).text(), /00:00:00,500 --> 00:00:03,200/);
    await json(await f.request(`${endpoint}/transcribe`, {}));
    assert.equal(f.calls.transcribe, 1, 'existing ASR result must not be billed/submitted again');
    await json(await f.request(`${endpoint}/analyze`, {}));
    assert.equal(f.calls.analyze, 1, 'existing visual analysis must not be repeated');
    await json(await f.request(`${endpoint}/edits`, { replacements: { 0: '替换后的台词。' }, direction: '保留镜头节奏' }));
    const uploaded = await json(await f.request(`${endpoint}/assets`, { role: 'product', name: '新产品', dataUrl: 'data:image/png;base64,aW1hZ2UtZml4dHVyZQ==' }));
    await json(await f.request(`${endpoint}/edits`, { replacements: { 0: '替换后的台词。' }, direction: '保留镜头节奏', shots: { 'shot-1': { imageIds: [uploaded.task.images[0].id] } } }));
    const { chunks, inputVideoCount, workflow } = await json(await f.request(`${endpoint}/plan`));
    assert.equal(inputVideoCount, 0); assert.equal(workflow, 'storyboard-v2');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].lines[0].startMs, 500);
    assert.equal(chunks[0].lines[0].endMs, 3200);
    assert.equal(chunks[0].lines[0].text, '替换后的台词。');
    assert.match(chunks[0].prompt, /图片1是替换产品/);
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    const finished = await waitForTask(f, task.id, ['succeeded']);
    assert.equal(f.calls.fetch, 1); assert.equal(f.calls.validated, 1); assert.equal(f.calls.submit.length, 1);
    assert.equal(f.calls.cuts.length, 0);
    assert.deepEqual(f.calls.transcribePaths, ['source.wav', 'generated.wav']);
    assert.equal(f.calls.transcribe, 2); assert.equal(f.calls.extractAudio, 1); assert.equal(f.calls.render.length, 1);
    assert.equal(f.calls.submit[0].images.length, 1); assert.equal(f.calls.submit[0].ratio, '9:16');
    assert.match(f.calls.submit[0].prompt, /替换后的台词/);
    assert.match(f.calls.render[0], /00:00:01,200 --> 00:00:03,600/);
    assert.doesNotMatch(f.calls.render[0], /00:00:00,500|原来的台词/);
    assert.equal(await (await f.request(finished.runs[0].srtUrl)).text(), f.calls.render[0]);
    assert.deepEqual(await (await f.request(finished.runs[0].transcriptUrl)).json(), GENERATED_TRANSCRIPT);
    const resultUrl = finished.runs[0].resultUrl;
    const range = await f.request(resultUrl, undefined, { headers: { Range: 'bytes=3-8' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 3-8/${RESULT.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), RESULT.subarray(3, 9));
    const suffix = await f.request(resultUrl, undefined, { headers: { Range: 'bytes=-5' } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), RESULT.subarray(-5));
    const invalidRange = await f.request(resultUrl, undefined, { headers: { Range: 'bytes=999-1000' } });
    assert.equal(invalidRange.status, 416);
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    const repeated = (await json(await f.request(endpoint))).task;
    assert.equal(repeated.runs.length, 1); assert.equal(f.calls.submit.length, 1);
    assert.equal(f.calls.transcribe, 2, 'reopening completed result must not repeat output ASR');
    assert.equal(f.calls.render.length, 1); assert.equal(f.calls.cuts.length, 0);
    assert.ok(!JSON.stringify(await json(await f.request('/api/tasks'))).includes(f.root));
  } finally { await f.close(); }
});

test('unconfirmed generation submission is marked unknown and cannot be resubmitted', async () => {
  const f = await fixture('unknown');
  try {
    const task = await readyTask(f), endpoint = `/api/tasks/${task.id}`;
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    const failed = await waitForTask(f, task.id, ['failed']);
    assert.equal(failed.runs[0].status, 'unknown');
    assert.equal(failed.runs[0].chunks[0].status, 'unknown');
    assert.equal(failed.runs[0].chunks[0].submitId, null);
    for (const body of [{}, { newRun: true }]) {
      const response = await json(await f.request(`${endpoint}/generate`, body), 400);
      assert.match(response.error, /尚未确认/);
    }
    assert.equal(f.calls.submit.length, 1);
  } finally { await f.close(); }
});

test('image library exceeds three; each shot freezes only its selections across edits, removal and recovery', async () => {
  const analysis = { ...ANALYSIS, shots: [
    { ...ANALYSIS.shots[0], id: 'shot-1', endMs: 4000 },
    { ...ANALYSIS.shots[0], id: 'shot-2', startMs: 4000 },
  ] };
  const f = await fixture('recover', { analysis });
  try {
    const task = await readyTask(f), endpoint = `/api/tasks/${task.id}`;
    let images;
    for (const [role, name] of [['person', '人物甲'], ['person', '人物乙'], ['product', '产品甲'], ['product', '未选产品']]) {
      images = (await json(await f.request(`${endpoint}/assets`, { role, name, dataUrl: 'data:image/png;base64,aW1hZ2UtZml4dHVyZQ==' }))).task.images;
    }
    assert.equal(images.length, 4);
    const ids = images.map(image => image.id);
    const empty = await json(await f.request(`${endpoint}/plan`));
    assert.ok(empty.chunks.every(chunk => chunk.imageIds.length === 0));
    await json(await f.request(`${endpoint}/edits`, { shots: { 'shot-1': { imageIds: [ids[2], ids[0]] }, 'shot-2': { imageIds: [ids[1]] } } }));
    const { chunks } = await json(await f.request(`${endpoint}/plan`));
    assert.deepEqual(chunks.map(chunk => chunk.images.map(image => image.name)), [['产品甲', '人物甲'], ['人物乙']]);
    assert.match(chunks[0].prompt, /图片1是替换产品（产品甲）/); assert.match(chunks[0].prompt, /图片2是替换人物（人物甲）/);
    assert.doesNotMatch(chunks[0].prompt, /人物乙|未选产品/); assert.doesNotMatch(chunks[1].prompt, /人物甲|产品甲|未选产品/);
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    await waitForTask(f, task.id, ['failed']);
    await json(await f.request(`${endpoint}/edits`, { shots: { 'shot-1': { imageIds: [ids[1]] }, 'shot-2': { imageIds: [ids[3]] } } }));
    await json(await f.request(`${endpoint}/assets/${ids[1]}`, {}, { method: 'DELETE' }));
    const removed = (await json(await f.request(endpoint))).task;
    assert.deepEqual(removed.edits.shots['shot-1'].imageIds, []);
    await f.restart();
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    await waitForTask(f, task.id, ['failed']);
    assert.deepEqual(f.calls.submit.map(call => call.images.map(path => basename(path).split('.')[0])), [[ids[2], ids[0]], [ids[1]]]);
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    const finished = await waitForTask(f, task.id, ['succeeded']);
    assert.equal(f.calls.submit.length, 2);
    assert.deepEqual(finished.runs[0].chunks.map(chunk => chunk.imageIds), [[ids[2], ids[0]], [ids[1]]]);
    assert.deepEqual(finished.runs[0].chunks[1].images.map(image => image.name), ['人物乙']);
    assert.equal((await readTask(f.dataDir, task.id)).runs[0].images.length, 3, 'unused images are not frozen into new generation runs');
  } finally { await f.close(); }
});

test('missing or invalid per-shot image selections cannot start a generation', async () => {
  const f = await fixture();
  try {
    const task = await readyTask(f), endpoint = `/api/tasks/${task.id}`;
    for (const imageIds of ['bad', [randomUUID(), 'bad'], Array.from({ length: 31 }, () => randomUUID())]) {
      await json(await f.request(`${endpoint}/edits`, { shots: { 'shot-1': { imageIds } } }), 400);
    }
    const missing = randomUUID();
    await json(await f.request(`${endpoint}/edits`, { shots: { 'shot-1': { imageIds: [missing] } } }));
    assert.match((await json(await f.request(`${endpoint}/generate`, {}), 400)).error, /图片已移除/);
    assert.equal(f.calls.submit.length, 0);
    assert.equal((await json(await f.request(endpoint))).task.runs.length, 0);
  } finally { await f.close(); }
});

test('interrupted known submission rejects a new version and resumes the same ID after restart', async () => {
  const f = await fixture('recover');
  try {
    const task = await readyTask(f), endpoint = `/api/tasks/${task.id}`;
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    const interrupted = await waitForTask(f, task.id, ['failed']);
    assert.equal(interrupted.runs[0].status, 'interrupted');
    assert.equal(interrupted.runs[0].chunks[0].submitId, 'fixture-known-submit-id');
    const refused = await json(await f.request(`${endpoint}/generate`, { newRun: true }), 400);
    assert.match(refused.error, /恢复|继续|完成|未确认|已有/);
    assert.equal(f.calls.submit.length, 1);
    assert.equal((await json(await f.request(endpoint))).task.runs.length, 1);
    const frozenPrompt = interrupted.runs[0].chunks[0].prompt;
    await json(await f.request(`${endpoint}/edits`, { fullText: '此修改只属于未来的新版本', replacements: {}, shots: {} }));
    await f.restart();
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    const finished = await waitForTask(f, task.id, ['succeeded']);
    assert.equal(finished.runs.length, 1);
    assert.equal(f.calls.submit.length, 1);
    assert.deepEqual(f.calls.resume, ['fixture-known-submit-id']);
    assert.equal(finished.runs[0].chunks[0].prompt, frozenPrompt);
    assert.doesNotMatch(finished.runs[0].chunks[0].prompt, /此修改只属于未来/);
    assert.deepEqual(f.calls.transcribePaths, ['source.wav', 'generated.wav']);
    assert.equal(f.calls.cuts.length, 0);
  } finally { await f.close(); }
});

test('generation requires visual analysis and makes no paid submission before it exists', async () => {
  const f = await fixture();
  try {
    const task = await readyTask(f, { analyze: false }), endpoint = `/api/tasks/${task.id}`;
    const rejected = await json(await f.request(`${endpoint}/generate`, {}), 400);
    assert.match(rejected.error, /画面拆解|分镜|分析/);
    assert.equal(f.calls.analyze, 0); assert.equal(f.calls.submit.length, 0); assert.equal(f.calls.cuts.length, 0);
    assert.equal((await json(await f.request(endpoint))).task.runs.length, 0);
    // Validation failure must release the global generation reservation.
    await json(await f.request(`${endpoint}/analyze`, {}), 202);
    await waitForTask(f, task.id, ['analyzed']);
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    await waitForTask(f, task.id, ['succeeded']);
    assert.equal(f.calls.submit.length, 1);
  } finally { await f.close(); }
});

test('editable storyboard fields become the frozen generation prompt', async () => {
  const f = await fixture();
  try {
    const task = await readyTask(f), endpoint = `/api/tasks/${task.id}`;
    const fields = { visual: '白色桌面上的蓝色包装', camera: '从正上方俯拍', action: '手将包装缓慢打开', dialogue: '这是我新写的镜头台词。' };
    await json(await f.request(`${endpoint}/edits`, { shots: { 'shot-1': fields } }));
    const { chunks } = await json(await f.request(`${endpoint}/plan`));
    for (const [key, value] of Object.entries(fields)) assert.equal(chunks[0][key], value);
    assert.equal(chunks[0].dialogueIssue, '');
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    const finished = await waitForTask(f, task.id, ['succeeded']);
    for (const value of Object.values(fields)) assert.ok(f.calls.submit[0].prompt.includes(value));
    assert.deepEqual(finished.edits.shots['shot-1'], fields);
    assert.equal(finished.analysis.shots[0].visual, ANALYSIS.shots[0].visual, 'Source analysis evidence must remain available');
    assert.equal(finished.runs[0].inputVideoCount, 0); assert.equal(f.calls.cuts.length, 0);
  } finally { await f.close(); }
});

test('legacy video-reference runs query known IDs and cancel unsent chunks without submitting videos', async () => {
  const f = await fixture();
  try {
    const task = await readyTask(f, { analyze: false }), endpoint = `/api/tasks/${task.id}`;
    const stored = await readTask(f.dataDir, task.id);
    stored.status = 'interrupted';
    stored.runs = [{ id: randomUUID(), status: 'interrupted', createdAt: new Date().toISOString(), edits: structuredClone(stored.edits), images: [],
      chunks: [{ index: 0, startMs: 0, endMs: 4000, duration: 4, status: 'submitted', submitId: 'legacy-paid-id', prompt: '旧的参考视频方案' },
        { index: 1, startMs: 4000, endMs: 8000, duration: 4, status: 'pending', prompt: '旧的未付费参考视频方案' }] }];
    await writeTask(f.dataDir, stored);
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    const recovered = await waitForTask(f, task.id, ['failed']);
    assert.deepEqual(f.calls.resume, ['legacy-paid-id']); assert.equal(f.calls.submit.length, 0); assert.equal(f.calls.cuts.length, 0);
    assert.equal(recovered.runs[0].chunks[0].status, 'succeeded'); assert.equal(recovered.runs[0].chunks[1].status, 'cancelled');
    assert.equal(f.calls.transcribe, 1); assert.equal(f.calls.render.length, 0);
    assert.match(recovered.message, /旧方案|未提交|停止/);
  } finally { await f.close(); }
});

test('new-speech alignment failure resumes postprocessing without regenerating the completed shot', async () => {
  let generatedAttempts = 0;
  const f = await fixture('success', { transcribeGenerated: async () => { if (++generatedAttempts === 1) throw new Error('生成语音转写暂时失败。'); } });
  try {
    const task = await readyTask(f), endpoint = `/api/tasks/${task.id}`;
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    const interrupted = await waitForTask(f, task.id, ['failed']);
    assert.equal(interrupted.runs[0].status, 'interrupted'); assert.equal(interrupted.runs[0].stage, 'alignment');
    assert.equal(interrupted.runs[0].chunks[0].status, 'succeeded');
    assert.equal(f.calls.submit.length, 1); assert.equal(f.calls.render.length, 0);
    await f.restart();
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    await waitForTask(f, task.id, ['succeeded']);
    assert.equal(f.calls.submit.length, 1); assert.equal(f.calls.resume.length, 0);
    assert.deepEqual(f.calls.transcribePaths, ['source.wav', 'generated.wav', 'generated.wav']);
    assert.equal(f.calls.extractAudio, 2); assert.equal(f.calls.render.length, 1); assert.equal(f.calls.cuts.length, 0);
  } finally { await f.close(); }
});

test('caption render failure reuses the persisted new transcript after restart without another ASR charge', async () => {
  let renderAttempts = 0;
  const f = await fixture('success', { renderCaptionedVideo: async () => { if (++renderAttempts === 1) throw new Error('本机字幕合成暂时失败。'); } });
  try {
    const task = await readyTask(f), endpoint = `/api/tasks/${task.id}`;
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    const interrupted = await waitForTask(f, task.id, ['failed']);
    assert.equal(interrupted.runs[0].status, 'interrupted'); assert.equal(interrupted.runs[0].stage, 'captions');
    assert.deepEqual((await readTask(f.dataDir, task.id)).runs[0].transcript, GENERATED_TRANSCRIPT);
    await f.restart();
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    await waitForTask(f, task.id, ['succeeded']);
    assert.equal(f.calls.submit.length, 1); assert.equal(f.calls.resume.length, 0);
    assert.equal(f.calls.transcribe, 2); assert.equal(f.calls.extractAudio, 1); assert.equal(f.calls.render.length, 2);
    assert.equal(f.calls.render[0], f.calls.render[1]); assert.equal(f.calls.cuts.length, 0);
  } finally { await f.close(); }
});

test('missing output speech timestamps stops captions and retries ASR without regenerating video', async () => {
  let attempts = 0;
  const f = await fixture('success', { transcribeGenerated: async () => ++attempts === 1
    ? { text: GENERATED_TRANSCRIPT.text, utterances: [{ text: GENERATED_TRANSCRIPT.text, startMs: null, endMs: null, words: [] }] } : undefined });
  try {
    const task = await readyTask(f), endpoint = `/api/tasks/${task.id}`;
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    const interrupted = await waitForTask(f, task.id, ['failed']);
    assert.match(interrupted.error, /时间戳/);
    assert.equal(interrupted.runs[0].status, 'interrupted');
    assert.equal(interrupted.runs[0].srtUrl, null);
    assert.equal((await readTask(f.dataDir, task.id)).runs[0].transcript, undefined);
    assert.equal(f.calls.submit.length, 1); assert.equal(f.calls.render.length, 0);
    await f.restart();
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    await waitForTask(f, task.id, ['succeeded']);
    assert.equal(attempts, 2); assert.equal(f.calls.submit.length, 1); assert.equal(f.calls.resume.length, 0);
    assert.equal(f.calls.render.length, 1);
    assert.match(f.calls.render[0], /00:00:01,200/);
  } finally { await f.close(); }
});

test('a generated shot with planned dialogue but no audio fails before silence-padding or paid ASR', async () => {
  const f = await fixture('success', { probeMedia: async path => basename(path) === 'generated.mp4' ? { ...META, hasAudio: false } : { ...META } });
  try {
    const task = await readyTask(f), endpoint = `/api/tasks/${task.id}`;
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    const failed = await waitForTask(f, task.id, ['failed']);
    assert.equal(failed.runs[0].status, 'failed');
    assert.match(failed.error, /没有音轨|音轨/);
    assert.equal(f.calls.submit.length, 1); assert.equal(f.calls.assemble, 0);
    assert.equal(f.calls.extractAudio, 0); assert.equal(f.calls.transcribe, 1); assert.equal(f.calls.render.length, 0);
    assert.equal(f.calls.cuts.length, 0);
  } finally { await f.close(); }
});

test('global generation reservation rejects a second task while the first submission is pending', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture('success', { submitGeneration: async () => { entered.resolve(); await release.promise; } });
  try {
    const first = await readyTask(f), second = await readyTask(f);
    await json(await f.request(`/api/tasks/${first.id}/generate`, {}), 202);
    await entered.promise;
    const rejected = await json(await f.request(`/api/tasks/${second.id}/generate`, {}), 400);
    assert.match(rejected.error, /另一项|顺序|稍后/); assert.equal(f.calls.submit.length, 1);
    release.resolve(); await waitForTask(f, first.id, ['succeeded']);
    assert.equal(f.calls.cuts.length, 0);
  } finally { release.resolve(); await f.close(); }
});

test('slow edit body reserves the task before generation can read stale edits', { timeout: 10000 }, async () => {
  const f = await fixture();
  let slow, reply, tail;
  try {
    const task = await readyTask(f), endpoint = `/api/tasks/${task.id}`;
    const reading = Promise.withResolvers();
    f.server.once('request', incoming => {
      // jsonBody's async iterator adds this listener only after readTask has completed.
      incoming.on('newListener', name => { if (name === 'readable') reading.resolve(); });
    });
    const text = JSON.stringify({ fullText: '慢速上传的新台词', direction: '保持节奏', replacements: {} });
    const split = Math.floor(text.length / 2); tail = text.slice(split);
    reply = new Promise((resolve, reject) => {
      slow = httpRequest(`${f.base}${endpoint}/edits`, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Demo-Token': f.token, Origin: f.base,
      } }, response => {
        const parts = [];
        response.on('data', part => parts.push(part));
        response.once('end', () => resolve(new Response(Buffer.concat(parts), { status: response.statusCode })));
        response.once('error', reject);
      });
      slow.once('error', reject);
      slow.setTimeout(5000, () => slow.destroy(new Error('slow-body fixture timed out')));
      slow.write(text.slice(0, split));
    });
    await reading.promise;
    const refused = await json(await f.request(`${endpoint}/generate`, {}), 400);
    assert.match(refused.error, /正在|等待|处理中|稍后/);
    assert.equal(f.calls.submit.length, 0);
    slow.end(tail); tail = undefined;
    await json(await reply);
    const saved = (await json(await f.request(endpoint))).task;
    assert.equal(saved.edits.fullText, '慢速上传的新台词');
    assert.equal(saved.runs.length, 0);
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    await waitForTask(f, task.id, ['succeeded']);
    assert.equal(f.calls.submit.length, 1);
    assert.match(f.calls.submit[0].prompt, /慢速上传的新台词/);
  } finally {
    if (slow && !slow.writableEnded) slow.end(tail);
    await reply?.catch(() => {});
    await f.close();
  }
});

test('image validation keeps task locked until the replacement image is saved', { timeout: 10000 }, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture('success', { validateImage: async () => { entered.resolve(); await release.promise; } });
  let upload;
  try {
    const task = await readyTask(f), endpoint = `/api/tasks/${task.id}`;
    upload = f.request(`${endpoint}/assets`, { role: 'person', name: '新人物', dataUrl: 'data:image/png;base64,aW1hZ2UtZml4dHVyZQ==' });
    await entered.promise;
    const refused = await json(await f.request(`${endpoint}/generate`, {}), 400);
    assert.match(refused.error, /正在|等待|处理中|稍后/);
    assert.equal(f.calls.submit.length, 0);
    release.resolve();
    await json(await upload);
    const saved = (await json(await f.request(endpoint))).task;
    assert.equal(saved.images.length, 1);
    assert.equal(saved.runs.length, 0);
    await json(await f.request(`${endpoint}/edits`, { shots: { 'shot-1': { imageIds: [saved.images[0].id] } } }));
    await json(await f.request(`${endpoint}/generate`, {}), 202);
    await waitForTask(f, task.id, ['succeeded']);
    assert.equal(f.calls.submit.length, 1);
    assert.equal(f.calls.submit[0].images.length, 1);
    assert.match(f.calls.submit[0].prompt, /图片1是替换人物/);
  } finally {
    release.resolve();
    await upload?.catch(() => {});
    await f.close();
  }
});

test('HTTP access rejects cross-site writes, missing tokens, foreign hosts and private paths', async () => {
  const f = await fixture();
  try {
    const mutation = { input: 'https://v.douyin.com/fixture123/' };
    for (const headers of [
      { 'Content-Type': 'application/json', Origin: f.base },
      { 'Content-Type': 'application/json', 'X-Demo-Token': 'wrong-token', Origin: f.base },
      { 'Content-Type': 'application/json', 'X-Demo-Token': f.token, Origin: 'https://untrusted.invalid' },
    ]) {
      const response = await fetch(`${f.base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify(mutation) });
      assert.equal(response.status, 403);
      assert.ok(!(await response.text()).includes(FAKE_KEY));
    }
    // Node fetch normalizes Host, so use the HTTP client to send the hostile header verbatim.
    const foreignHost = await new Promise((resolve, reject) => {
      httpGet(`${f.base}/api/bootstrap`, { headers: { Host: 'untrusted.invalid:80' } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      }).once('error', reject);
    });
    assert.equal(foreignHost, 403);
    for (const path of ['/.env.local', '/data/.env.local', '/server.mjs', '/media/00000000-0000-0000-0000-000000000000/task.json',
      '/media/00000000-0000-0000-0000-000000000000/%2e%2e%2f.env.local']) {
      const response = await f.request(path);
      assert.equal(response.status, 404, path);
      assert.ok(!(await response.text()).includes(FAKE_KEY));
    }
    assert.equal(f.calls.fetch, 0);
    const config = await json(await f.request('/api/config', { speechApiKey: 'replacement-fake-secret' }));
    assert.equal(config.config.speechApiKey, undefined);
    assert.equal(config.config.speechApiKeyConfigured, true);
    assert.ok(!JSON.stringify(config).includes('replacement-fake-secret'));
    assert.match(await readFile(join(f.root, '.env.local'), 'utf8'), /replacement-fake-secret/);
  } finally { await f.close(); }
});
