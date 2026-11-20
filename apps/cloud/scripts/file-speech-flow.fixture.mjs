import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { configFromEnv, runUnderstandWorker } from '../../agent-worker/src/cloud-understand/runtime.ts';
import { fileSpeechAudioKey } from '../supabase/functions/_shared/file-speech.ts';

const origin = 'https://isolated-bowerbird.test';
const controlUrl = `${origin}/functions/v1/understand-worker`;
const providerUrl = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel';
const userToken = 'isolated-user';
const workerToken = 'isolated-worker';
const hash = value => createHash('sha256').update(value).digest('hex');
const keyFor = job => `file-speech:${job}`;

function makeAudio(seconds) {
  return execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=530:sample_rate=16000',
    '-t', String(seconds), '-ac', '1', '-b:a', '32k', '-f', 'mp3', 'pipe:1'], { windowsHide: true, maxBuffer: 2 ** 21 });
}

function postgresAdapter(q, user, bucket) {
  const rpc = {
    begin_file_speech_upload: ['p_user_id', 'p_key', 'p_hash', 'p_expected_credits', 'p_unit_cost_micros', 'p_daily_limit', 'p_per_minute', 'p_source_duration_ms'],
    transition_text_upload: ['p_table', 'p_id', 'p_hash', 'p_enqueue'],
    reconcile_stale_understand_jobs: ['p_limit'],
    expire_unsubmitted_text_jobs: ['p_table'],
    cleanup_classification: [],
    claim_understand_job: ['p_worker_id', 'p_lease_seconds', 'p_file_speech_capable'],
    heartbeat_understand_job: ['p_job_id', 'p_lease_id', 'p_lease_seconds'],
    mark_understand_job_submitted: ['p_job_id', 'p_lease_id'],
    defer_file_speech_job: ['p_job_id', 'p_lease_id'],
    complete_understand_job: ['p_job_id', 'p_lease_id', 'p_status', 'p_result_text', 'p_error_code', 'p_safe_message', 'p_file_speech_capable'],
  };
  return {
    auth: { async getUser(token) { assert.equal(token, userToken); return { data: { user: { id: user } }, error: null }; } },
    storage: { from(name) { assert.equal(name, 'generation-temp'); return bucket; } },
    async rpc(name, args = {}) {
      assert.ok(Object.hasOwn(rpc, name), `Unexpected RPC ${name}`);
      const keys = rpc[name].filter(key => Object.hasOwn(args, key));
      assert.deepEqual([...keys].sort(), Object.keys(args).sort());
      const rowResult = /^(claim|heartbeat|mark|complete)_understand_job/.test(name);
      const params = keys.map((key, index) => `${key} => $${index + 1}`).join(', ');
      try {
        const [result] = await q(`select ${rowResult ? '* from' : ''} public.${name}(${params}) ${rowResult ? '' : 'as value'}`, keys.map(key => args[key]));
        return { data: rowResult ? result : result?.value, error: null };
      } catch (error) {
        return { data: null, error: { code: error.code, details: error.detail } };
      }
    },
    from(table) {
      let date, ids, change;
      const fields = {};
      const api = {
        select() { return api; },
        eq(name, value) { fields[name] = value; return api; },
        lt(name, value) { assert.equal(name, 'content_expires_at'); date = value; return api; },
        or(query) { assert.equal(query, 'finished_at.not.is.null,upstream_submitted_at.not.is.null'); return api; },
        is(name, value) { assert.equal(name, 'deleted_at'); assert.equal(value, null); return api; },
        order() { return api; },
        update(value) { change = value; return api; },
        in(name, value) { assert.equal(name, 'id'); ids = value; return api; },
        async maybeSingle() {
          if (table === 'service_costs') {
            return { data: (await q('select * from service_costs where service=$1', [fields.service]))[0] ?? null, error: null };
          }
          assert.equal(table, 'understand_jobs');
          const keyMatch = 'idempotency_key' in fields;
          const data = (await q(keyMatch
            ? 'select * from understand_jobs where idempotency_key=$1 and user_id=$2'
            : 'select * from understand_jobs where id=$1 and ($2::uuid is null or user_id=$2)',
          [keyMatch ? fields.idempotency_key : fields.id, fields.user_id ?? null]))[0];
          return { data: data ? { ...data, content_expires_at: data.content_expires_at.toISOString() } : null, error: null };
        },
        async limit(count) {
          assert.equal(table, 'understand_jobs');
          return { data: await q(`select id,request_object_key,operation from understand_jobs where content_expires_at<$1
            and (finished_at is not null or upstream_submitted_at is not null) and deleted_at is null
            order by content_expires_at,id limit $2`, [date, count]), error: null };
        },
        then(resolve, reject) {
          assert.equal(table, 'understand_jobs');
          assert.equal(change?.result_text, null);
          return q(`update understand_jobs set deleted_at=$1,result_text=null where id=any($2::uuid[])
            and (finished_at is not null or upstream_submitted_at is not null) and deleted_at is null`, [change.deleted_at, ids])
            .then(() => ({ error: null })).then(resolve, reject);
        },
      };
      return api;
    },
  };
}

