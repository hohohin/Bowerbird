import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";

// Start a fresh loopback-only PostgreSQL cluster; never accept a database URL.
const moduleUrl = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : import.meta.resolve("embedded-postgres");
const { default: EmbeddedPostgres } = await import(moduleUrl);
const socket = createServer();
await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const databaseDir = mkdtempSync(path.join(tmpdir(), "agent-usage-"));
const db = new EmbeddedPostgres({ databaseDir, port,
  user:"fixture", password:randomUUID(), persistent:true, postgresFlags:["-h","127.0.0.1"], onLog:()=>{} });
const clients = [];
const migrationDir = "apps/cloud/supabase/migrations";
const sql = prefix => readFileSync(path.join(migrationDir,readdirSync(migrationDir).find(f=>f.startsWith(prefix))),"utf8");
try {
  await db.initialise();
  await db.start();
  for (let i=0;i<2;i++) {const c=db.getPgClient("postgres","127.0.0.1"); await c.connect(); clients.push(c);}
  const [a,b] = clients;
  const q = async (s, params=[]) => (await a.query(s, params)).rows;
  await q(`create role anon; create role supabase_auth_admin; create role authenticated; create role service_role bypassrls; create schema auth; create schema extensions;
    create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create function extensions.gen_random_uuid() returns uuid language sql as $$select gen_random_uuid()$$`);
  for(const p of ["0001","0002","0003","0004","0006","0008","0009","0012","0021","0023","0028","0030","0031","0033","0040","0043","0044","0082"]) {
    await q(sql(p).replace("create extension if not exists pgcrypto with schema extensions;",""));
  }
  // Only later columns used by this checkout's live procedures.
  await q("alter table agent_runs add column agent_runtime text default 'legacy_kernel'");
  await q(sql("0055").split("-- Settlement accounting")[1].replace(/^[^\n]+\n/,""));
  const user=randomUUID();
  await q("insert into auth.users values($1)",[user]);
  await q("select grant_topup_credits($1,'fixture-funds',1000)",[user]);
  const run=async (budget=48) => {
    const id=randomUUID(), lease=randomUUID();
    const [{hold_id:hold}]=await q("select hold_id from credit_hold($1,$2,'agent_controlled_image_edit',$3)",[user,id,budget]);
    await q(`insert into agent_runs(id,user_id,skill_id,skill_version,kernel_version,status,input_count,input_manifest_hash,
      request_object_key,budget_credits,hold_id,pricing_version,lease_id,lease_owner,lease_expires_at,content_expires_at)
      values($1,$2,'bowerbird-controlled-image-edit','1','1','running',1,repeat('a',64),'fixture',$3,$4,1,$5,'test',now()+interval '1 hour',now()+interval '1 day')`,[id,user,budget,hold,lease]);
    return {id,lease,hold};
  };
  const finish=(r,status="failed",lease=r.lease)=>q("select actual_credits from settle_agent_run($1,$2,$3)",[r.id,lease,status]);
  const legacy = await run();
  const insertCall=(r,id)=>q("insert into agent_tool_calls(run_id,call_id,phase,tool_name,args_hash,status,submitted_at) values($1,$2,'fixture','model_turn',repeat('a',64),'submitted',now())",[r.id,id]);
  await insertCall(legacy,"unposted");
  assert.equal((await finish(legacy))[0].actual_credits,0);
  console.log("RED baseline: submitted call with no usage refunded by 0082");
  if(process.argv.includes("--baseline")) assert.equal((await q("select status from credit_holds where id=$1",[legacy.hold]))[0].status,"pending_settlement");
  await q(sql("0091"));
  const prepare=(r,id="call",lease=r.lease)=>q(`insert into agent_tool_calls(run_id,call_id,phase,tool_name,args_hash,status,direct_deepseek_v1_model,model_write_lease)
    values($1,$2,'fixture','model_turn',repeat('a',64),'prepared','deepseek-fixture',$3)`,[r.id,id,lease]);
  const submitted=(r,id="call",lease=r.lease)=>q("update agent_tool_calls set status='submitted',submitted_at=now(),model_write_lease=$3 where run_id=$1 and call_id=$2",[r.id,id,lease]);
  const direct=async (r,id="call")=>{await prepare(r,id); await submitted(r,id);};
  const hold=async r=>(await q("select status,actual_amount from credit_holds where id=$1",[r.hold]))[0];
  const update=(r,status,code,units=null,id="call")=>q(`update agent_tool_calls set status=$3,safe_error_code=$4,
    pending_model_usage=$5,model_write_lease=$6,finished_at=now() where run_id=$1 and call_id=$2`,[r.id,id,status,code,units,r.lease]);
  const review=(client,r,id,action,input=null,output=null,ref="case/123")=>client.query(
    "select reconcile_agent_model_usage($1,$2,$3,$4,$5,$6) as actual", [r.id,id,ref,action,input,output]);
  const rows=async r=>q("select kind,amount,meta from credit_transactions where hold_id=$1",[r.hold]);
  const posted=(client,r,id="call",lease=r.lease)=>client.query(`insert into agent_usage_items(run_id,call_id,kind,provider,model,
    input_units,output_units,image_count,provider_cost_micros,credits,pricing_version,model_write_lease)
    values($1,$2,'model_tokens','deepseek','deepseek-fixture',600000,2,0,1200012,2,1,$3)`,[r.id,id,lease]);

  // Both RPC and direct table reads use the same service role the control plane uses.
  await q("grant select on agent_tool_calls,agent_runs,credit_holds,agent_usage_items to service_role");
  const pendingIds=async ()=>(await b.query(`select c.run_id,c.call_id,c.pending_model_usage from agent_tool_calls c
    join agent_runs r on r.id=c.run_id join credit_holds h on h.id=r.hold_id
    where h.status='pending_settlement' and r.status in ('succeeded','failed','cancelled') and r.actual_credits is null
    and c.direct_deepseek_v1_model is not null and c.status<>'prepared' and c.model_review_ref is null
    and not (c.status='failed' and coalesce(c.safe_error_code,'') in ('deepseek_http_error','deepseek_not_dispatched'))
    and not exists(select from agent_usage_items u where u.run_id=c.run_id and u.call_id=c.call_id)`)).rows;
  await b.query("set role service_role");
  const r=await run();
  await direct(r);
  await update(r,"outcome_unknown","agent_model_usage_pending",{inputUnits:600000,outputUnits:2});
  await assert.rejects(()=>q("select transition_agent_run($1,$2,'failed')",[r.id,r.lease]),/require settlement/);
  assert.equal((await finish(r))[0].actual_credits,null);
  assert.equal((await hold(r)).status,"pending_settlement");
  await q("update credit_holds set expires_at=now()-interval '1 second' where id=$1",[r.hold]);
  await q("select expire_stale_holds(100)");
  assert.equal((await hold(r)).status,"pending_settlement");
  assert.deepEqual((await pendingIds()).map(row=>row.call_id),["call"]);
  await q("update service_costs set active=false where service='agent_usage_v1'");
  await q("insert into service_costs(service,pricing_version,unit_cost,parameters) select 'agent_usage_v2',2,unit_cost,jsonb_set(parameters,'{model_tokens,minimum_credits}','19') from service_costs where service='agent_usage_v1'");
  await assert.rejects(()=>review(b,r,"different","recorded"),/no rows/);
  await assert.rejects(()=>review(b,r,"call","receipt",0,0),/conflicting saved observation/);
  await a.query("set role service_role");
  const repeated=await Promise.all([review(a,r,"call","recorded"),review(b,r,"call","recorded")]);
  assert.deepEqual(repeated.map(response=>response.rows[0].actual),[2,2]);
  await a.query("reset role");
  assert.equal((await hold(r)).actual_amount,2);
  assert.deepEqual(await q("select input_units::int,output_units::int,provider_cost_micros::int,credits,pricing_version from agent_usage_items where run_id=$1",[r.id]),
    [{input_units:600000,output_units:2,provider_cost_micros:1200012,credits:2,pricing_version:1}]);
  assert.equal((await rows(r)).filter(row=>row.meta?.entity_type==="agent_run").length,1);
  assert.equal((await rows(r)).filter(row=>row.kind==="confirm" && row.meta?.actual===2).length,1);
  await b.query("set role authenticated"); await assert.rejects(()=>review(b,r,"call","recorded"),/permission denied/);
  await b.query("set role service_role");
  console.log("PASS exact saved usage, inactive original rates, two concurrent service recoveries, single charge and business marker, role denial");

  const upgrade=await run();
  await q("insert into agent_tool_calls(run_id,call_id,phase,tool_name,args_hash,status) values($1,'old-prepared','fixture','model_turn',repeat('a',64),'prepared')",[upgrade.id]);
  await q("update agent_tool_calls set direct_deepseek_v1_model='deepseek-fixture',model_write_lease=$2 where run_id=$1 and call_id='old-prepared' and status='prepared' and direct_deepseek_v1_model is null",[upgrade.id,upgrade.lease]);
  await submitted(upgrade,"old-prepared"); await finish(upgrade);
  assert.equal((await hold(upgrade)).status,"pending_settlement");
  assert.equal((await review(b,upgrade,"old-prepared","receipt",0,0)).rows[0].actual,1);
  for(const code of ["deepseek_http_error","deepseek_not_dispatched","prepared"]) {
    const run1=await run(); await prepare(run1);
    if(code!=="prepared") {await submitted(run1); await update(run1,"failed",code);}
    assert.equal((await finish(run1))[0].actual_credits,0); assert.equal((await hold(run1)).status,"rolled_back");
    await assert.rejects(()=>submitted(run1),/invalid direct model lease/);
  }
  const historical=await run(); await insertCall(historical,"legacy"); assert.equal((await finish(historical))[0].actual_credits,0);
  const dsh=await run(); await q("update agent_runs set agent_runtime='dsh' where id=$1",[dsh.id]);
  await assert.rejects(()=>prepare(dsh),/invalid direct model lease or runtime/);
  await insertCall(dsh,"dsh"); assert.equal((await finish(dsh))[0].actual_credits,0);
  console.log("PASS prepared, definitive rejection, before dispatch, legacy and DSH isolation");

  for(const mode of ["cancelled","cancel_unleased","fail_unleased","expired_cancel","succeeded"]) {
    const run1=await run();
    await direct(run1);
    if(mode==="cancelled") await finish(run1,mode);
    else if(mode==="succeeded") {
      await q("update agent_runs set status='exporting' where id=$1",[run1.id]);
      await q(`insert into agent_artifacts(run_id,conversation_id,kind,role,object_key,mime,bytes,sha256,expires_at)
        select id,conversation_id,'result','final_result','fixture','image/png',10,repeat('a',64),now()+interval '1 day'
        from agent_runs where id=$1`,[run1.id]); await finish(run1,mode);
    } else if(mode==="expired_cancel") {
      await q("update agent_runs set cancel_requested_at=now(),lease_expires_at=now()-interval '1 second' where id=$1",[run1.id]);
      await assert.rejects(()=>finish(run1),/lease/);
      await assert.rejects(()=>posted(a,run1),/invalid direct model usage lease/);
      await q("select claim_agent_run('rescuer',60)");
    } else {
      await q("update agent_runs set status='awaiting_local_task',lease_id=null,lease_owner=null,lease_expires_at=null where id=$1",[run1.id]);
      if(mode==="fail_unleased") await q("select * from fail_unleased_agent_run($1,'fixture','fixture')",[run1.id]);
      else await q("select * from cancel_unleased_agent_run($1)",[run1.id]);
    }
    assert.equal((await q("select actual_credits from cancel_unleased_agent_run($1)",[run1.id]))[0].actual_credits,null);
    assert.equal((await hold(run1)).status,"pending_settlement");
    assert.equal((await review(b,run1,"call","no_charge")).rows[0].actual,0);
    assert.equal((await hold(run1)).status,"rolled_back");
    await assert.rejects(()=>review(b,run1,"call","receipt",2,3),/conflicting model review/);
  }
  console.log("PASS all terminal RPCs, expired cancelled lease recovery, original no-charge receipt replay");

  const over=await run();
  await direct(over); await finish(over);
  await assert.rejects(()=>review(b,over,"call","receipt",10000000,10000000),/budget/);
  assert.equal((await hold(over)).status,"pending_settlement");
  assert.deepEqual(await q("select model_review_ref from agent_tool_calls where run_id=$1",[over.id]),[{model_review_ref:null}]);
  const min=await run();
  await direct(min); await update(min,"outcome_unknown","agent_model_minimum_pending",{inputUnits:0,outputUnits:0});
  await finish(min);
  assert.equal((await review(b,min,"call","receipt",600000,2)).rows[0].actual,2);
  const rejectedLater=await run();
  await direct(rejectedLater); await update(rejectedLater,"outcome_unknown","agent_model_minimum_pending",{inputUnits:0,outputUnits:0});
  await finish(rejectedLater); assert.equal((await review(b,rejectedLater,"call","no_charge")).rows[0].actual,0);
  const minOnly=await run();
  await direct(minOnly); await update(minOnly,"outcome_unknown","agent_model_minimum_pending",{inputUnits:0,outputUnits:0}); await finish(minOnly);
  assert.equal((await review(b,minOnly,"call","recorded")).rows[0].actual,1);
  const multi=await run();
  await direct(multi,"one"); await direct(multi,"two"); await finish(multi);
  assert.equal((await review(b,multi,"one","no_charge")).rows[0].actual,null);
  assert.equal((await review(b,multi,"two","receipt",600000,2)).rows[0].actual,2);
  console.log("PASS budget ceiling, minimum recovery, known exact receipt supersedes estimated minimum, multiple missing calls");

  const race=await run();
  await direct(race);
  await a.query("begin");
  await posted(a,race);
  const waiting=b.query("select actual_credits from settle_agent_run($1,$2,'failed')",[race.id,race.lease]);
  await a.query("commit");
  assert.equal((await waiting).rows[0].actual_credits,2);
  assert.equal((await review(b,race,"call","receipt",600000,2)).rows[0].actual,2);
  assert.equal((await rows(race)).filter(row=>row.kind==="confirm" && row.meta?.actual===2).length,1);
  const stale=await run();
  await direct(stale);
  await a.query("begin"); await finish(stale);
  await b.query("reset role");
  const late=assert.rejects(()=>posted(b,stale),/closed for worker writes/);
  await a.query("commit");
  await late;
  const revoked=await run(); await direct(revoked);
  const replacement=randomUUID();
  await q("update agent_runs set lease_id=$2 where id=$1",[revoked.id,replacement]);
  await assert.rejects(()=>posted(a,revoked),/usage lease/);
  await assert.rejects(()=>update(revoked,"failed","deepseek_http_error"),/lease or runtime/);
  assert.equal((await finish(revoked,"failed",replacement))[0].actual_credits,null);
  console.log("PASS overlapping usage and settlement, replay of committed receipt, revoked lease on usage and tool checkpoint");

} finally {
  for(const c of clients) await c.end();
  if (process.platform === "win32" && db.process) {
    const binaryModule = createRequire(moduleUrl).resolve("@embedded-postgres/windows-x64");
    const { postgres } = await import(pathToFileURL(binaryModule).href);
    // pg_ctl waits for all children and releases their handles before removing the cluster.
    execFileSync(path.join(path.dirname(postgres), "pg_ctl.exe"), ["-D", databaseDir, "-w", "-m", "fast", "stop"], { windowsHide:true });
    db.process = undefined;
  } else await db.stop();
  rmSync(databaseDir, {recursive:true,force:true,maxRetries:20,retryDelay:100});
}
