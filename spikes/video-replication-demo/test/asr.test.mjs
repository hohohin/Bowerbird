import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { transcribeAudio } from '../lib/asr.mjs';

const config = { speechApiKey: 'test-speech-key' };
const sample = {
  audio_info: { duration: 2499 },
  result: {
    text: '关闭透传。',
    utterances: [{
      text: '关闭透传。', start_time: 450, end_time: 1530,
      words: [
        { text: '关', start_time: 450, end_time: 770 },
        { text: '闭', start_time: 770, end_time: 970 },
        { text: '透', start_time: 1130, end_time: 1210 },
        { text: '传', start_time: 1490, end_time: 1530 },
      ],
    }],
  },
};

async function audioFixture(t, bytes = Buffer.from('synthetic mock audio')) {
  const directory = await mkdtemp(join(tmpdir(), 'replication-asr-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audioPath = join(directory, 'audio.wav');
  await writeFile(audioPath, bytes);
  return audioPath;
}

function response(body = sample, { status = 200, code = '20000000', logId = 'test-log-id' } = {}) {
  const headers = { 'x-tt-logid': logId };
  if (code !== null) headers['x-api-status-code'] = code;
  return new Response(JSON.stringify(body), { status, headers });
}

test('sends local Base64 with new API Key and returns exact provider millisecond timestamps', async (t) => {
  const bytes = Buffer.from('synthetic mock audio');
  const audioPath = await audioFixture(t, bytes);
  const progress = [];
  let calls = 0;
  let requestId;
  const output = await transcribeAudio({
    audioPath, config: { ...config, speechAppId: 'old-app-id', speechAccessToken: 'old-token' },
    onProgress: (message) => progress.push(message),
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['X-Api-Key'], config.speechApiKey);
      assert.equal(options.headers['X-Api-App-Key'], undefined);
      assert.equal(options.headers['X-Api-Access-Key'], undefined);
      assert.equal(options.headers['X-Api-Resource-Id'], 'volc.bigasr.auc_turbo');
      assert.equal(options.headers['X-Api-Sequence'], '-1');
      requestId = options.headers['X-Api-Request-Id'];
      assert.match(requestId, /^[0-9a-f-]{36}$/);
      const body = JSON.parse(options.body);
      assert.equal(body.audio.data, bytes.toString('base64'));
      assert.equal(body.audio.url, undefined);
      assert.equal(body.audio.format, 'wav');
      assert.equal(body.request.show_utterances, true);
      assert.equal(body.request.enable_ddc, false);
      assert.ok(!options.body.includes(config.speechApiKey));
      return response();
    },
  });
  assert.equal(calls, 1);
  assert.equal(output.text, '关闭透传。');
  assert.equal(output.durationMs, 2499);
  assert.equal(output.requestId, requestId);
  assert.equal(output.logId, 'test-log-id');
  assert.deepEqual(output.words, sample.result.utterances[0].words.map((word) => ({
    text: word.text, startMs: word.start_time, endMs: word.end_time,
  })));
  assert.deepEqual(output.utterances[0], { text: '关闭透传。', startMs: 450, endMs: 1530, words: output.words });
  assert.deepEqual(output.raw, sample);
  assert.equal(progress.length, 2);
});

test('supports legacy App ID plus Access Token when new key is absent', async (t) => {
  const audioPath = await audioFixture(t);
  await transcribeAudio({ audioPath, config: { speechAppId: '123', speechAccessToken: 'legacy-token' },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers['X-Api-Key'], undefined);
      assert.equal(options.headers['X-Api-App-Key'], '123');
      assert.equal(options.headers['X-Api-Access-Key'], 'legacy-token');
      return response();
    },
  });
});

test('does not fabricate missing, invalid, or reversed timestamps or duration', async (t) => {
  const audioPath = await audioFixture(t);
  const output = await transcribeAudio({ audioPath, config, fetchImpl: async () => response({ result: {
    text: '测试。', utterances: [{ text: '测试。', start_time: null, words: [
      { text: '测', start_time: 0 },
      { text: '试', start_time: '', end_time: -1 },
      { text: '。', start_time: 100, end_time: 90 },
      { text: ' ', start_time: false, end_time: true },
    ] }],
  } }) });
  assert.equal(output.durationMs, null);
  assert.equal(output.utterances[0].startMs, null);
  assert.equal(output.utterances[0].endMs, null);
  assert.deepEqual(output.words, [
    { text: '测', startMs: 0, endMs: null },
    { text: '试', startMs: null, endMs: null },
    { text: '。', startMs: null, endMs: null },
    { text: ' ', startMs: null, endMs: null },
  ]);
});