export async function verifyFileSpeechFlow(q, root) {
  const user = randomUUID();
  await q('insert into auth.users(id) values($1)', [user]);
  const signed = new Map();
  const store = new Map();
  const storageRoot = path.join(root, 'isolated-file-speech-storage');
  fs.mkdirSync(storageRoot);
  let preserveOnDelete;
  const storagePath = key => {
    assert.match(key, /^understand\/[0-9a-f-]{36}\/inputs\/(?:request\.json|speech-audio\.mp3)$/);
    return path.join(storageRoot, key.replaceAll('/', '_'));
  };
  const put = (key, bytes, mime) => {
    fs.writeFileSync(storagePath(key), bytes, { flag: 'wx' });
    store.set(key, mime);
  };
  const sign = (mode, key) => {
    storagePath(key);
    const url = `${origin}/storage/v1/object/${mode}/generation-temp/${key}?token=${randomUUID()}`;
    signed.set(url, key);
    return { data: { signedUrl: url }, error: null };
  };
  const bucket = {
    async upload(key, payload, options) {
      assert.equal(options.upsert, false);
      if (store.has(key)) return { error: true };
      put(key, payload, options.contentType);
      return { error: null };
    },
    async createSignedUploadUrl(key, options) {
      assert.equal(options.upsert, false);
      return sign('upload/sign', key);
    },
    async createSignedUrl(key) { assert.ok(store.has(key)); return sign('sign', key); },
    async download(key) { return { data: new Blob([fs.readFileSync(storagePath(key))]), error: null }; },
    async list(folder, { search }) {
      const key = `${folder}/${search}`;
      return { data: store.has(key) ? [{ name: search, metadata: { size: fs.statSync(storagePath(key)).size, mimetype: store.get(key) } }] : [], error: null };
    },
    async remove(keys) {
      const removed = [];
      for (const key of keys) {
        if (!store.has(key) || key === preserveOnDelete) continue;
        fs.unlinkSync(storagePath(key));
        store.delete(key);
        removed.push({ name: key });
      }
      return { data: removed, error: null };
    },
  };

  const testClient = Symbol.for('bowerbird.file-speech-fixture.client');
  const savedDeno = globalThis.Deno;
  const savedFetch = globalThis.fetch;
  const handlers = [];
  const env = {
    SUPABASE_URL: origin, SUPABASE_PUBLISHABLE_KEY: userToken, SUPABASE_SECRET_KEY: workerToken,
    UNDERSTAND_WORKER_TOKEN: workerToken, FILE_SPEECH_ENABLED: 'true', BOWERBIRD_CLOUD_MOCK: 'false',
  };
  globalThis[testClient] = postgresAdapter(q, user, bucket);
  globalThis.Deno = { env: { get: name => env[name] }, serve: handler => handlers.push(handler) };
  globalThis.fetch = async () => { throw new Error('Unexpected external fetch in isolated file speech fixture'); };
  const source = `export const createClient = () => globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(testClient))})];`;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier === 'jsr:@supabase/supabase-js@2'
      ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
      : next(specifier, context);
  } });
  try {
    await import('../supabase/functions/understand-proxy/index.ts');
    await import('../supabase/functions/understand-worker/index.ts');
    assert.equal(handlers.length, 2);
    const [proxy, control] = handlers;
    await testScenarios({ q, proxy, control, signed, store, storagePath, put,
      preserve: key => { preserveOnDelete = key; } });
  } finally {
    hooks.deregister();
    globalThis.Deno = savedDeno;
    globalThis.fetch = savedFetch;
    delete globalThis[testClient];
  }
}

