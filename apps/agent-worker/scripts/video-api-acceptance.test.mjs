import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareCase, submitCase, queryCase, listTaskPage, inspectTask } from './video-api-acceptance.mjs';

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-video-acceptance-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'x-request-id': 'safe-request-1' } });
test('preparation freezes one independent request without touching credentials or network', async t => {
  const dir = await directory(t); const prepared = await prepareCase(dir);
  assert.equal(prepared.networkRequests, 0);
  const request = JSON.parse(await fs.readFile(path.join(dir, 'request.json')));
  assert.equal(request.model, 'doubao-seedance-2-5-260628');
  assert.equal(request.duration, 4); assert.equal(request.generate_audio, false);
  await assert.rejects(() => prepareCase(dir), { code: 'EEXIST' });
});
test('one durable POST guard prevents replays while a query reuses the returned task', async t => {
  const dir = await directory(t); await prepareCase(dir); const methods = [];
  const fetch = async (url, init) => {
    methods.push(init.method);
    if (init.method === 'POST') {
      const state = JSON.parse(await fs.readFile(path.join(dir, 'submission.json')));
      assert.equal(state.status, 'submitting'); assert.equal(state.postCount, 1);
      return reply({ id: 'task-1' });
    }
    assert.ok(url.endsWith('/task-1'));
    return reply({ id: 'task-1', status: 'succeeded', model: 'doubao-seedance-2-5-260628', content: { video_url: 'https://private.example/result?signature=SECRET' }, usage: { completion_tokens: 38430 } });
  };
  assert.equal((await submitCase(dir, 'secret-test-key', fetch)).taskId, 'task-1');
  await assert.rejects(() => submitCase(dir, 'secret-test-key', fetch), { code: 'EEXIST' });
  const result = await queryCase(dir, 'secret-test-key', fetch);
  assert.equal(result.computedProviderCny, 2.6901); assert.equal(result.invoiceVerified, false);
  assert.deepEqual(methods, ['POST', 'GET']);
  const logs = (await Promise.all((await fs.readdir(dir)).filter(f=>f.endsWith('.json')||f.endsWith('.jsonl')).map(f=>fs.readFile(path.join(dir,f),'utf8')))).join('');
  assert.ok(!logs.includes('secret-test-key')); assert.ok(!logs.includes('signature=SECRET'));
});
test('unknown submission records safe transport cause and cannot be queried or resubmitted', async t => {
  const dir = await directory(t); await prepareCase(dir); let calls = 0;
  const fetch = async () => { calls++; throw new TypeError('Authorization Bearer DO_NOT_LOG', { cause: { code: 'EACCES', message: 'DO_NOT_LOG' } }); };
  assert.equal((await submitCase(dir, 'secret-test-key', fetch)).status, 'outcome_unknown');
  await assert.rejects(() => queryCase(dir, 'secret-test-key', fetch), /no_confirmed_task/);
  await assert.rejects(() => submitCase(dir, 'secret-test-key', fetch), { code: 'EEXIST' });
  assert.equal(calls, 1);
  const log = await fs.readFile(path.join(dir, 'diagnostics.jsonl'), 'utf8');
  assert.ok(log.includes('EACCES')); assert.ok(!log.includes('DO_NOT_LOG'));
});
test('HTTP rejection and server uncertainty keep sanitized status and request ID', async t => {
  for (const status of [403, 500]) {
    const dir = await directory(t); await prepareCase(dir);
    const result = await submitCase(dir, 'test-key', async () => reply({ error: { code: 'AccessDenied', message: 'PRIVATE_TEXT' } }, status));
    assert.equal(result.status, status === 403 ? 'rejected' : 'outcome_unknown');
    const log = await fs.readFile(path.join(dir,'diagnostics.jsonl'),'utf8');
    assert.ok(log.includes('safe-request-1')); assert.ok(log.includes('AccessDenied')); assert.ok(!log.includes('PRIVATE_TEXT'));
  }
});
test('list and inspect are GET-only and never attach candidates to the unknown original', async t => {
  const dir = await directory(t); const calls=[];
  const fetch = async (url,init)=>{calls.push({url,method:init.method});return url.includes('?') ? reply({ total:1,items:[{id:'candidate',model:'doubao-seedance-2-5-260628',status:'queued',created_at:123,duration:4,content:{video_url:'SECRET'},safety_identifier:'PRIVATE_USER'}]}) : reply({id:'candidate',status:'queued'});};
  const list=await listTaskPage(dir,1,'test-key',fetch);
  assert.equal(list.correlation,'unproven_no_automatic_match'); assert.equal(list.items[0].taskId,'candidate');
  await inspectTask(dir,'candidate','test-key',fetch);
  assert.deepEqual(calls.map(c=>c.method),['GET','GET']);
  assert.ok(calls[0].url.endsWith('?page_num=1&page_size=20')); assert.ok(!calls[0].url.includes('filter.model'));
  await assert.rejects(()=>fs.stat(path.join(dir,'submission.json')), {code:'ENOENT'});
  const saved=await fs.readFile(path.join(dir,'list-page-1.json'),'utf8');
  assert.ok(!saved.includes('SECRET')); assert.ok(!saved.includes('PRIVATE_USER'));
});
test('changing the frozen body prevents a POST', async t => {
  const dir=await directory(t); await prepareCase(dir);
  await fs.writeFile(path.join(dir,'request.json'),'{}'); let calls=0;
  await assert.rejects(()=>submitCase(dir,'test-key',async()=>{calls++;return reply({id:'bad'});}),/prepared_request_changed/);
  assert.equal(calls,0);
});

test('unexpected model strings are omitted from saved query and inspect results', async t => {
  const dir = await directory(t); await prepareCase(dir);
  await submitCase(dir,'test-key',async()=>reply({id:'task-1'}));
  const response=async()=>reply({id:'task-1',status:'queued',model:'Authorization Bearer PRIVATE_TEXT'});
  assert.equal((await queryCase(dir,'test-key',response)).model,undefined);
  assert.equal((await inspectTask(dir,'task-1','test-key',response)).model,undefined);
  assert.ok(!(await fs.readFile(path.join(dir,'result.json'),'utf8')).includes('PRIVATE_TEXT'));
});
