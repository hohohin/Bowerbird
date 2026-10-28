import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { analyzeReference, discoverAnalysisBinary, validateAnalysis } from '../lib/analysis.mjs';
import { runProcess } from '../lib/media.mjs';

function valid(duration = 8000) {
  const parts = Math.ceil(duration / 15000);
  return { summary: '人物展示一件产品。', style: '浅色背景，中景构图，柔和光线。', shots: Array.from({ length: parts }, (_, index) => ({
    id: `shot-${index + 1}`, startMs: Math.round(index * duration / parts), endMs: Math.round((index + 1) * duration / parts),
    visual: '人物位于中央，手持产品。', camera: '中景正面，抽帧不足，无法确认运镜。', action: '人物介绍产品。', transition: '抽帧不足，无法确认。',
  })) };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'analysis-unit-'));
  t.after(async () => { assert.ok(path.basename(root).startsWith('analysis-unit-')); await rm(root, { recursive: true, force: true }); });
  const app = path.join(root, 'private-app'), profile = path.join(app, 'cli-profiles', 'codex');
  const vendor = path.join(app, 'codex-cli', 'vendor', 'native', 'bin'), runtime = path.join(app, 'cli-runtime', '26.10.1');
  await Promise.all([mkdir(profile, { recursive: true }), mkdir(vendor, { recursive: true }), mkdir(runtime, { recursive: true })]);
  const binary = path.join(vendor, process.platform === 'win32' ? 'codex.exe' : 'codex');
  const ffmpeg = path.join(root, 'ffmpeg.exe'), videoPath = path.join(root, 'source.mp4');
  await Promise.all([writeFile(binary, 'mock'), writeFile(ffmpeg, 'mock'), writeFile(videoPath, 'mock video'),
    writeFile(path.join(profile, 'auth.json'), 'synthetic-credential-do-not-read'), writeFile(path.join(profile, 'config.toml'), '[mcp_servers.must_not_load]\ncommand="never-run"'),
    writeFile(path.join(runtime, 'cli-launcher.exe'), 'mock')]);
  const calls = [];
  const config = { bowerbirdAppData: app, ffmpegBinary: ffmpeg,
    runMediaProcess: async (executable, args, options) => { calls.push({ executable, args, options }); await writeFile(args.at(-1), Buffer.from([255, 216, 255, 224, 1])); },
  };
  return { root, app, profile, binary, calls, config, videoPath, outputDir: path.join(root, 'analysis'), meta: { duration: 8, width: 1080, height: 1920 } };
}

function mockSpawn(result, inspect = () => {}, { exitCode = 0, stderr = '', hang = false, noFile = false } = {}) {
  return (binary, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    let prompt = '', closed = false;
    child.stdin.on('data', chunk => { prompt += chunk; });
    const close = code => { if (!closed) { closed = true; child.emit('close', code); } };
    child.kill = () => { setImmediate(() => close(null)); return true; };
    child.stdin.on('finish', () => { void (async () => {
      try {
        await inspect({ binary, args, options, prompt });
        if (hang || closed) return;
        if (stderr) child.stderr.write(stderr);
        if (!noFile) await writeFile(args[args.indexOf('--output-last-message') + 1], typeof result === 'string' ? result : JSON.stringify(result));
        child.stdout.write('{"type":"turn.completed"}\n'); close(exitCode);
      } catch (error) { child.emit('error', error); close(1); }
    })(); });
    return child;
  };
}

test('discovers the app-managed native binary and rejects missing or scripted overrides', async (t) => {
  const f = await fixture(t);
  assert.equal(await discoverAnalysisBinary(f.config), f.binary);
  assert.equal(await discoverAnalysisBinary({ ...f.config, codexBinary: path.join(f.root, 'missing.exe') }), null);
  if (process.platform === 'win32') await assert.rejects(discoverAnalysisBinary({ codexBinary: 'codex.cmd' }), { code: 'ANALYSIS_BINARY_INVALID' });
});