async function testScenarios({ q, proxy, control, signed, store, storagePath, put, preserve }) {
  const post = (handler, endpoint, token, body) => handler(new Request(endpoint, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-worker-id': 'fixture-cleanup' },
    body: JSON.stringify(body),
  }));
  const userPost = async (body, expected = 200) => {
    const response = await post(proxy, `${origin}/functions/v1/understand-proxy`, userToken, body);
    const payload = await response.json();
    assert.equal(response.status, expected, JSON.stringify(payload));
    return payload;
  };
  const find = (idempotencyKey, expected = 200) => userPost({ action: 'get-by-key', idempotency_key: idempotencyKey }, expected);
  const state = async id => (await q('select * from understand_jobs where id=$1', [id]))[0];
  const entries = async id => (await q(`select kind from credit_transactions where hold_id =
    (select hold_id from understand_jobs where id=$1) and kind in ('confirm','rollback') order by kind`, [id])).map(row => row.kind);
  const ready = await userPost({ action: 'file-speech-capabilities' });
  assert.equal(ready.available, true);
  let workerSequence = 0;
  const request = async (seconds, { crash = false, terminalFailure = false, unknown = false } = {}) => {
    const bytes = makeAudio(seconds);
    const key = keyFor(randomUUID());
    const duration = Math.round(seconds * 1000);
    const manifest = { bytes: bytes.length, sha256: hash(bytes), duration_ms: duration, source_duration_ms: duration };
    const prepare = { action: 'file-speech-prepare', idempotency_key: key, expected_credits: ready.credits, audio: manifest };
    const first = await userPost(prepare, 202);
    const jobId = first.job_id;
    const audioKey = fileSpeechAudioKey(jobId);
    const requestKey = (await state(jobId)).request_object_key;
    const commit = { action: 'file-speech-commit', job_id: jobId };
    assert.equal(first.status, 'uploading');
    assert.equal((await userPost(commit, 202)).status, 'uploading');
    assert.equal((await userPost(prepare, 202)).job_id, jobId);
    assert.equal(signed.get(first.upload_url), audioKey);
    put(audioKey, bytes, 'audio/mpeg');
    assert.equal((await userPost(commit, 202)).status, 'queued');
    assert.equal((await find(key, 202)).job_id, jobId);
    const providerCalls = [];
    const storageReads = [];
    const claims = [];
    let queryCount = 0;
    const marker = `完整文稿 ${seconds} 秒结尾`;
    const transcriptText = `音轨开头 ${marker}`;
    const utterances = [
      { text: '音轨开头', start_time: 50, end_time: 150 },
      { text: marker, start_time: duration - 50, end_time: duration },
    ];
    const runWorker = async (crashDuringDefer = false) => {
      const stop = { requested: false };
      const workerId = `isolated-${++workerSequence}`;
      const config = configFromEnv({
        UNDERSTAND_CONTROL_URL: controlUrl, UNDERSTAND_WORKER_TOKEN: workerToken, UNDERSTAND_WORKER_ID: workerId,
        ARK_API_KEY: 'isolated-non-secret', ARK_VISION_MODEL: 'unused', DOUBAO_FILE_SPEECH_API_KEY: 'isolated-non-secret',
        UNDERSTAND_POLL_INTERVAL_MS: '1', UNDERSTAND_HEARTBEAT_INTERVAL_MS: '10',
      });
      const lostReply = new Error('synthetic provider accepted the UUID but its response was lost');
      const interruptedWorker = new Error('worker interrupted before releasing submitted lease');
      const unexpectedFailures = [];
      const dispatch = async (url, options) => {
        if (url === controlUrl) {
          const { action } = JSON.parse(options.body);
          if (action === 'claim') stop.requested = true;
          if (action === 'defer_file_speech' && crashDuringDefer) throw interruptedWorker;
          const response = await control(new Request(url, options));
          if (action !== 'heartbeat' || response.status !== 409) assert.equal(response.status, 200, await response.clone().text());
          if (action === 'claim') {
            const claimed = await response.clone().json();
            assert.equal(claimed.job.id, jobId);
            assert.equal(Boolean(claimed.inputUrl), !claimed.fileSpeech.submittedAt);
            claims.push({ lease: claimed.lease.leaseId, workerId });
          }
          return response;
        }
        if (signed.has(url)) {
          assert.equal(options.method, 'GET');
          const key = signed.get(url);
          storageReads.push(key);
          return new Response(fs.readFileSync(storagePath(key)));
        }
        assert.ok(url === `${providerUrl}/submit` || url === `${providerUrl}/query`, `Unhandled URL ${new URL(url).origin}`);
        const action = url === `${providerUrl}/submit` ? 'submit' : 'query';
        const providerId = options.headers['X-Api-Request-Id'];
        assert.equal(providerId, jobId);
        providerCalls.push({ action, id: providerId });
        const body = JSON.parse(options.body);
        if (action === 'submit') {
          assert.equal(signed.get(body.audio.url), audioKey);
          assert.equal(body.audio.format, 'mp3');
          assert.equal(body.request.vad_segment, true);
          assert.equal(body.request.show_utterances, true);
          assert.ok((await state(jobId)).upstream_submitted_at);
          throw lostReply;
        }
        assert.deepEqual(body, {});
        if (terminalFailure) return new Response(null, { headers: { 'X-Api-Status-Code': '55001010' } });
        if (unknown || ++queryCount === 1) return new Response(null, { headers: { 'X-Api-Status-Code': '20000001' } });
        const transcript = { result: { text: transcriptText, utterances } };
        return new Response(JSON.stringify(transcript), { headers: { 'X-Api-Status-Code': '20000000' } });
      };
      const fetch = async (...args) => {
        try { return await dispatch(...args); } catch (error) {
          if (error !== lostReply && error !== interruptedWorker) unexpectedFailures.push(error);
          throw error;
        }
      };
      await runUnderstandWorker(config, fetch, stop);
      if (unexpectedFailures.length) throw new AggregateError(unexpectedFailures, 'Unexpected isolated Worker response');
    };
    await runWorker(crash);
    const submitted = await state(jobId);
    assert.equal(submitted.status, crash ? 'running' : 'queued');
    assert.ok(submitted.upstream_submitted_at, `Missing upstream fence for ${seconds}s fixture`);
    assert.deepEqual(await entries(jobId), []);
    if (crash) {
      await q("update understand_jobs set lease_expires_at=now()-interval '1 second' where id=$1", [jobId]);
    } else {
      await q("update understand_jobs set queued_at=now()-interval '1 second' where id=$1", [jobId]);
    }
    await runWorker();
    if (!terminalFailure && !unknown) {
      assert.equal((await state(jobId)).status, 'queued');
      await q("update understand_jobs set queued_at=now()-interval '1 second' where id=$1", [jobId]);
      await runWorker();
    }
    assert.equal(new Set(claims.map(claim => claim.lease)).size, claims.length);
    assert.equal(new Set(claims.map(claim => claim.workerId)).size, claims.length);
    assert.deepEqual(storageReads, [requestKey, audioKey]);
    const expectedCalls = terminalFailure || unknown ? ['submit', 'query'] : ['submit', 'query', 'query'];
    assert.deepEqual(providerCalls, expectedCalls.map(action => ({ action, id: jobId })));

    if (unknown) {
      assert.equal((await find(key, 202)).status, 'queued');
      assert.deepEqual(await entries(jobId), []);
    } else if (terminalFailure) {
      assert.equal((await find(key)).status, 'failed');
      assert.deepEqual(await entries(jobId), ['rollback']);
      assert.equal((await state(jobId)).result_text, null);
    } else {
      const delivered = await find(key);
      assert.equal(delivered.charge.actual, ready.credits);
      assert.equal(delivered.charge.transaction_id, first.charge.transaction_id);
      const result = JSON.parse(delivered.text);
      assert.equal(result.text, transcriptText);
      assert.deepEqual(result.utterances, utterances.map(({ text, start_time: startMs, end_time: endMs }) => ({ text, startMs, endMs })));
      assert.equal(result.timingSource, 'doubao-speech');
      assert.deepEqual(await userPost(prepare), delivered);
      assert.deepEqual(await entries(jobId), ['confirm']);
    }
    return { key, jobId, audioKey, requestKey };
  };

  const short = await request(3);
  const long = await request(130.4, { crash: true });
  const failed = await request(3, { terminalFailure: true });
  const expired = await request(3, { unknown: true });
  console.log('PASS actual Edge/Worker with 3s and 130.4s mono MP3s, VAD request and timed utterances, provider reply loss, original UUID and unique settlement');

  await q("update understand_jobs set content_expires_at=now()-interval '1 second' where id=any($1::uuid[])", [[short.jobId, expired.jobId]]);
  assert.equal((await find(short.key)).error.code, 'content_expired');
  assert.ok((await state(short.jobId)).result_text);
  const cleanup = () => post(control, controlUrl, workerToken, { action: 'cleanup_expired' });
  preserve(short.audioKey);
  const partial = await cleanup();
  assert.equal(partial.status, 500);
  assert.equal(store.has(short.requestKey), false);
  assert.equal(store.has(short.audioKey), true);
  assert.equal((await state(short.jobId)).deleted_at, null);
  assert.ok((await state(short.jobId)).result_text);
  assert.ok((await state(expired.jobId)).deleted_at);
  assert.equal((await find(expired.key)).status, 'outcome_unknown');
  assert.equal((await q('select status from credit_holds where id=(select hold_id from understand_jobs where id=$1)', [expired.jobId]))[0].status, 'pending_settlement');
  assert.deepEqual(await entries(expired.jobId), []);
  assert.deepEqual(await entries(short.jobId), ['confirm']);
  assert.equal(store.has(expired.audioKey), false);
  assert.equal(store.has(expired.requestKey), false);
  assert.equal(fs.existsSync(storagePath(expired.audioKey)), false);
  assert.equal(fs.existsSync(storagePath(expired.requestKey)), false);
  preserve(undefined);
  assert.equal((await cleanup()).status, 200);
  assert.ok((await state(short.jobId)).deleted_at);
  assert.equal((await state(short.jobId)).result_text, null);
  assert.equal(store.has(short.audioKey), false);
  assert.equal(fs.existsSync(storagePath(short.audioKey)), false);
  assert.equal(fs.existsSync(storagePath(short.requestKey)), false);
  assert.equal((await cleanup()).status, 200);
  assert.deepEqual(await entries(short.jobId), ['confirm']);
  assert.deepEqual(await entries(long.jobId), ['confirm']);
  assert.deepEqual(await entries(failed.jobId), ['rollback']);
  assert.ok(store.has(long.audioKey) && store.has(failed.audioKey));
  console.log('PASS actual Edge TTL refusal and cleanup with PostgreSQL tombstones, two filesystem objects, partial-delete retry, preserved receipts and unresolved reservation');
}
