// Isolated SQL contract test. Billing calls are recorded; no model or production access.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const { PGlite } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
import fs from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
const read = name => fs.readFileSync(`apps/cloud/supabase/migrations/${name}`, 'utf8');
const original = read('0012_agent_runtime_control_plane.sql');
const id = '11111111-1111-4111-8111-111111111111';
const lease = '22222222-2222-4222-8222-222222222222';
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema extensions;
    create function extensions.gen_random_uuid() returns uuid language sql as $$select gen_random_uuid()$$;
    create table billing_calls(kind text,amount integer);
    create function credit_confirm(uuid,integer) returns void language sql as $$insert into public.billing_calls values('confirm',$2)$$;
    create function credit_rollback(uuid,text) returns void language sql as $$insert into public.billing_calls values('rollback',0)$$;`);
  await db.exec(original.match(/create table public.agent_runs \([\s\S]+?\n\);/)[0].replace(/ references public\.(billing_accounts|credit_holds)\(id\) on delete restrict/g, ''));
  await db.exec(original.match(/create table public.agent_events \([\s\S]+?\n\);/)[0]);
  await db.exec(original.match(/create or replace function public.agent_run_transition_allowed[\s\S]+?\$\$;/)[0]);
  await db.exec(`alter table agent_runs add column approved_plan_hash text;
    create table agent_artifacts(run_id uuid,role text,deleted_at timestamptz);
    create table agent_usage_items(run_id uuid,credits integer);`);
  const reset = async (skill='bowerbird-unified-agent') => {
    await db.exec('truncate agent_events,agent_artifacts,agent_usage_items,agent_runs,billing_calls');
    await db.query(`insert into agent_runs(id,user_id,skill_id,skill_version,kernel_version,status,input_count,input_manifest_hash,request_object_key,budget_credits,hold_id,pricing_version,lease_id,lease_owner,lease_expires_at,content_expires_at)
      values($1,$1,$3,'1','1','exporting',1,repeat('a',64),'fixture',100,$1,1,$2,'test',now()+interval '1 hour',now()+interval '1 day')`,[id,lease,skill]);
  };
  const event = (seq,type,payload) => db.query("insert into agent_events(run_id,seq,type,display_payload,content_expires_at) values($1,$2,$3,$4,now()+interval '1 day')",[id,seq,type,JSON.stringify(payload)]);
  const text = async payload => { await event(10,'text.rewrite.started',{}); await event(90,'text.result',payload); };
  const finish = (status='succeeded',key=lease) => db.query('select status,actual_credits from settle_agent_run($1,$2,$3)',[id,key,status]);
  await db.exec(read('0054_unified_agent_revision_results.sql'));
  await reset(); await text({schemaVersion:1,text:'优化结果'});
  await assert.rejects(()=>finish(),/requires at least one result/);
  console.log('REPRODUCED: saved text is rejected by the old SQL settlement');
  await db.exec(read('0082_agent_text_settlement.sql'));
  await db.query('insert into agent_usage_items values($1,3)',[id]);
  assert.deepEqual((await finish()).rows,[{status:'succeeded',actual_credits:3}]);
  await assert.rejects(()=>finish(),/lease/);
  assert.deepEqual((await db.query('select * from billing_calls')).rows,[{kind:'confirm',amount:3}]);
  for (const payload of [{schemaVersion:1,text:''},{schemaVersion:1,text:'   '},{schemaVersion:2,text:'x'},{schemaVersion:1,text:3},{schemaVersion:1,text:'x',extra:true}]) {
    await reset(); await text(payload); await assert.rejects(()=>finish(),/requires at least one result/);
  }
  await reset(); await event(90,'text.result',{schemaVersion:1,text:'x'}); await assert.rejects(()=>finish(),/requires at least one result/);
  await reset(); await text({schemaVersion:1,text:'x'}); await db.exec("update agent_runs set approved_plan_hash=repeat('a',64)"); await assert.rejects(()=>finish(),/requires at least one result/);
  await reset(); await text({schemaVersion:1,text:'x'}); await assert.rejects(()=>finish('succeeded',id),/lease/);
  await db.exec("update agent_runs set lease_expires_at=now()-interval '1 second'"); await assert.rejects(()=>finish(),/lease/);
  for (const role of ['final_result','viewport_screenshot']) {
    await reset(); await db.query('insert into agent_artifacts values($1,$2,null)',[id,role]); await finish();
  }
  await reset('bowerbird-html-layout-render'); await text({schemaVersion:1,text:'x'}); await assert.rejects(()=>finish(),/exactly one primary/);
  await reset(); await finish('failed'); assert.deepEqual((await db.query('select * from billing_calls')).rows,[{kind:'rollback',amount:0}]);
  await reset(); await text({schemaVersion:1,text:'x'}); await db.query('insert into agent_usage_items values($1,101)',[id]); await assert.rejects(()=>finish(),/exceeds budget/);
  assert.equal((await db.query('select count(*)::int n from billing_calls')).rows[0].n,0);
  console.log('PASS: text completion, billing dispatch once, invalid results, lease, approved image plans, legacy HTML, images, failure and budget guards');
} finally { await db.close(); }

