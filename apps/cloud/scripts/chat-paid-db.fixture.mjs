import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function verifyChatPaidBilling(q, db, rival) {
  const model = "deepseek-flash", price = 20261121, ceiling = 70, outputCap = 8192;
  const shape = "a".repeat(64), first = "b".repeat(64), second = "c".repeat(64);
  const owner = randomUUID(), stranger = randomUUID();
  await q("insert into auth.users(id) values($1),($2)", [owner, stranger]);
  const begins = async (key, user = owner, max = ceiling, dayCap = 500_000_000, output = outputCap) => (await q(`
    select * from begin_chat_paid_turn($1,$2,$3,$4,$5,30,false,$2,$6,$7,$8,$9)`,
    [user,key,shape,`chat/${user}/${key}/request.json`,dayCap,model,price,max,output]))[0];
  const quote = () => q("select quote_chat_paid_turn($1) as quote",[model]).then(([row]) => row.quote);
  const receipt = (job, user = owner) => q("select get_chat_paid_receipt($1,$2) as value",[user,job.id]).then(([row]) => row.value);
  const authorize = (job, id, connection = db, max = outputCap, lease = job.lease_id) => q(
    "select authorize_chat_paid_model($1,$2,$3,$4,$5) as allowed",[job.id,lease,id,model,max],connection,
  ).then(([row]) => row.allowed);
  const observe = (job, id, usage) => q("select record_chat_model_call($1,$2,$3,$4,$5)",[job.id,job.lease_id,id,model,usage]);
  const result = {message:{role:"assistant",content:"fixture"},usage:{input_tokens:1,output_tokens:1},model};
  const finish = (job, connection = db, status = "succeeded") => q("select * from finish_chat_paid_turn($1,$2,$3,$4,null)",
    [job.id,job.lease_id,status,status === "succeeded" ? result : null],connection).then(([row]) => row);
  const enqueue = job => q("select * from enqueue_chat_completion($1,$2,true)",[job.id,shape]);
  const claim = () => q("select * from claim_chat_paid_turn('paid-fixture')").then(([row]) => row);
  const claimNew = async key => {
    const created = await begins(key);
    await enqueue(created);
    const leased = await claim();
    assert.equal(leased.id,created.id);
    return leased;
  };
  const cancel = (job, user = owner) => q("select * from cancel_chat_dsh($1,$2,null)",[user,job.id]).then(([row]) => row);
  const oldRead = job => q("select status,actual_credits,error_code,result_json from chat_completion_jobs where user_id=$1 and id=$2",[owner,job.id]).then(([row]) => row);
  const refund = (job, reference) => q("select refund_chat_paid_turn($1,$2) as value",[job.id,reference]).then(([row]) => row.value);
  const paidHold = job => q("select status,estimated_amount,actual_amount from credit_holds where id=$1",[job.hold_id]).then(([row]) => row);
  const known = {status:"observed",input_tokens:3,output_tokens:2343,cache_hit_tokens:0,provider_model:"DeepSeek-V4.1-Flash-1017"};
  const promo = (await q("select id,expires_at from credit_lots where user_id=$1 and bucket='sub'",[owner]))[0];
  assert.ok(promo);

  assert.deepEqual(await quote(),{available:false,model});
  await assert.rejects(begins("disabled"),error => error.detail === "chat_paid_unavailable");
  await q("update service_costs set active=true,unit_cost=$1,parameters=jsonb_set(parameters,'{max_output_tokens}',to_jsonb($2::int)) where service='chat_paid_flash_v1'",[ceiling,outputCap]);
  assert.deepEqual(await quote(),{available:true,model,pricing_version:price,max_credits:ceiling,max_output_tokens:outputCap,
    rates_nano:{cache_hit:1280,cache_miss:64000,output:256000},service:"chat_paid_flash_v1"});
  await assert.rejects(begins("stale",owner,ceiling-1),error => error.detail === "chat_paid_price_mismatch");
  await assert.rejects(begins("global-limit",owner,ceiling,1),error => error.detail === "daily_cost_limit");
  assert.equal((await q("select count(*)::int as count from credit_holds where user_id=$1",[owner]))[0].count,0);

  const free = (await q("select * from begin_chat_session_turn($1,'old-free',$2,'chat/free',500000000,30,false,'old-free')",[owner,shape]))[0];
  await assert.rejects(begins("old-free"),error => error.detail === "chat_paid_price_mismatch");
  assert.equal(await receipt(free),null);
  const a = await begins("paid-a"), b = await begins("paid-b");
  assert.equal((await begins("paid-a")).id,a.id);
  await q("update service_costs set parameters=jsonb_set(parameters,'{max_output_tokens}','4096') where service='chat_paid_flash_v1'");
  assert.equal((await quote()).max_output_tokens,4096);
  assert.equal((await begins("paid-a")).id,a.id);
  await assert.rejects(begins("new-with-stale-output"),error => error.detail === "chat_paid_price_mismatch");
  await assert.rejects(begins("paid-a",owner,ceiling,500_000_000,4096),error => error.detail === "chat_paid_price_mismatch");
  await q("update service_costs set parameters=jsonb_set(parameters,'{max_output_tokens}','8192') where service='chat_paid_flash_v1'");
  await assert.rejects(q("select * from begin_chat_session_turn($1,'paid-a',$2,'chat/paid-a',500000000,30,false,'paid-a')",[owner,shape]),
    error => error.detail === "chat_paid_price_mismatch");
  assert.equal(await receipt(a,stranger),null);
  assert.equal((await receipt(a)).status,"pending");
  await enqueue(a); await enqueue(b);
  assert.equal((await q("select id from claim_chat_session_turn('old-fixture')"))[0].id,null);
  const leasedA = await claim(), leasedB = await claim();
  assert.deepEqual(new Set([leasedA.id,leasedB.id]),new Set([a.id,b.id]));
  assert.equal(leasedA.paid_billing.model,model);
  await assert.rejects(q("select finish_chat_completion($1,$2,'succeeded',$3,null)",[leasedA.id,leasedA.lease_id,result]),/paid-capable/);
  assert.equal((await paidHold(leasedA)).status,"pending_settlement");
  await assert.rejects(observe(leasedA,first,null),/no budget authorization/);
  await assert.rejects(authorize(leasedA,first,db,outputCap+1),/invalid paid model authorization/);
  await assert.rejects(authorize(leasedA,first,db,outputCap,randomUUID()),/invalid paid chat lease/);
  assert.deepEqual((await Promise.all([authorize(leasedA,first),authorize(leasedA,first,rival)])).sort(),[false,true]);
  await assert.rejects(authorize(leasedA,second),error => error.detail === "chat_paid_budget_exhausted");
  assert.equal(await authorize(leasedB,first),true);
  await observe(leasedA,first,known); await observe(leasedB,first,known);

  // The same account settles simultaneously from two different PG connections.
  // Expiration during execution does not replace the previously allocated lot.
  const expired = (await q("update credit_lots set expires_at=clock_timestamp()-interval '1 day' where id=$1 returning expires_at",[promo.id]))[0].expires_at;
  const finished = await Promise.all([finish(leasedA),finish(leasedB,rival)]);
  assert.deepEqual(finished.map(job=>job.actual_credits).sort(),[0,1]);
  const [charged,uncharged] = finished[0].actual_credits ? finished : finished.toReversed();
  const zeroReceipt = await receipt(uncharged);
  assert.deepEqual(zeroReceipt,{status:"settled",pricing_version:price,model,max_credits:ceiling,
    fee_nano:"600000000",debited_credits:0,carry_nano:"600000000",refund_credits:null});
  assert.equal((await receipt(charged)).carry_nano,"200000000");
  assert.equal((await finish(charged)).actual_credits,1);
  assert.equal((await q("select count(*)::int as count from credit_transactions where hold_id=$1 and kind='confirm' and lot_id is null",[charged.hold_id]))[0].count,1);
  const refunded = await refund(uncharged,"fixture-refund");
  assert.deepEqual(refunded,{...zeroReceipt,status:"refunded",refund_credits:1,carry_nano:"600000000"});
  assert.deepEqual(await refund(uncharged,"fixture-refund"),refunded);
  await assert.rejects(refund(uncharged,"different-reference"),/already recorded/);
  const [money] = await q(`select t.hold_id,t.lot_id,t.amount,l.expires_at,u.sub_balance
    from credit_transactions t join credit_lots l on l.id=t.lot_id join user_credits u on u.user_id=t.user_id
    where t.user_id=$1 and t.kind='refund'`,[owner]);
  assert.deepEqual(money,{hold_id:charged.hold_id,lot_id:promo.id,amount:1,expires_at:expired,sub_balance:0});

  await q("update credit_lots set expires_at=now()+interval '1 day' where id=$1",[promo.id]);
  const pendingLease = await claimNew("pending-paid");
  await authorize(pendingLease,first);
  await observe(pendingLease,first,known);
  assert.equal(await authorize(pendingLease,second),true);
  // The raw 0095 observation survives a supplier-side envelope violation.
  await observe(pendingLease,second,{...known,output_tokens:outputCap+1});
  assert.equal((await finish(pendingLease)).actual_credits,null);
  assert.equal((await receipt(pendingLease)).status,"pending");
  assert.deepEqual(await oldRead(pendingLease),{status:"succeeded",actual_credits:null,error_code:null,result_json:result});
  await q("update chat_completion_jobs set content_expires_at=now()-interval '1 second',content_deleted_at=now(),result_json=null where id=$1",[pendingLease.id]);
  await claim();
  assert.equal((await receipt(pendingLease)).fee_nano,"600000000");
  assert.equal((await receipt(pendingLease)).debited_credits,1);
  assert.deepEqual(await oldRead(pendingLease),{status:"succeeded",actual_credits:1,error_code:null,result_json:null});
  assert.equal((await q("select observation->>'output_tokens' as tokens from chat_model_calls where job_id=$1 and call_id=$2",[pendingLease.id,second]))[0].tokens,String(outputCap+1));

  const lateKnown = await claimNew("late-known-paid");
  await authorize(lateKnown,first);
  assert.equal((await finish(lateKnown)).actual_credits,null);
  await assert.rejects(observe({...lateKnown,lease_id:randomUUID()},first,known),/invalid chat model lease/);
  await observe(lateKnown,first,known);
  await claim();
  assert.equal((await receipt(lateKnown)).fee_nano,"600000000");
  await observe(lateKnown,first,known);
  await assert.rejects(observe(lateKnown,first,{...known,output_tokens:1}),/conflicting chat model observation/);

  const cancelled = await begins("cancel-paid");
  assert.equal((await cancel(cancelled,stranger)).id,null);
  const stopped = await cancel(cancelled);
  assert.equal(stopped.actual_credits,0);
  assert.equal((await receipt(cancelled)).fee_nano,"0");
  assert.equal((await paidHold(cancelled)).status,"rolled_back");
  assert.deepEqual(await oldRead(cancelled),{status:"failed",actual_credits:0,error_code:"chat_cancelled",result_json:null});

  const uploadFailure = await begins("upload-paid-failure");
  const [noObject] = await q("select * from enqueue_chat_completion($1,$2,false)",[uploadFailure.id,shape]);
  assert.equal(noObject.error_code,"chat_upload_failed");
  assert.equal((await receipt(uploadFailure)).fee_nano,"0");
  assert.equal((await paidHold(uploadFailure)).status,"rolled_back");
  assert.deepEqual(await oldRead(uploadFailure),{status:"failed",actual_credits:0,error_code:"chat_upload_failed",result_json:null});
  assert.equal((await q("select * from enqueue_chat_completion($1,$2,true)",[uploadFailure.id,shape]))[0].status,"failed");

  const runningKnown = await claimNew("running-known-paid");
  await authorize(runningKnown,first);
  await observe(runningKnown,first,known);
  assert.equal((await cancel(runningKnown)).status,"outcome_unknown");
  assert.equal((await receipt(runningKnown)).fee_nano,"600000000");
  await assert.rejects(authorize(runningKnown,second),/invalid paid chat lease/);
  assert.deepEqual(await oldRead(runningKnown),{status:"outcome_unknown",actual_credits:1,error_code:"chat_cancelled",result_json:null});

  const runningUnknown = await claimNew("running-unknown-paid");
  await authorize(runningUnknown,first);
  assert.equal((await cancel(runningUnknown)).actual_credits,null);
  assert.equal((await receipt(runningUnknown)).status,"pending");
  assert.equal((await paidHold(runningUnknown)).status,"pending_settlement");
  await observe(runningUnknown,first,{status:"unknown"});
  await assert.rejects(observe(runningUnknown,first,known),/conflicting chat model observation/);
  await q("update chat_completion_jobs set content_expires_at=now()-interval '1 second' where id=$1",[runningUnknown.id]);
  await claim();
  assert.equal((await receipt(runningUnknown)).fee_nano,"0");
  assert.equal((await paidHold(runningUnknown)).status,"rolled_back");
  assert.equal((await oldRead(runningUnknown)).actual_credits,0);

  const staleUpload = await begins("stale-paid-upload");
  await q("update credit_holds set expires_at=now()-interval '1 second' where id=$1",[staleUpload.hold_id]);
  await q("select expire_stale_holds(100)");
  assert.equal((await paidHold(staleUpload)).status,"pending_settlement");
  await q("update chat_completion_jobs set content_expires_at=now()-interval '1 second' where id=$1",[staleUpload.id]);
  await q("select id from claim_chat_session_turn('old-fixture')");
  assert.equal((await oldRead(staleUpload)).error_code,"chat_expired");
  assert.equal((await paidHold(staleUpload)).status,"rolled_back");
  assert.equal((await receipt(staleUpload)).status,"pending");
  await claim();
  assert.equal((await receipt(staleUpload)).fee_nano,"0");

  const shortHold = await claimNew("short-paid-hold");
  await authorize(shortHold,first);
  await observe(shortHold,first,known);
  await q("begin");
  try {
    await q("delete from credit_hold_allocations where hold_id=$1",[shortHold.hold_id]);
    await assert.rejects(finish(shortHold),error => error.detail === "chat_paid_budget_exhausted");
  } finally {
    await q("rollback");
  }
  assert.equal((await oldRead(shortHold)).status,"running");
  assert.equal((await receipt(shortHold)).status,"pending");
  assert.equal((await finish(shortHold)).actual_credits,1);

  const stopBeforeReceipt = await claimNew("stop-before-receipt");
  await authorize(stopBeforeReceipt,first);
  assert.equal((await cancel(stopBeforeReceipt)).actual_credits,null);
  assert.equal((await receipt(stopBeforeReceipt)).status,"pending");
  await observe(stopBeforeReceipt,first,known);
  await claim();
  assert.equal((await receipt(stopBeforeReceipt)).fee_nano,"600000000");
  assert.equal((await paidHold(stopBeforeReceipt)).status,"confirmed");
  assert.deepEqual(await oldRead(stopBeforeReceipt),{status:"outcome_unknown",actual_credits:0,error_code:"chat_cancelled",result_json:null});

  const setAliases = (aliases, service = "chat_paid_flash_v1") => q(
    "update service_costs set parameters=jsonb_set(parameters,'{provider_models}',$1::jsonb) where service=$2",
    [JSON.stringify(aliases),service],
  );
  const priorAliases = ["deepseek-flash","deepseek-v4.1-flash-1017"];
  const nextAlias = "DeepSeek-V4.1-Flash-9999";
  const proAlias = "DeepSeek-V4-Pro-0813";
  const disabledQuote = {available:false,model};
  await q("update service_costs set parameters=parameters-'provider_models' where service='chat_paid_flash_v1'");
  assert.deepEqual(await quote(),disabledQuote);
  for (const invalid of [null,[],"deepseek-flash",[null],[""],["unknown-model"],
    [`DeepSeek-V4.${"2".repeat(120)}-Flash`],[proAlias],[...priorAliases,proAlias]]) {
    await setAliases(invalid);
    assert.deepEqual(await quote(),disabledQuote);
  }
  await assert.rejects(begins("aliases-invalid"),error => error.detail === "chat_paid_unavailable");
  await setAliases(priorAliases);

  const oldAliasJob = await claimNew("prior-provider-alias");
  assert.deepEqual(oldAliasJob.paid_billing.provider_models,priorAliases);
  const publicQuote = await quote();
  await setAliases([nextAlias]);
  assert.deepEqual(await quote(),publicQuote);
  assert.deepEqual((await begins("prior-provider-alias")).paid_billing.provider_models,priorAliases);
  const [walletSnapshot] = await q("select billing_snapshot ? 'provider_models' as includes_aliases from credit_holds where id=$1",[oldAliasJob.hold_id]);
  assert.equal(walletSnapshot.includes_aliases,false);
  await authorize(oldAliasJob,first);
  await observe(oldAliasJob,first,known);
  await finish(oldAliasJob);
  assert.equal((await receipt(oldAliasJob)).fee_nano,"600000000");

  const nextAliasJob = await claimNew("next-provider-alias");
  assert.deepEqual(nextAliasJob.paid_billing.provider_models,[nextAlias]);
  await authorize(nextAliasJob,first);
  await observe(nextAliasJob,first,{...known,provider_model:nextAlias});
  await finish(nextAliasJob);
  assert.equal((await receipt(nextAliasJob)).fee_nano,"600000000");

  for (const [index,provider_model] of [known.provider_model,proAlias,"Unknown-Provider-Model"].entries()) {
    const job = await claimNew(`mismatched-provider-alias-${index}`);
    await authorize(job,first);
    await observe(job,first,{...known,provider_model});
    assert.equal((await finish(job)).actual_credits,null);
    assert.equal((await receipt(job)).status,"pending");
    await q("update chat_completion_jobs set content_expires_at=now()-interval '1 second' where id=$1",[job.id]);
    await claim();
    assert.equal((await receipt(job)).fee_nano,"0");
    assert.equal((await q("select observation->>'provider_model' as model from chat_model_calls where job_id=$1",[job.id]))[0].model,provider_model);
  }

  await q(`update service_costs set active=true,unit_cost=500,
    parameters=jsonb_set(parameters,'{max_output_tokens}','8192') where service='chat_paid_pro_v1'`);
  const proQuote = () => q("select quote_chat_paid_turn('deepseek-v4-pro') as quote").then(([row]) => row.quote);
  assert.equal((await proQuote()).available,true);
  await setAliases([proAlias,nextAlias],"chat_paid_pro_v1");
  assert.deepEqual(await proQuote(),{available:false,model:"deepseek-v4-pro"});
  for (const role of ["anon","authenticated"]) {
    const [grants] = await q(`select
      has_function_privilege($1,'quote_chat_paid_turn(text)','execute') as quote,
      has_function_privilege($1,'begin_chat_paid_turn(uuid,text,text,text,bigint,integer,boolean,text,text,integer,integer,integer)','execute') as admission`,[role]);
    assert.deepEqual(grants,{quote:false,admission:false});
    await q("begin");
    try {
      await q(`set local role ${role}`);
      assert.deepEqual(await q("select service from service_costs where service in ('chat_deepseek','chat_paid_flash_v1','chat_paid_pro_v1')"),
        [{service:"chat_deepseek"}]);
    } finally { await q("rollback"); }
  }
  const [access] = await q(`select has_table_privilege('authenticated','chat_paid_receipts','select') as direct_read,
    has_function_privilege('authenticated','get_chat_paid_receipt(uuid,uuid)','execute') as user_rpc,
    has_function_privilege('service_role','get_chat_paid_receipt(uuid,uuid)','execute') as service_read`);
  assert.deepEqual(access,{direct_read:false,user_rpc:false,service_read:true});
  console.log("paid chat: approved caps, legacy isolation, late 0095 usage, no wallet top-up, parallel carry, refunds, cancellation, upload, TTL and private alias rotation passed");

  const output = 16_384, flashHold = 71, proHold = 312, dailyCap = 500_000_000;
  const ordinary = randomUUID(), pro = randomUUID(), lowBalance = randomUUID();
  await q("insert into auth.users(id) values($1),($2),($3)",[ordinary,pro,lowBalance]);
  await q("update subscriptions set tier='pro',current_period_end=now()+interval '1 month' where user_id=$1",[pro]);
  await q("select grant_subscription_credits($1,'paid-rollout-fixture',800,now()+interval '30 days')",[pro]);
  await q("update service_costs set parameters=jsonb_set(parameters,'{free_turns_per_day}','5') where service='chat_deepseek'");
  await setAliases([proAlias],"chat_paid_pro_v1");
  await q(`update service_costs set unit_cost=320,parameters=jsonb_set(parameters,'{max_output_tokens}','32768')
    where service='chat_paid_pro_v1'`);
  assert.deepEqual(await proQuote(),{available:false,model:"deepseek-v4-pro"});
  await q("update service_costs set unit_cost=321 where service='chat_paid_pro_v1'");
  assert.equal((await proQuote()).max_credits,321);
  await q(`update service_costs set unit_cost=case service when 'chat_paid_flash_v1' then $1::int else $2::int end,
    parameters=jsonb_set(parameters,'{max_output_tokens}',to_jsonb($3::int))
    where service in ('chat_paid_flash_v1','chat_paid_pro_v1')`,[flashHold,proHold,output]);
  await setAliases(priorAliases);

  const startFree = async (user, key) => (await q("select * from begin_chat_session_turn($1,$2,$3,'chat/free',$4,30,false,$2)",
    [user,key,shape,dailyCap]))[0];
  const startPaid = async (user, paidModel, hold, key, conversation, dayCap = dailyCap, connection = db) => (await q(
    "select * from begin_chat_paid_turn($1,$2,$3,'chat/paid',$4,30,false,$5,$6,$7,$8,$9)",
    [user,key,shape,dayCap,conversation,paidModel,price,hold,output],connection))[0];
  const balance = async user => (await q("select daily_balance+sub_balance+topup_balance as amount from user_credits where user_id=$1",[user]))[0].amount;
  const day = async () => (await q(`select request_count::int as requests,cost_micros::int as micros from system_chat_usage_daily
    where business_date=(now() at time zone 'Asia/Shanghai')::date`))[0];
  const userDay = async user => (await q(`select request_count,chat_request_count,cost_micros::int as micros from usage_daily
    where user_id=$1 and business_date=(now() at time zone 'Asia/Shanghai')::date`,[user]))[0];

  for (const {user, paidModel, hold, usage, fee} of [
    {user:ordinary, paidModel:model, hold:flashHold, usage:{...known,input_tokens:4,cache_hit_tokens:1}, fee:600_001_280},
    {user:pro, paidModel:"deepseek-v4-pro", hold:proHold,
      usage:{...known,input_tokens:4,cache_hit_tokens:1,output_tokens:694,provider_model:proAlias}, fee:600_489_600},
  ]) {
    for (let i=0;i<5;i++) {
      const legacy = await startFree(user,`legacy-${i}`);
      assert.equal((await cancel(legacy,user)).actual_credits,0);
      assert.equal(await receipt(legacy,user),null);
    }
    await assert.rejects(startFree(user,"legacy-sixth"),error => error.detail === "chat_daily_turn_limit");
    const before = await day();
    const userBefore = await userDay(user);
    const initialBalance = await balance(user);
    const reservedMicros = Math.ceil(hold*1_000_000/32);
    let previous = null;
    for (let i=0;i<6;i++) {
      const key = `rollout-${i}`;
      const job = await startPaid(user,paidModel,hold,key,"rollout-conversation");
      assert.equal(job.dsh_previous_job_id,previous);
      assert.equal(await balance(user),initialBalance-Math.floor(i*fee/1_000_000_000)-hold);
      assert.equal((await startPaid(user,paidModel,hold,key,"rollout-conversation")).id,job.id);
      await enqueue(job);
      const lease = await claim();
      assert.equal(lease.id,job.id);
      const allow = (call,max) => q("select authorize_chat_paid_model($1,$2,$3,$4,$5) as allowed",
        [job.id,lease.lease_id,call,paidModel,max]).then(([row]) => row.allowed);
      const record = call => q("select record_chat_model_call($1,$2,$3,$4,$5)",[job.id,lease.lease_id,call,paidModel,usage]);
      assert.equal(await allow(first,output),true);
      await record(first);
      if (user === pro && i === 5) {
        // Pro's 312-Bcoin ceiling covers one full envelope and only 0.572928 Bcoin of prior use.
        await assert.rejects(allow(second,output),error => error.detail === "chat_paid_budget_exhausted");
        await assert.rejects(allow(second,16_337),error => error.detail === "chat_paid_budget_exhausted");
        assert.equal(await allow(second,16_336),true);
        await record(second);
      }
      const cumulative = (i+1+(user === pro && i === 5 ? 1 : 0))*fee;
      const totalDebit = Math.floor(cumulative/1_000_000_000);
      const roundDebit = totalDebit-Math.floor(i*fee/1_000_000_000);
      const [ended] = await q("select * from finish_chat_paid_turn($1,$2,'succeeded',$3,null)",
        [job.id,lease.lease_id,{...result,model:paidModel}]);
      assert.equal(ended.actual_credits,roundDebit);
      const bill = await receipt(job,user);
      assert.equal(bill.fee_nano,String(cumulative-i*fee));
      assert.equal(bill.debited_credits,roundDebit);
      assert.equal(bill.carry_nano,String(cumulative%1_000_000_000));
      assert.deepEqual(await paidHold(job),{status:"confirmed",estimated_amount:hold,actual_amount:roundDebit});
      assert.equal(await balance(user),initialBalance-totalDebit);
      previous = job.id;
    }
    assert.deepEqual(await userDay(user),{request_count:userBefore.request_count+6,chat_request_count:5,micros:userBefore.micros+6*reservedMicros});
    assert.deepEqual(await day(),{requests:before.requests+6,micros:before.micros+6*reservedMicros});
  }

  const beforeRejection = await day();
  const lowBalanceBefore = await balance(lowBalance);
  assert.ok(lowBalanceBefore<proHold);
  await assert.rejects(startPaid(lowBalance,"deepseek-v4-pro",proHold,"too-poor","low-balance"),
    error => error.detail === "insufficient_credits");
  assert.equal(await balance(lowBalance),lowBalanceBefore);
  assert.equal(await userDay(lowBalance),undefined);
  assert.deepEqual(await q("select id from credit_holds where user_id=$1",[lowBalance]),[]);
  assert.deepEqual(await q("select id from chat_completion_jobs where user_id=$1",[lowBalance]),[]);
  assert.deepEqual(await day(),beforeRejection);

  const dayCap = beforeRejection.micros+2_218_750;
  const attempts = await Promise.allSettled([
    startPaid(ordinary,model,flashHold,"last-slot","last-slot",dayCap),
    startPaid(pro,model,flashHold,"last-slot","last-slot",dayCap,rival),
  ]);
  const winner = attempts.find(attempt => attempt.status === "fulfilled");
  assert.ok(winner);
  assert.equal(attempts.find(attempt => attempt.status === "rejected")?.reason.detail,"daily_cost_limit");
  const accepted = winner.value;
  await q("update service_costs set active=false where service in ('chat_paid_flash_v1','chat_paid_pro_v1')");
  assert.deepEqual(await quote(),disabledQuote);
  assert.deepEqual(await proQuote(),{available:false,model:"deepseek-v4-pro"});
  await assert.rejects(startPaid(accepted.user_id,model,flashHold,"new-while-paused","paused"),
    error => error.detail === "chat_paid_unavailable");
  assert.equal((await startPaid(accepted.user_id,model,flashHold,"last-slot","last-slot",dayCap)).id,accepted.id);
  await enqueue(accepted);
  const leased = await claim();
  assert.equal(leased.id,accepted.id);
  assert.equal(await authorize(leased,first,db,output),true);
  await observe(leased,first,known);
  assert.equal((await finish(leased)).status,"succeeded");
  assert.equal((await receipt(accepted,accepted.user_id)).fee_nano,"600000000");
  assert.deepEqual(await day(),{requests:beforeRejection.requests+1,micros:dayCap});
  const [lastSlot] = await q("select count(*)::int as count from credit_holds where idempotency_key='chat:last-slot'");
  assert.equal(lastSlot.count,1);
  assert.deepEqual(await q(`select j.id from chat_completion_jobs j join credit_holds h on h.id=j.hold_id
    left join chat_paid_receipts r on r.job_id=j.id where j.paid_billing is not null and
    (j.status in ('uploading','queued','running') or r.job_id is null or h.status in ('held','pending_settlement')
      or j.actual_credits is distinct from r.debited_credits)`),[]);
  assert.deepEqual(await q(`select a.user_id from chat_paid_accounts a join chat_paid_receipts r on r.user_id=a.user_id
    group by a.user_id,a.carry_nano
    having a.carry_nano <> mod(coalesce(sum(r.fee_nano) filter (where r.refund_reference is null),0),1000000000)
      or sum(r.debited_credits)-sum(coalesce(r.refunded_credits,0)) <>
        floor(coalesce(sum(r.fee_nano) filter (where r.refund_reference is null),0)/1000000000)`),[]);
  console.log("paid chat rollout: six Flash/Pro rounds after free quota, actual wallet/carry, Pro caps, insufficient funds, concurrent daily cap and original-order settlement after catalog closure passed");
}