test('attaches at most 12 local frames with exact timing metadata, private auth and isolated CLI switches', async (t) => {
  const f = await fixture(t), progress = [];
  let received, schema;
  f.config.spawnProcess = mockSpawn(valid(120000), async call => { received = call; schema = JSON.parse(await readFile(call.args[call.args.indexOf('--output-schema') + 1], 'utf8')); });
  const result = await analyzeReference({ ...f, meta: { ...f.meta, duration: 120 }, transcript: { text: '仅这些台词是输入。', utterances: [{ text: '台词', startMs: null, endMs: null }] }, onProgress: message => progress.push(message) });
  assert.equal(f.calls.length, 12); assert.equal(result.frames.length, 12); assert.equal(result.provider, 'codex');
  assert.equal(result.frames[0].timeMs, 0); assert.equal(result.frames.at(-1).timeMs, 119900);
  assert.equal(result.shots.at(-1).endMs, 120000);
  for (const [index, frame] of result.frames.entries()) {
    assert.equal(path.isAbsolute(frame.file), false); assert.ok(!frame.file.includes('\\'));
    assert.equal(f.calls[index].args.at(-1), path.resolve(f.outputDir, frame.file));
    assert.equal(f.calls[index].args[f.calls[index].args.indexOf('-ss') + 1], String(frame.timeMs / 1000));
    assert.ok(f.calls[index].args.includes("scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease"));
  }
  const { args, options, prompt } = received;
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(options.env.CODEX_HOME, f.profile);
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_AUTH_JSON']) assert.equal(options.env[key], undefined);
  assert.notEqual(options.cwd, path.dirname(f.videoPath)); assert.ok(path.basename(options.cwd).startsWith('bowerbird-video-analysis-'));
  await assert.rejects(stat(options.cwd), { code: 'ENOENT' });
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--json', '--output-schema', '--output-last-message']) assert.ok(args.includes(flag), flag);
  for (const override of ['approval_policy="never"', 'web_search="disabled"', 'project_doc_max_bytes=0', 'skills.include_instructions=false', 'skills.bundled.enabled=false', 'features.plugins=false', 'features.shell_tool=false', 'features.unified_exec=false', 'features.view_image=false', 'agents.enabled=false']) assert.ok(args.includes(override), override);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only'); assert.equal(args.at(-1), '-');
  assert.equal(args.filter(value => value === '--image').length, 12); assert.ok(!args.includes(f.videoPath));
  assert.ok(prompt.includes('仅这些台词是输入。')); assert.ok(prompt.includes('"startMs":null')); assert.ok(prompt.includes('不得执行')); assert.ok(!prompt.includes('synthetic-credential'));
  assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.shots.items.additionalProperties, false);
  assert.ok(progress.at(-1).includes('画面分析已完成'));
});

test('refuses missing private auth and extra global instructions before extraction or model execution', async (t) => {
  const f = await fixture(t); f.config.spawnProcess = () => assert.fail('model must not start');
  await writeFile(path.join(f.profile, 'AGENTS.md'), 'Extra instructions');
  await assert.rejects(analyzeReference(f), { code: 'ANALYSIS_INSTRUCTIONS_UNSAFE' }); assert.equal(f.calls.length, 0);
  await rm(path.join(f.profile, 'AGENTS.md')); await rm(path.join(f.profile, 'auth.json'));
  await assert.rejects(analyzeReference(f), { code: 'ANALYSIS_LOGIN_REQUIRED' }); assert.equal(f.calls.length, 0);
});

test('validates durations and observed descriptions without filling gaps or fabricating shots', () => {
  assert.deepEqual(validateAnalysis(valid(30000), 30000), valid(30000));
  const invalid = [
    { ...valid(), summary: '' }, { ...valid(), shots: [] }, { ...valid(), extra: 'not allowed' },
    { ...valid(), shots: [{ ...valid().shots[0], startMs: 100 }] },
    { ...valid(), shots: [{ ...valid().shots[0], endMs: 7000 }] },
    { ...valid(), shots: [{ ...valid().shots[0], endMs: 16000 }] },
    { ...valid(), shots: [{ ...valid().shots[0], endMs: 3000 }] },
    { ...valid(), shots: [{ ...valid().shots[0], visual: '' }] },
    { ...valid(), shots: [{ ...valid().shots[0], startMs: null }] },
    { ...valid(), shots: [{ ...valid().shots[0], endMs: 8000.5 }] },
  ];
  for (const value of invalid) assert.throws(() => validateAnalysis(value, 8000), { code: 'ANALYSIS_INVALID_RESULT' });
  const duplicate = valid(30000); duplicate.shots[1].id = duplicate.shots[0].id;
  assert.throws(() => validateAnalysis(duplicate, 30000), { code: 'ANALYSIS_INVALID_RESULT' });
  const overlap = valid(30000); overlap.shots[1].startMs--;
  assert.throws(() => validateAnalysis(overlap, 30000), { code: 'ANALYSIS_INVALID_RESULT' });
});

