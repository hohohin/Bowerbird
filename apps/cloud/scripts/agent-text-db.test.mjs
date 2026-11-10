// Isolated PostgreSQL-compatible check; no production connection.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const { PGlite } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const db = new PGlite();
try {
  const original = fs.readFileSync('apps/cloud/supabase/migrations/0012_agent_runtime_control_plane.sql', 'utf8');
  const table = original.match(/create table public.agent_events \([\s\S]+?\n\);/)[0];
  await db.exec('create table public.agent_runs(id uuid primary key);' + table);
  const run = '11111111-1111-4111-8111-111111111111';
  await db.query('insert into public.agent_runs values ($1)', [run]);
  const insert = (seq, type, value) => db.query("insert into public.agent_events(run_id,seq,type,display_payload,content_expires_at) values ($1,$2,$3,$4,now()+interval '7 days')", [run, seq, type, JSON.stringify(value)]);
  const text = '中文🙂\\"\n'.repeat(10000) + '末尾';
  await insert(1, 'text.result', { schemaVersion: 1, text: '旧结果' });
  await assert.rejects(() => insert(2, 'text.result', { schemaVersion: 1, text }), /check constraint/);
  const migration = fs.readFileSync('apps/cloud/supabase/migrations/0081_agent_text_payloads.sql', 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  await insert(2, 'text.result', { schemaVersion: 1, text });
  const { rows } = await db.query('select display_payload from public.agent_events order by seq');
  assert.deepEqual(rows.map(row => row.display_payload.text), ['旧结果', text]);
  await assert.rejects(() => insert(3, 'progress', { text }), /check constraint/);
  await assert.rejects(() => insert(3, 'text.result', []), /check constraint/);
  await assert.rejects(() => insert(3, 'text.result', { text: 'x'.repeat(20 * 1024 * 1024) }), /check constraint/);
  await db.exec("create schema storage; create table storage.buckets(id text primary key,file_size_limit bigint); insert into storage.buckets values ('agent-temp',20971520),('generation-temp',209715200);");
  const capacity = fs.readFileSync('apps/cloud/supabase/migrations/0083_agent_text_capacity.sql', 'utf8');
  await db.exec(capacity); await db.exec(capacity);
  const largeText = '中文🙂'.repeat(2_100_000) + '完整末尾';
  assert.ok(Buffer.byteLength(largeText) > 20 * 1024 * 1024);
  await insert(3, 'text.result', { schemaVersion: 1, text: largeText });
  assert.equal((await db.query('select display_payload from public.agent_events where seq=3')).rows[0].display_payload.text, largeText);
  await assert.rejects(() => insert(4, 'progress', { text: largeText }), /check constraint/);
  await assert.rejects(() => insert(4, 'text.result', []), /check constraint/);
  assert.deepEqual((await db.query('select file_size_limit from storage.buckets order by id')).rows.map(row => row.file_size_limit), [null,209715200]);
  console.log('PASS: text above 20 MiB, exact roundtrip, existing rows, ordinary event and object guards, bucket inheritance and migration replay');
} finally { await db.close(); }
