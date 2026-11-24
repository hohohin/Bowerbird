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
}