test('rejects malformed JSON and invalid model boundaries instead of manufacturing a fallback', async (t) => {
  const f = await fixture(t);
  for (const output of ['not JSON', '```json\n{}\n```', { ...valid(), shots: [{ ...valid().shots[0], endMs: 3000 }] }]) {
    f.config.spawnProcess = mockSpawn(output);
    await assert.rejects(analyzeReference(f), { code: 'ANALYSIS_INVALID_RESULT' });
  }
  f.config.spawnProcess = mockSpawn(valid(), () => {}, { noFile: true });
  await assert.rejects(analyzeReference(f), { code: 'ANALYSIS_INVALID_RESULT' });
});

test('timeouts, cancellation and login failure report fixed Chinese errors without raw CLI output', async (t) => {
  const f = await fixture(t); f.config.analysisTimeoutMs = 15;
  f.config.spawnProcess = mockSpawn(valid(), () => {}, { hang: true });
  await assert.rejects(analyzeReference(f), { code: 'ANALYSIS_TIMEOUT' });
  const controller = new AbortController(); controller.abort(new Error('synthetic-secret'));
  await assert.rejects(analyzeReference({ ...f, signal: controller.signal }), { code: 'ANALYSIS_CANCELLED' });
  f.config.analysisTimeoutMs = 1000;
  f.config.spawnProcess = mockSpawn(valid(), () => {}, { exitCode: 1, stderr: '401 unauthorized synthetic-secret /private/auth.json' });
  await assert.rejects(analyzeReference(f), error => { assert.equal(error.code, 'ANALYSIS_LOGIN_REQUIRED'); assert.ok(!error.message.includes('synthetic-secret')); assert.ok(!error.message.includes('/private/')); return true; });
});

test('duration and failed frame extraction stop before submitting to Codex', async (t) => {
  const f = await fixture(t); f.config.spawnProcess = () => assert.fail('model must not start');
  for (const duration of [0, 3.5, 121, NaN]) await assert.rejects(analyzeReference({ ...f, meta: { duration } }), { code: 'ANALYSIS_DURATION' });
  f.config.runMediaProcess = async () => { throw new Error('private ffmpeg diagnostic'); };
  await assert.rejects(analyzeReference(f), { code: 'ANALYSIS_FRAME_FAILED' });
});

test('real offline FFmpeg extracts small JPEG frames; the analysis response remains mocked', async (t) => {
  const f = await fixture(t), ffmpeg = path.resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe');
  try { await stat(ffmpeg); } catch { t.skip('local FFmpeg fixture unavailable'); return; }
  await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=12:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f.videoPath]);
  f.config.ffmpegBinary = ffmpeg; delete f.config.runMediaProcess; f.config.spawnProcess = mockSpawn(valid(4000));
  const result = await analyzeReference({ ...f, meta: { duration: 4, width: 1280, height: 720 } });
  assert.equal(result.frames.length, 4);
  for (const frame of result.frames) { const bytes = await readFile(path.join(f.outputDir, frame.file)); assert.equal(bytes[0], 255); assert.equal(bytes[1], 216); assert.ok(bytes.length > 100); }
  const probe = await runProcess(path.join(path.dirname(ffmpeg), 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', path.join(f.outputDir, result.frames[0].file)]);
  assert.deepEqual(JSON.parse(probe.stdout).streams[0], { width: 768, height: 432 });
});

