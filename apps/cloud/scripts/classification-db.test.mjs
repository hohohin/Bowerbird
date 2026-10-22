// Isolated PostgreSQL engine; never connects to a running database.
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
const { PGlite } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const db = new PGlite();
try {
  await db.exec(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
    create schema auth; create schema extensions; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create function extensions.gen_random_uuid() returns uuid language sql as $$ select gen_random_uuid() $$;`);
  for (const prefix of ["0001","0002","0003","0004","0005","0009","0010","0023","0065","0066"]) {
    const file=fs.readdirSync("apps/cloud/supabase/migrations").find(f=>f.startsWith(prefix));
    await db.exec(fs.readFileSync(`apps/cloud/supabase/migrations/${file}`,"utf8").replace("create extension if not exists pgcrypto with schema extensions;",""));
  }
  const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
  const user="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", other="bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  await q("insert into auth.users values($1),($2)",[user,other]);
  await q("insert into credit_lots(user_id,bucket,source_key,original_amount,remaining_amount,expires_at) values($1,'topup','test',100,100,now()+interval '1 year')",[user]);
  const begin=async(key,uid=user,free=null,discovery=true)=>(await q("select begin_classification($1,$2,'input','image',$3,100,1000000,null,$4) r",[uid,key,discovery,free]))[0].r;
  const advance=async(row,action,success=false,response={},uid=user)=>(await q("select advance_classification($1,$2,$3,null,null,$4,$5) r",[uid,row.id,action,JSON.stringify(response),success]))[0].r;
  const spent=async()=>Number((await q("select coalesce(sum(actual_amount),0) n from credit_holds where service='classification' and status='confirmed'"))[0].n);
  const successes=async()=>Number((await q("select successful_images n from classification_meters where user_id=$1",[user]))[0]?.n??0);
  // First four successful images, including one Cloud fallback with several tags.
  for(let i=0;i<4;i++) {
    let {request:r}=await begin(`batch-a-${i}`);
    if(i===2) {
      r=await advance(r,"await_discovery");
      await assert.rejects(()=>q("select advance_classification($1,$2,'claim_discovery','wrong','catalogue')",[user,r.id]));
      const claim=(await q("select advance_classification($1,$2,'claim_discovery','image','catalogue') r",[user,r.id]))[0].r;
      assert.equal(claim.claimed,true);
      const replay=(await q("select advance_classification($1,$2,'claim_discovery','image','catalogue') r",[user,r.id]))[0].r;
      assert.equal(replay.claimed,false);
      await advance(r,"discovery_done",true,{status:"matched",label_ids:["a","b","c"]});
    } else await advance(r,"judge_done",true,{answers:{}});
  }
  assert.equal(await successes(),4); assert.equal(await spent(),0);
  // Failures and undetermined results don't affect the 4-image remainder.
  for(const [key,action] of [["failed","fail"],["unknown","judge_done"]]) {
    const {request:r}=await begin(key,user,10,false);
    await advance(r,action); await advance(r,action);
  }
  assert.equal(await successes(),4); assert.equal(await spent(),0);
  assert.equal((await q("select understand_count from usage_daily where user_id=$1",[user]))[0].understand_count,0);
  // Fifth image can be in another batch; replay never increments/charges again.
  const fifth=await begin("batch-b-1");
  assert.equal((await begin("batch-b-1")).claimed,false);
  await assert.rejects(()=>q("select begin_classification($1,'batch-b-1','changed','image',true,100,1000000,1000,null)",[user]));
  await advance(fifth.request,"judge_done",true); await advance(fifth.request,"judge_done",true);
  assert.equal(await successes(),5); assert.equal(await spent(),1);
  await assert.rejects(()=>advance(fifth.request,"fail",false,{},other));
  // Multiple pre-authorized requests finish interleaved and share one counter.
  const pending=await Promise.all(Array.from({length:5},(_,i)=>begin(`parallel-${i}`)));
  await Promise.all(pending.reverse().map(({request})=>advance(request,"judge_done",true)));
  assert.equal(await successes(),10); assert.equal(await spent(),2);
  // Cancelled/abandoned requests release holds and the free quota via cleanup.
  const abandoned=(await begin("abandoned",user,10)).request;
  await q("update classification_requests set updated_at=now()-interval '11 minutes' where id=$1",[abandoned.id]);
  await q("select cleanup_classification()");
  assert.equal((await q("select status from credit_holds where id=$1",[abandoned.hold_id]))[0].status,"rolled_back");
  assert.equal(await successes(),10);
  await q("update classification_requests set created_at=now()-interval '2 days' where id=$1",[fifth.request.id]);
  await q("select cleanup_classification()");
  assert.equal((await begin("batch-b-1")).request.judge_response,null);
  assert.equal((await q("select has_function_privilege('authenticated','public.advance_classification(uuid,uuid,text,text,text,jsonb,boolean)','EXECUTE') allowed"))[0].allowed,false);
  await q("update credit_lots set remaining_amount=0 where user_id=$1",[other]);
  await assert.rejects(()=>begin("no-credit",other));
  assert.equal((await q("select count(*)::int n from classification_requests where user_id=$1",[other]))[0].n,0);
  // Classification bypasses even an already-full shared user minute bucket.
  await q("insert into usage_minute(user_id,minute_start,request_count) values($1,date_trunc('minute',now()),10)",[user]);
  for(let i=0;i<20;i++) await advance((await begin(`unlimited-${i}`)).request,"fail");
  assert.equal((await q("select request_count from usage_minute where user_id=$1",[user]))[0].request_count,10);
  await assert.rejects(()=>q("select begin_classification($1,'limited','input','image',true,100,1000000,10,null)",[user]), /rate reached/);
  await assert.rejects(()=>q("select begin_classification($1,'cost-cap','input','image',true,100,1,null,null)",[user]), /cost limit/);
  assert.equal(await successes(),10); assert.equal(await spent(),2);
  console.log("PASS: classification bypasses full minute bucket, other callers still limited, cost cap preserved, 5 images/credit, multi-label single count, Jev + Cloud combined, cross-batch remainder, failures/unknown refunds, idempotency, interleaved completion, ownership, TTL, RPC permissions, insufficient credits");
} finally {await db.close();}
