import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildGenerationArguments, discoverJimengBinary, submitGeneration, resumeGeneration } from '../lib/generation.mjs';

async function fixture(t, steps) {
  const root = await mkdtemp(path.join(tmpdir(), 'replication-generation-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcherDir = path.join(root, 'cli-runtime', '26.10.2401');
  await mkdir(launcherDir, { recursive: true });
  const binary = path.join(root, 'dreamina.exe');
  const launcher = path.join(launcherDir, 'cli-launcher.exe');
  const imagePath = path.join(root, '产品 [一].png');
  for (const file of [binary, launcher, path.join(launcherDir, 'cli-registry.dll'), imagePath]) await writeFile(file, 'fixture');
  const calls = []; let killed = 0;
  const config = { jimengBinary: binary, bowerbirdAppData: root, queryIntervalMs: 1, commandTimeoutMs: 1_000,
    spawnProcess(executable, args, options) {
      calls.push({ executable, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let closed = false;
      const close = (code) => { if (!closed) { closed = true; child.emit('close', code); } };
      child.kill = () => { killed++; queueMicrotask(() => close(null)); return true; };
      const step = steps.shift();
      queueMicrotask(async () => {
        try {
          assert.ok(step, 'Unexpected subprocess: a paid submission may have been repeated');
          if (step.before) await step.before({ args, options, calls });
          if (step.error) { child.emit('error', new Error('spawn ENOENT')); close(-2); return; }
          if (step.stdout !== undefined) child.stdout.write(step.stdout);
          else if (step.value) child.stdout.write(`CLI notice\n${JSON.stringify(step.value, null, 2)}\n`);
          if (step.stderr) child.stderr.write(step.stderr);
          if (!step.hang) close(step.exitCode ?? 0);
        } catch (error) { child.emit('error', error); close(-1); }
      });
      return child;
    } };
  return { root, config, calls, imagePath, outputDir: path.join(root, 'output'), killed: () => killed };
}

const argsInput = { imagePaths: ['/demo/person.png', '/demo/product.jpg'],
  prompt: '人物替换为图片1；产品替换为图片2；台词：“新的台词”。', duration: 6, ratio: '9:16' };

test('image-only reference command preserves attachment order, literal prompt and fixed Seedance 2.5', () => {
  const prompt = '中文 "台词"\n$() & calc.exe';
  const args = buildGenerationArguments({ ...argsInput, prompt });
  assert.equal(args[0], 'multimodal2video');
  assert.deepEqual(args.slice(1, 5), ['--image', path.resolve(argsInput.imagePaths[0]), '--image', path.resolve(argsInput.imagePaths[1])]);
  assert.equal(args[args.indexOf('--prompt') + 1], prompt);
  assert.equal(args[args.indexOf('--model_version') + 1], 'seedance2.5');
  assert.deepEqual(args.slice(-2), ['--poll', '0']);
  assert.equal(args.includes('--watermark'), false);
  assert.equal(args.includes('--video'), false);
});

test('text-only generation requires no media and cannot add video or image attachment flags', () => {
  const args = buildGenerationArguments({ ...argsInput, imagePaths: [] });
  assert.equal(args[0], 'text2video');
  for (const flag of ['--video', '--image', '--audio', '--first', '--last']) assert.equal(args.includes(flag), false);
  assert.equal(args[args.indexOf('--prompt') + 1], argsInput.prompt);
});

test('legacy video input fields are explicitly forbidden even when empty or undefined', () => {
  for (const extra of [{ videoPath: '/demo/reference.mp4' }, { videoPath: undefined }, { referenceDuration: 6 },
    { config: { referenceDuration: 6 } }, { config: { referenceDuration: undefined } }, { config: { videoPath: '' } }]) {
    assert.throws(() => buildGenerationArguments({ ...argsInput, ...extra }), { code: 'VIDEO_REFERENCE_FORBIDDEN' });
  }
});

test('rejects unsupported duration, reference, resolution and ratio before submission', () => {
  for (const duration of [3, 31, 4.5, NaN]) assert.throws(() => buildGenerationArguments({ ...argsInput, duration }), { code: 'INVALID_DURATION' });
  for (const duration of [4, 30]) assert.ok(buildGenerationArguments({ ...argsInput, duration }));
  assert.throws(() => buildGenerationArguments({ ...argsInput, ratio: '2:1' }), { code: 'INVALID_RATIO' });
  assert.throws(() => buildGenerationArguments({ ...argsInput, config: { jimengResolution: '4k' } }), { code: 'INVALID_RESOLUTION' });
  assert.throws(() => buildGenerationArguments({ ...argsInput, config: { jimengResolution: '1080p' } }), { code: 'INVALID_RESOLUTION' });
  assert.throws(() => buildGenerationArguments({ ...argsInput, imagePaths: ['audio.mp3'] }), { code: 'INVALID_REFERENCE' });
  assert.throws(() => buildGenerationArguments({ ...argsInput, imagePaths: Array(31).fill('image.png') }), { code: 'INVALID_REFERENCE' });
});

test('submits exactly once, saves id before query, uses private launcher, downloads output', async (t) => {
  let persisted = false;
  const f = await fixture(t, [
    { value: { submit_id: 'task-abc', gen_status: 'querying' } },
    { value: { gen_status: 'querying' }, before: () => assert.equal(persisted, true) },
    { value: { gen_status: 'success' }, before: async ({ args }) => writeFile(path.join(args[args.indexOf('--download_dir') + 1], 'result.mp4'), 'video') },
  ]);
  const result = await submitGeneration({ ...argsInput, ...f, imagePaths: [f.imagePath], onSubmitted: async (id) => { assert.equal(id, 'task-abc'); persisted = true; } });
  assert.equal(result.submitId, 'task-abc');
  assert.deepEqual(result.videoPaths, [path.join(f.outputDir, 'result.mp4')]);
  assert.equal(f.calls.filter((call) => call.args.includes('multimodal2video')).length, 1);
  for (const call of f.calls) {
    assert.equal(call.args.includes('--video'), false);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    if (process.platform === 'win32') {
      assert.equal(path.basename(call.executable), 'cli-launcher.exe');
      assert.equal(call.args[0], f.config.jimengBinary);
      assert.equal(call.options.env.HOME, path.join(f.root, 'cli-profiles', 'dreamina'));
      assert.equal(call.options.env.BOWERBIRD_DREAMINA_REGISTRY, 'Software\\Bowerbird\\CliAuth\\Dreamina');
    }
  }
});

test('replacement image missing fails before invoking any CLI', async (t) => {
  const f = await fixture(t, []);
  await assert.rejects(submitGeneration({ ...argsInput, ...f, imagePaths: [path.join(f.root, 'missing.png')] }), { code: 'REFERENCE_MISSING' });
  assert.equal(f.calls.length, 0);
});

test('submission and recovery reject legacy video fields without invoking the CLI', async (t) => {
  const f = await fixture(t, []);
  for (const extra of [{ videoPath: path.join(f.root, 'reference.mp4') }, { referenceDuration: 6 },
    { config: { ...f.config, referenceDuration: 6 } }]) {
    await assert.rejects(submitGeneration({ ...argsInput, ...f, imagePaths: [], ...extra }), { code: 'VIDEO_REFERENCE_FORBIDDEN' });
    await assert.rejects(resumeGeneration({ ...f, submitId: 'existing-task', ...extra }), { code: 'VIDEO_REFERENCE_FORBIDDEN' });
  }
  assert.equal(f.calls.length, 0);
});

test('video files cannot be smuggled through the replacement image list', async (t) => {
  const f = await fixture(t, []);
  for (const extension of ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi']) {
    await assert.rejects(submitGeneration({ ...argsInput, ...f, imagePaths: [path.join(f.root, `original.${extension}`)] }), { code: 'INVALID_REFERENCE' });
  }
  assert.equal(f.calls.length, 0);
});

test('submission timeout is OUTCOME_UNKNOWN and never resubmits', async (t) => {
  const f = await fixture(t, [{ hang: true }]);
  f.config.commandTimeoutMs = 10;
  await assert.rejects(submitGeneration({ ...argsInput, ...f, imagePaths: [] }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.calls.length, 1); assert.equal(f.killed(), 1);
  assert.ok(f.calls[0].args.includes('text2video')); assert.equal(f.calls[0].args.includes('--video'), false);
});

test('unknown submission output never starts polling or retries generation', async (t) => {
  const f = await fixture(t, [{ stdout: 'service response lost' }]);
  await assert.rejects(submitGeneration({ ...argsInput, ...f, imagePaths: [] }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.calls.length, 1);
});

test('failed local task-id persistence keeps the accepted id and does not poll', async (t) => {
  const f = await fixture(t, [{ value: { submit_id: 'accepted-1', gen_status: 'querying' } }]);
  await assert.rejects(submitGeneration({ ...argsInput, ...f, imagePaths: [], onSubmitted: () => { throw new Error('disk full'); } }), { code: 'TASK_SAVE_FAILED', submitId: 'accepted-1' });
  assert.equal(f.calls.length, 1);
});

test('resume transient query retries only original task then downloads', async (t) => {
  const f = await fixture(t, [
    { exitCode: 1, stderr: 'context deadline exceeded' },
    { value: { gen_status: 'success' }, before: async ({ args }) => writeFile(path.join(args[args.indexOf('--download_dir') + 1], 'result.mp4'), 'video') },
  ]);
  const result = await resumeGeneration({ ...f, submitId: 'original-1' });
  assert.equal(result.submitId, 'original-1');
  for (const call of f.calls) { assert.ok(call.args.includes('query_result')); assert.equal(call.args[call.args.indexOf('--submit_id') + 1], 'original-1'); }
});

test('remote fail with timeout text is not retried; private diagnostics stay out of message', async (t) => {
  const f = await fixture(t, [{ value: { gen_status: 'fail', fail_reason: 'context deadline exceeded https://secret.example/?token=private' } }]);
  await assert.rejects(resumeGeneration({ ...f, submitId: 'original-2' }), (error) => {
    assert.equal(error.code, 'GENERATION_FAILED'); assert.equal(error.submitId, 'original-2'); assert.doesNotMatch(error.message, /private|secret\.example/); return true;
  });
  assert.equal(f.calls.length, 1);
});

test('success without downloaded file retains task id for recovery', async (t) => {
  const f = await fixture(t, [{ value: { gen_status: 'success' } }]);
  await assert.rejects(resumeGeneration({ ...f, submitId: 'original-3' }), { code: 'DOWNLOAD_MISSING', submitId: 'original-3' });
});

test('abort during polling kills local child and retains original task', async (t) => {
  const f = await fixture(t, [{ hang: true }]);
  const controller = new AbortController();
  const pending = resumeGeneration({ ...f, submitId: 'original-4', signal: controller.signal });
  while (!f.calls.length) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED', submitId: 'original-4' });
  assert.equal(f.killed(), 1);
});

test('binary discovery checks explicit file without launching or reading credentials', async (t) => {
  const f = await fixture(t, []);
  assert.equal(await discoverJimengBinary(f.config), f.config.jimengBinary);
  assert.equal(await discoverJimengBinary({ jimengBinary: path.join(f.root, 'absent.exe') }), null);
  assert.equal(f.calls.length, 0);
});