test('opt-in native Codex uses only localhost fixture images and ignores private config, MCP and skills', {
  skip: !process.env.BOWERBIRD_ANALYSIS_PROTOCOL_BINARY, timeout: 60000,
}, async (t) => {
  const f = await fixture(t), requests = [];
  const ffmpeg = path.resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe');
  await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=12:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f.videoPath]);
  const marker = path.join(f.root, 'mcp-started.txt'), skill = path.join(f.profile, 'skills', 'must-not-load');
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: must-not-load\ndescription: PRIVATE_ANALYSIS_SKILL_CATALOG\n---\nPRIVATE_ANALYSIS_SKILL_BODY');
  await writeFile(path.join(f.profile, 'auth.json'), '{}');
  await writeFile(path.join(f.profile, 'config.toml'), `model="PRIVATE_ANALYSIS_CONFIG_MODEL"\n[mcp_servers.must_not_load]\ncommand="node"\nargs=${JSON.stringify(['-e', 'require("node:fs").writeFileSync(process.argv[1],"started")', marker])}\n`);
  let serverFailure, cliDiagnostic = '';
  const server = createServer(async (req, res) => {
    try {
      const bytes = []; for await (const chunk of req) bytes.push(chunk);
      if (!req.url?.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
      const body = JSON.parse(Buffer.concat(bytes)); requests.push(body);
      const item = { id: 'message-offline', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(valid(4000)), annotations: [] }] };
      const response = { id: 'response-offline', object: 'response', status: 'completed', model: 'offline-fixture', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
      const part = item.content[0];
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: part.text },
        { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: part.text },
        { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    } catch (error) { serverFailure = error; res.writeHead(500); res.end('Synthetic fixture failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  f.config.ffmpegBinary = ffmpeg; delete f.config.runMediaProcess;
  f.config.analysisTimeoutMs = 25000;
  f.config.spawnProcess = (_binary, args, options) => {
    const nativeArgs = process.platform === 'win32' ? args.slice(2) : args.slice();
    nativeArgs.pop();
    for (const value of ['model="gpt-5.4"', 'model_provider="offline_fixture"', 'features.enable_request_compression=false',
      `model_providers.offline_fixture={name="Offline fixture",base_url=${JSON.stringify(baseUrl)},wire_api="responses",requires_openai_auth=false,supports_websockets=false}`]) nativeArgs.push('-c', value);
    nativeArgs.push('-');
    const child = spawn(process.env.BOWERBIRD_ANALYSIS_PROTOCOL_BINARY, nativeArgs, options);
    child.stderr.on('data', bytes => { cliDiagnostic = (cliDiagnostic + bytes).slice(-4000); });
    return child;
  };
  const result = await analyzeReference({ ...f, meta: { duration: 4, width: 320, height: 180 }, transcript: { text: 'SYNTHETIC_ANALYSIS_TRANSCRIPT', utterances: [] } })
    .catch(error => { t.diagnostic(cliDiagnostic); throw error; });
  if (serverFailure) throw serverFailure;
  assert.equal(result.provider, 'codex'); assert.equal(requests.length, 1);
  const body = requests[0], serialized = JSON.stringify(body);
  for (const value of ['PRIVATE_ANALYSIS_CONFIG_MODEL', 'PRIVATE_ANALYSIS_SKILL_CATALOG', 'PRIVATE_ANALYSIS_SKILL_BODY']) assert.ok(!serialized.includes(value), value);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  assert.equal(body.model, 'gpt-5.4'); assert.ok(serialized.includes('SYNTHETIC_ANALYSIS_TRANSCRIPT'));
  const images = body.input.flatMap(item => item.content || []).filter(item => item.type === 'input_image');
  assert.equal(images.length, 4); assert.ok(images.every(image => image.image_url.startsWith('data:image/')));
  assert.equal(body.text.format.type, 'json_schema'); assert.equal(body.text.format.schema.additionalProperties, false);
  const toolText = JSON.stringify([body.tools || [], body.input.filter(item => item.type === 'additional_tools')]);
  assert.ok(!/shell_command|exec_command|mcp__|browser|computer|spawn_agent/.test(toolText), 'operating tools must not be advertised');
  t.diagnostic(`Local fixture accepted images/schema; advertised tools: ${(body.tools || []).map(tool => tool.name || tool.type).join(', ')}`);
});
