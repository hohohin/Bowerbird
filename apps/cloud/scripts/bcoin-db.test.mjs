// Offline PostgreSQL migration/financial regression. Never contacts a live database.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const { PGlite } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const db = new PGlite();
const dir='apps/cloud/supabase/migrations';
const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
const migrate=async(prefix)=>{
 const f=fs.readdirSync(dir).find(f=>f.startsWith(prefix));
 await db.exec(fs.readFileSync(`${dir}/${f}`,'utf8').replace('create extension if not exists pgcrypto with schema extensions;',''));
};
try {
 await db.exec(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
 create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create schema auth; create schema extensions; create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
 create function extensions.gen_random_uuid() returns uuid language sql as $$ select gen_random_uuid() $$;`);
 for(const p of ['0001','0002','0003','0004','0005','0006','0009','0010','0011','0015','0016','0017','0018','0019','0023','0058','0059','0061','0062','0063','0064','0065','0066','0067']) await migrate(p);
 const user='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', fresh='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
 await q('insert into auth.users values($1)',[user]);
 await q("select grant_topup_credits($1,'old',100)",[user]);
 const begin=async key=>(await q("select begin_classification($1,$2,'input','image',true,100,1000000,null,null) r",[user,key]))[0].r.request;
 const finish=async r=>(await q("select advance_classification($1,$2,'judge_done',null,null,'{}',true) r",[user,r.id]))[0].r;
 const old=await begin('old');
 await q("insert into pro_redemption_codes(code_hash,expires_at) values(repeat('a',64),now()+interval '1 year')");
 await q("insert into service_costs(service,unit_cost,active) values('video_seedance25_480p',0,true)");
 await q("insert into video_service_pricing values('video_seedance25_480p','480p',1,10000,20000,70,42,true)");
 const oldVideo=(await q("select * from credit_hold_video($1,'legacy-video','video_seedance25_480p',4,false)",[user]))[0];
 const lots=await q('select id,remaining_amount,expires_at::text from credit_lots order by id');
 await migrate('0070');
 await migrate('0071');
 await migrate('0072');
 await migrate('0073');
 await migrate('0074');
 assert.equal((await q("select unit_cost from service_costs where service='replication_text_rewrite_short'"))[0].unit_cost,1);
 assert.equal((await q("select unit_cost from service_costs where service='replication_text_rewrite'"))[0].unit_cost,3);
 assert.equal((await q("select * from credit_hold_bcoin_video($1,'legacy-video','video_seedance25_480p',4,false,'16:9',0)",[user]))[0].estimated_amount,oldVideo.estimated_amount);
 assert.deepEqual(await q('select id,remaining_amount,expires_at::text from credit_lots order by id'),lots);
 await q('insert into auth.users values($1)',[fresh]);
 assert.equal((await q('select count(*)::int n from credit_lots where user_id=$1',[fresh]))[0].n,0);
 await q('select grant_daily_credits($1,current_date,30)',[fresh]);
 assert.equal((await q('select count(*)::int n from credit_lots where user_id=$1',[fresh]))[0].n,0);
 assert.equal((await finish(old)).charged,0);
 const current=await begin('new'); assert.equal((await finish(current)).charged,1); assert.equal((await finish(current)).charged,1);
 assert.equal((await q('select successful_images::int n from classification_meters where user_id=$1',[user]))[0].n,1);
 const voucher=(await q("select redeem_pro_code($1,repeat('a',64)) r",[user]))[0].r; assert.equal(voucher.credits,1100);
 await q("insert into pro_redemption_codes(code_hash,expires_at) values(repeat('b',64),now()+interval '1 year')");
 assert.equal((await q("select redeem_pro_code($1,repeat('b',64)) r",[fresh]))[0].r.credits,0);
 const order=async(product,key)=> (await q(`insert into orders(user_id,provider,provider_order_id,product,amount_minor,currency,status,product_snapshot)
 select $1,'mock',$2,product,amount_minor,'CNY','pending',to_jsonb(p) from billing_products p where product=$3 returning id`,[fresh,key,product]))[0].id;
 const paid=async(id,event)=>q('select apply_bcoin_order($1,$2)',[id,event]);
 const refund=async(id,event)=>q('select refund_bcoin_order($1,$2)',[id,event]);
 const a=await order('bcoin_100','first'); await paid(a,'paid1'); await paid(a,'paid1');
 let lot=(await q("select *,expires_at::text as expiry from credit_lots where user_id=$1 and bucket='topup'",[fresh]))[0];
 assert.equal(lot.remaining_amount,100); assert.equal(lot.expiry,"infinity");
 await refund(a,'refund1'); await refund(a,'refund1');
 assert.equal((await q('select topup_balance from user_credits where user_id=$1',[fresh]))[0].topup_balance,0);
 const b=await order('bcoin_100','second'); await paid(b,'paid2');
 const hold=(await q("select * from credit_hold($1,'consume','classification',1)",[fresh]))[0];
 await assert.rejects(()=>refund(b,'refund2'));
 await q("select credit_rollback($1,'test')",[hold.hold_id]); await refund(b,'refund2');
 const c=await order('pro_monthly','sub1'); await paid(c,'subpaid1');
 const period=(await q('select current_period_end::text e from subscriptions where user_id=$1',[fresh]))[0].e;
 await paid(c,'subpaid1'); assert.equal((await q('select current_period_end::text e from subscriptions where user_id=$1',[fresh]))[0].e,period);
 const d=await order('pro_yearly','sub2'); await paid(d,'subpaid2');
 await assert.rejects(()=>refund(c,'subrefund1')); await refund(d,'subrefund2');
 assert.equal((await q('select count(*)::int n from credit_lots where user_id=$1 and bucket=\'sub\'',[fresh]))[0].n,0);
 await assert.rejects(()=>paid(awaitOrderMissing(),'bad'));
 const quote=async(service,refs=0,size=null)=>(await q('select quote_bcoin_image($1,$2,$3) r',[service,refs,size]))[0].r;
 assert.equal((await quote('image_hd',3)).credits,22);
 await assert.rejects(()=>q("select * from credit_hold($1,'stale-image-writer','image_hd',null)",[user]));
 assert.equal((await quote('image_pro_1k',0)).credits,10);
 assert.equal((await quote('image_pro_15k',2)).credits,11);
 await q("update service_costs set active=true where service='image_lite'");
 assert.equal((await quote('image_lite',0)).credits,8);
 await q("update service_costs set active=true where service like 'image_layer_%'");
 assert.equal((await quote('image_layer_edit',1,'1K')).credits,10);
 assert.equal((await quote('image_layer_edit',1,'2K')).credits,20);
 assert.equal((await quote('image_layer_decompose',1,'auto')).credits,170);
 const h=(await q("select * from credit_hold_bcoin_image($1,'layers','image_layer_decompose',1,'auto')",[user]))[0];
 await q("insert into generation_jobs(id,user_id,idempotency_key,service,request_object_key,input_manifest_hash,input_count,hold_id,estimated_credits,pricing_version,content_expires_at) values($1,$2,'layers','image_layer_decompose','test',repeat('a',64),1,$1,170,20261023,now()+interval '1 day')",[h.hold_id,user]);
 await q('select enqueue_generation_job($1,$2)',[h.hold_id,user]);
 const job=(await q("select * from claim_generation_job('test',90)"))[0];
 await q('select mark_generation_job_submitted($1,$2,null)',[job.id,job.lease_id]);
 const complete=pixels=>q("select * from complete_bcoin_image_job($1,$2,'succeeded','out','application/json',100,repeat('b',64),null,null,$3)",[job.id,job.lease_id,pixels]);
 await assert.rejects(()=>complete(null)); await assert.rejects(()=>complete([0]));
 assert.equal((await complete([1000000,2610000,2610001]))[0].actual_credits,20);
 assert.equal((await complete([1000000,2610000,2610001]))[0].actual_credits,20);
 const rehold=(await q("select * from credit_hold_bcoin_image($1,'priced','image_hd',2,null)",[user]))[0];
 await q("update service_costs set unit_cost=99 where service='image_hd'");
 assert.equal((await q("select * from credit_hold_bcoin_image($1,'priced','image_hd',2,null)",[user]))[0].estimated_amount,21);
 await assert.rejects(()=>q("select * from credit_hold_bcoin_image($1,'priced','image_hd',3,null)",[user]));
 await q("update service_costs set active=true where service like 'video_seedance25_%'");
 await q("update video_service_pricing set active=true");
 await assert.rejects(()=>q("select * from credit_hold_video($1,'stale-video-writer','video_seedance25_480p',5,false)",[user]));
 await q("select grant_topup_credits($1,'video-fixture',5000)",[user]);
 for (const [resolution,seconds,expected] of [['480p',0,110],['720p',0,245],['1080p',0,600],['480p',10,195],['720p',10,440]]) {
  const v=(await q("select * from credit_hold_bcoin_video($1,$2,$3,5,$4,'16:9',$5)",[user,`video-${resolution}-${seconds}`,`video_seedance25_${resolution}`,seconds>0,seconds]))[0];
  assert.equal(v.estimated_amount,expected);
 }
 const createVideoJob=async(hold,key)=>{
   await q("insert into generation_jobs(id,user_id,idempotency_key,service,request_object_key,input_manifest_hash,input_count,hold_id,estimated_credits,pricing_version,content_expires_at,status,lease_id,lease_expires_at,lease_owner) values($1,$2,$3,'video_seedance25_480p','input',repeat('a',64),0,$1,$4,$5,now()+interval '1 day','running',$1,now()+interval '1 hour','test')",[hold.hold_id,user,key,hold.estimated_amount,hold.pricing_version]);
   return (await q("select * from complete_generation_video_job($1,$1,'succeeded',100000,'output','video/mp4',100,repeat('a',64))",[hold.hold_id]))[0];
 };
 const fixed=(await q("select * from credit_hold_bcoin_video($1,'fixed-video','video_seedance25_480p',5,false,'16:9',0)",[user]))[0];
 assert.equal((await createVideoJob(fixed,'fixed-video')).actual_credits,110);
 // Old accepted quote still uses provider usage / old tokens_per_credit (not the new fixed formula).
 const oldDone=(await createVideoJob(oldVideo,'legacy-video'));
 assert.equal(oldDone.status,'outcome_unknown');
 assert.equal(oldDone.error_code,'video_usage_exceeds_reservation');
 for(const signature of ['quote_bcoin_image(text,integer,text)','credit_hold_bcoin_image(uuid,text,text,integer,text)','apply_bcoin_order(uuid,text)','start_pro_feature_trial(uuid)']) {
   assert.equal((await q("select has_function_privilege('authenticated',$1,'EXECUTE') allowed",[signature]))[0].allowed,false);
 }
 const trialUser='dddddddd-dddd-4ddd-dddd-dddddddddddd';
 await q('insert into auth.users values($1)',[trialUser]);
 const trial=(await q('select start_pro_feature_trial($1)::text e',[trialUser]))[0].e;
 assert.equal((await q('select start_pro_feature_trial($1)::text e',[trialUser]))[0].e,trial);
 assert.equal((await q('select count(*)::int n from credit_lots where user_id=$1',[trialUser]))[0].n,0);
 console.log('Bcoin catalogue, legacy migration, vouchers, classification, payment replay and refund checks passed');
} finally { await db.close(); }
function awaitOrderMissing(){return 'cccccccc-cccc-4ccc-cccc-cccccccccccc';}