test('preserves a text-only success and provider duration string without inventing words', async (t) => {
  const audioPath = await audioFixture(t);
  const output = await transcribeAudio({ audioPath, config, fetchImpl: async () => response({
    result: { text: '只有文字', additions: { duration: '4500' } },
  }) });
  assert.equal(output.text, '只有文字');
  assert.deepEqual(output.utterances, []);
  assert.deepEqual(output.words, []);
  assert.equal(output.durationMs, 4500);
});

test('rejects missing credentials, wrong resource, unsupported or empty audio before any request', async (t) => {
  const audioPath = await audioFixture(t, Buffer.alloc(0));
  const fetchImpl = async () => assert.fail('must not submit invalid input');
  await assert.rejects(transcribeAudio({ audioPath, config: {}, fetchImpl }), { code: 'ASR_CONFIG_MISSING' });
  await assert.rejects(transcribeAudio({ audioPath, config: { speechAppId: '123' }, fetchImpl }), { code: 'ASR_CONFIG_MISSING' });
  await assert.rejects(transcribeAudio({ audioPath, config: { ...config, speechResourceId: 'volc.seedasr.auc' }, fetchImpl }), { code: 'ASR_RESOURCE_INVALID' });
  await assert.rejects(transcribeAudio({ audioPath: 'video.mp4', config, fetchImpl }), { code: 'ASR_AUDIO_FORMAT' });
  await assert.rejects(transcribeAudio({ audioPath, config, fetchImpl }), { code: 'ASR_AUDIO_EMPTY' });
});

test('does not expose upstream bodies, arbitrary headers, or keys in authentication errors', async (t) => {
  const audioPath = await audioFixture(t);
  await assert.rejects(transcribeAudio({ audioPath, config, fetchImpl: async () => response({
    error: `Unauthorized ${config.speechApiKey} at internal.server`,
  }, { status: 403, code: '45000000', logId: config.speechApiKey }) }), (error) => {
    assert.equal(error.code, 'ASR_AUTH');
    assert.match(error.message, /检查 API Key/);
    assert.equal(error.logId, null);
    assert.equal(error.statusCode, '45000000');
    assert.ok(!JSON.stringify(error).includes(config.speechApiKey));
    assert.ok(!error.message.includes('internal.server'));
    return true;
  });
});

test('requires explicit successful provider status and never retries rejected or unfinished responses', async (t) => {
  const audioPath = await audioFixture(t);
  for (const [code, expected] of [[null, 'ASR_REJECTED'], ['45000000', 'ASR_REJECTED'], ['20000001', 'ASR_RESULT_UNKNOWN'], ['20000002', 'ASR_RESULT_UNKNOWN']]) {
    let calls = 0;
    await assert.rejects(transcribeAudio({ audioPath, config, fetchImpl: async () => {
      calls += 1;
      return response(sample, { code });
    } }), { code: expected });
    assert.equal(calls, 1);
  }
});

test('network failure and cancellation preserve uncertainty without leaking raw exception', async (t) => {
  const audioPath = await audioFixture(t);
  let calls = 0;
  await assert.rejects(transcribeAudio({ audioPath, config, fetchImpl: async () => {
    calls += 1;
    throw new Error(`network issue: ${config.speechApiKey}`);
  } }), (error) => {
    assert.equal(error.code, 'ASR_NETWORK');
    assert.match(error.message, /状态未确认/);
    assert.ok(!error.message.includes(config.speechApiKey));
    return true;
  });
  assert.equal(calls, 1);
  const controller = new AbortController();
  await assert.rejects(transcribeAudio({ audioPath, config, signal: controller.signal, fetchImpl: async (_url, options) => {
    controller.abort(new Error(config.speechApiKey));
    assert.equal(options.signal.aborted, true);
    throw options.signal.reason;
  } }), { code: 'ASR_CANCELLED' });
});

test('rejects malformed successful JSON and missing result shape', async (t) => {
  const audioPath = await audioFixture(t);
  await assert.rejects(transcribeAudio({ audioPath, config, fetchImpl: async () => new Response('not-json', {
    headers: { 'x-api-status-code': '20000000' },
  }) }), { code: 'ASR_INVALID_RESPONSE' });
  await assert.rejects(transcribeAudio({ audioPath, config, fetchImpl: async () => response({ unexpected: true }) }), { code: 'ASR_INVALID_RESPONSE' });
});
