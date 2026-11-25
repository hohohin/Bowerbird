import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

export async function verifyLibraryShotJobs(q, rival, migrationDir) {
  await q(readFileSync(join(migrationDir,"0103_library_video_shots.sql"),"utf8"));
  const user=randomUUID(), key=()=>"library-shot:"+randomUUID(), source="a".repeat(64);
  await q("insert into auth.users(id) values ($1)",[user]);
  await q("select ensure_daily_credits($1,0)",[user]);
  const exact = async () => BigInt((await q("select (sum(remaining_amount::bigint*1000+remaining_milli)) as n from credit_lots where user_id=$1 and expires_at>now()",[user]))[0].n);
  const start = async (id,milli=54,end=3000,admit=true,conn,hash=source) => (await q(
    "select to_jsonb(begin_library_shot($1,$2,$3,$4,$5,$6,20261124,$7,40000,1000000000,100)) v",
    [user,id,source,hash,{start_ms:0,end_ms:end},milli,admit],conn))[0].v;
  const c=async(action,job,lease=null,result=null,receipt=null,owner=null,msg=null)=>(await q(
    "select control_library_shot($1,$2,$3,$4,$5,$6,null,$7) v",[action,job,owner,lease,result,receipt,msg]))[0].v;
  const initial=await exact();
  const id=key();
  await assert.rejects(start(id),e=>e.detail==="price_unavailable");
  await q("update service_costs set active=true,parameters=parameters||'{\"pricing_ready\":true}'::jsonb where service='library_video_shot_analysis'");
  await assert.rejects(start(id,54,3000,false),e=>e.detail==="price_unavailable");
  await assert.rejects(start(id,54,16000),e=>e.detail==="stale_quote");
  const [a,b]=await Promise.all([start(id),start(id,54,3000,true,rival)]);
  assert.equal(a.id,b.id); assert.equal(await exact(),initial-54n);
  await assert.rejects(start(id,54,3000,true,rival,"b".repeat(64)),e=>e.detail==="manifest_conflict");
  await assert.rejects(c("commit",a.id,null,null,null,randomUUID()),e=>e.code==="P0002");
  await c("commit",a.id,null,null,null,user);
  const lease=await c("claim",null); assert.equal(lease.id,a.id);
  await c("submitted",a.id,lease.lease_id);
  await assert.rejects(c("submitted",a.id,lease.lease_id),e=>e.code==="22023");
  const receipt={usage:{prompt_tokens:192,completion_tokens:51}};
  const fields={description:"固定机位",first_frame_prompt:"蓝色球场",motion_prompt:"球员挥拍"};
  await assert.rejects(c("finish",a.id,lease.lease_id,"{}",receipt),e=>e.code==="22023");
  await assert.rejects(c("finish",a.id,lease.lease_id,JSON.stringify(fields),null),e=>e.code==="22023");
  const done=await c("finish",a.id,lease.lease_id,JSON.stringify(fields),receipt);
  assert.deepEqual(done.segment.provider_receipt,receipt);
  assert.deepEqual(JSON.parse(done.segment.result_text),fields);
  const restore=await start(id,54,3000,false); assert.equal(restore.status,"succeeded");
  assert.equal(await exact(),initial-54n);
  const second=await start(key(),134,60000);
  assert.equal(await exact(),initial-188n);
  await c("reject-upload",second.id,null,null,null,user);
  await c("reject-upload",second.id,null,null,null,user);
  assert.equal(await exact(),initial-54n);

  const unknown=await start(key(),134,60000);
  await c("commit",unknown.id,null,null,null,user);
  const leased=await c("claim",null);
  await q("update library_shot_jobs set lease_expires_at=now()-interval '1s' where id=$1",[leased.id]);
  const recovered=await c("claim",null);
  assert.notEqual(recovered.lease_id,leased.lease_id);
  await c("submitted",recovered.id,recovered.lease_id);
  await q("update library_shot_jobs set lease_expires_at=now()-interval '1s' where id=$1",[leased.id]);
  assert.equal(await c("claim",null),null);
  assert.equal((await c("expire",leased.id)).segment.status,"outcome_unknown");
  assert.equal(await exact(),initial-188n);
  await c("refund-unknown",leased.id,null,null,null,null,"fixture reconciled");
  assert.equal(await exact(),initial-54n);
  // The oldest lot supplies the remaining fractional 25, and the next lot supplies 109.
  const lot=(await q("insert into credit_lots(user_id,bucket,source_key,original_amount,remaining_amount,remaining_milli,expires_at) values ($1,'daily','shot-fractional-boundary',1,0,25,now()+interval '5 minutes') returning id",[user]))[0];
  const mixed=await start(key(),134,60000);
  const allocations=await q("select lot_id, (meta->>'amount_milli')::int as delta from credit_transactions where hold_id=$1 and kind='hold' order by delta desc",[mixed.hold_id]);
  assert.equal(allocations.length,2); assert.deepEqual(allocations[0],{lot_id:lot.id,delta:-25}); assert.equal(allocations[1].delta,-109);
  await q("update credit_lots set expires_at=now()-interval '1 second' where id=$1",[lot.id]);
  await c("reject-upload",mixed.id,null,null,null,user);
  assert.equal(await exact(),initial-54n);
  assert.equal((await q("select remaining_milli from credit_lots where id=$1",[lot.id]))[0].remaining_milli,25);
  await q("set role authenticated");
  try { await assert.rejects(c("claim",null),e=>e.code==="42501"); } finally {await q("reset role");}
  console.log("library shots: fractional FIFO reserve/refund, exact balances, gates, owner and lease fences, frozen replay, usage receipt, unknown lookup and audited refund passed");
  await q(readFileSync(join(migrationDir,"0104_library_shot_pilot.sql"),"utf8"));
  const other = randomUUID();
  const catalog = async (subject, global=false) =>
    q("select pricing_version,short_milli,long_milli from library_shot_price($1,$2)",[subject,global]);
  const activate = (params) => q("update service_costs set parameters=$1 where service='library_video_shot_analysis'",[params]);
  const rates = {pricing_ready:true,short_milli:54,long_milli:134};
  const pilot = {...rates,pilot_only:true,pilot_user_id:user};
  const quote = [{pricing_version:20261124,short_milli:54,long_milli:134}];
  assert.deepEqual(await catalog(other),[]);
  assert.deepEqual(await catalog(other,true),quote);
  await activate(pilot);
  for (const global of [false,true]) {
    assert.deepEqual(await catalog(user,global),quote);
    assert.deepEqual(await catalog(other,global),[]);
    const forged = () => q("select begin_library_shot($1,$2,$3,$3,$4,54,20261124,$5,40000,1000000000,100)",
      [other,key(),source,{start_ms:0,end_ms:3000,user_id:user,pilot_only:true},global]);
    await assert.rejects(forged,e=>e.detail==="price_unavailable");
  }
  for (const role of ["anon","authenticated"]) {
    await q("set role "+role);
    try {
      assert.equal((await q("select count(*)::int as n from service_costs where service='library_video_shot_analysis'"))[0].n,0);
      await assert.rejects(catalog(user),e=>e.code==="42501");
    } finally { await q("reset role"); }
  }
  const pilotFirst = key(), pilotNext = key();
  const [sameA,sameB]=await Promise.all([start(pilotFirst,54,3000,false),start(pilotFirst,54,3000,false,rival)]);
  assert.equal(sameA.id,sameB.id);
  const another=await start(pilotNext,134,60000,false);
  assert.notEqual(another.hold_id,sameA.hold_id);
  await assert.rejects(q("select begin_library_shot($1,$2,$3,$3,$4,54,20261124,false,0,1000000000,100)",
    [user,key(),source,{start_ms:0,end_ms:3000}]),e=>e.detail==="price_unavailable");
  await activate({...rates,pilot_user_id:user});
  assert.deepEqual(await catalog(user,true),[]);
  assert.deepEqual(await catalog(other,true),[]);
  await q("update service_costs set active=false where service='library_video_shot_analysis'");
  assert.equal((await start(pilotFirst,54,3000,false)).hold_id,sameA.hold_id);
  assert.equal((await start(pilotNext,134,60000,false)).hold_id,another.hold_id);
  assert.equal((await start(id,54,3000,false)).status,"succeeded");
  await assert.rejects(start(key(),54,3000,true),e=>e.detail==="price_unavailable");
  console.log("library shot private pilot: isolated rates, hidden catalog, service-only ACLs, verified subject, mock/closed refusal, repeat jobs and frozen old keys passed");
}
