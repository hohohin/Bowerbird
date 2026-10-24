// Explicit live test: one real paid analysis or rewrite on a disposable account.
// Run from repository root: input duration evidence-directory [video-analysis|text-rewrite].
// Analysis requires a <=120s/640px/10fps MP4. Rewrite takes UTF-8 text and duration 0.
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
const [videoPath,durationArg,out,operation='video-analysis',expectedTranscript]=process.argv.slice(2);
const isRewrite=operation==='text-rewrite';
assert.ok(videoPath && out && ['video-analysis','text-rewrite'].includes(operation) && (isRewrite || Number(durationArg)>0),'Usage: node test-video-replication-live.mjs input duration evidence-directory [video-analysis|text-rewrite]');
mkdirSync(out,{recursive:true});
const env={...process.env};
for(const file of ['apps/cloud/.env','apps/cloud/.env.local']) if(existsSync(file)) for(const line of readFileSync(file,'utf8').split(/\r?\n/)) {
  const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(m)env[m[1]]=m[2].replace(/\s+#.*$/,'').replace(/^(["'])(.*)\1$/,'$2');
}
const base=env.SUPABASE_URL.replace(/\/+$/,''),secret=env.SUPABASE_SECRET_KEY||env.SUPABASE_SERVICE_ROLE_KEY;
const publicConfig=await (await fetch('https://bowerbird.cn/api/image-config')).json();
assert.equal(publicConfig.supabaseUrl,base);
const pub=publicConfig.supabasePublishableKey||publicConfig.supabaseAnonKey;
const evidence={startedAt:new Date().toISOString(),operation,checks:[]};
const save=()=>writeFileSync(out+'/live-test.json',JSON.stringify(evidence,null,2));
function check(ok,label){assert.ok(ok,label);evidence.checks.push(label);save();console.log('PASS '+label);}
async function request(path,body,token=secret,key=secret,method=body?'POST':'GET') {
  const response=await fetch(base+path,{method,headers:{apikey:key,Authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
  return {status:response.status,data:await response.json().catch(()=>({}))};
}
const edge=(token,body)=>request('/functions/v1/understand-proxy?forceFunctionRegion=ap-northeast-1',body,token,pub);
let token;
try {
  const email=`replication-${randomUUID()}@example.test`,password=randomBytes(32).toString('base64url');
  const created=await request('/auth/v1/admin/users',{email,password,email_confirm:true,app_metadata:{bowerbird_test:true}});
  check(created.status===200&&created.data.id,'created isolated test account');evidence.userId=created.data.id;save();
  // Registration no longer grants credits; fund only this freshly created disposable test account.
  const funding=await request('/rest/v1/rpc/grant_topup_credits',{p_user_id:evidence.userId,p_order_id:'replication-test:'+evidence.userId,p_amount:3});
  check(funding.status===200&&funding.data[0]?.granted===true,'funded isolated test account with 3 test credits');
  const login=await request('/auth/v1/token?grant_type=password',{email,password},pub,pub);
  check(login.status===200&&login.data.access_token,'authenticated test account');token=login.data.access_token;
  const capabilities=await edge(token,{action:'replication-capabilities'});evidence.capabilities=capabilities;save();
  check(capabilities.status===200&&capabilities.data.services?.some(s=>s.operation==='video-analysis'&&s.available&&s.credits===3),'analysis enabled at 3 credits');
  check(capabilities.data.services.some(s=>s.operation==='text-rewrite'&&s.available&&s.credits===3),'rewrite enabled at 3 credits');
  const before=await request('/rest/v1/user_credits?user_id=eq.'+evidence.userId+'&select=daily_balance,sub_balance,topup_balance');evidence.balanceBefore=before.data[0];save();
  const body={action:'create',idempotency_key:'replication:'+randomUUID(),operation,...(isRewrite
    ? {rewrite:{inputText:readFileSync(videoPath,'utf8'),persona:'你是一名短视频广告编导。',rules:'保留参考的节奏和镜头语言，为目标产品重写分镜。按镜头编号输出时长、主体动作、景别运镜、光线色彩、字幕。只使用产品资料中的信息，不沿用参考品牌或功效，缺失信息标为待确认。',product:{id:'test-product',name:'白色洗发水',description:'洗发水，白色瓶身。品牌、功效与容量尚未提供。'}}}
    : {video:{mime:'video/mp4',base64:readFileSync(videoPath).toString('base64'),duration:Number(durationArg)}})};
  evidence.idempotencyKey=body.idempotency_key;save();
  const submitted=await edge(token,body);evidence.submitted=submitted;save();
  check(submitted.status===202&&submitted.data.job_id,'real '+operation+' queued');evidence.jobId=submitted.data.job_id;save();
  const repeated=await edge(token,body);check(repeated.data.job_id===evidence.jobId,'create replay uses original job');
  const recovered=await edge(token,{action:'get-by-key',idempotency_key:body.idempotency_key});check(recovered.data.job_id===evidence.jobId,'recover by original key');
  const conflict=await edge(token,{...body,...(isRewrite?{rewrite:{...body.rewrite,inputText:body.rewrite.inputText+' changed'}}:{video:{...body.video,duration:Number(durationArg)-0.1}})});check(conflict.status===409,'changed input with same key rejected');
  const deadline=Date.now()+300000;
  while(Date.now()<deadline) {
    const result=await edge(token,{action:'get',job_id:evidence.jobId});
    if(evidence.status!==result.data.status) console.log(JSON.stringify({status:result.data.status,error:result.data.error}));
    evidence.status=result.data.status;evidence.charge=result.data.charge;evidence.error=result.data.error;save();
    if(['succeeded','failed','cancelled','outcome_unknown'].includes(evidence.status)) {
      if(result.data.text){
        if(isRewrite){writeFileSync(out+'/rewrite-result.txt',result.data.text);evidence.resultChars=result.data.text.length;check(result.data.text.length>30&&result.data.text.includes('洗发水'),'returned real rewrite incorporating target product');}
        else {writeFileSync(out+'/analysis-result.json',result.data.text);const analysis=JSON.parse(result.data.text);evidence.shots=analysis.shots?.length;evidence.analysisFormat=typeof analysis.analysisText==='string'?'text':'json';check(typeof analysis.analysisText==='string'?analysis.analysisText.trim().length>30:analysis.shots?.length>0,'returned real video analysis');
          if(expectedTranscript){evidence.transcriptStatus=analysis.transcriptStatus;evidence.transcript=analysis.transcript;check(analysis.transcriptStatus==='transcribed'&&typeof analysis.transcript==='string'&&analysis.transcript.toLowerCase().includes(expectedTranscript.toLowerCase()),'returned actual speech in the root transcript field');}}
      }
      break;
    }
    await new Promise(resolve=>setTimeout(resolve,3000));
  }
  check(evidence.status==='succeeded','real model '+operation+' succeeded');
  check(evidence.charge.actual===3,'settled exactly 3 credits');
  const finishedReplay=await edge(token,body);check(finishedReplay.data.status==='succeeded'&&finishedReplay.data.job_id===evidence.jobId,'completed replay does not resubmit');
  const holds=await request('/rest/v1/credit_holds?user_id=eq.'+evidence.userId+'&select=id,service,status,estimated_amount,actual_amount');
  evidence.holds=holds.data;check(holds.data.length===1&&holds.data[0].service===(isRewrite?'replication_text_rewrite':'replication_video_analysis')&&holds.data[0].status==='confirmed'&&holds.data[0].actual_amount===3,'one confirmed independent operation hold');
  const transactions=await request('/rest/v1/credit_transactions?hold_id=eq.'+holds.data[0].id+'&select=kind,amount,service');
  evidence.transactions=transactions.data;check(transactions.data.filter(t=>t.kind==='confirm').length===1,'exactly one confirmation transaction');
  const after=await request('/rest/v1/user_credits?user_id=eq.'+evidence.userId+'&select=daily_balance,sub_balance,topup_balance');evidence.balanceAfter=after.data[0];
  const total=b=>b.daily_balance+b.sub_balance+b.topup_balance;
  check(total(evidence.balanceBefore)-total(evidence.balanceAfter)===3,'account balance decreased by exactly 3');
  evidence.passed=true;
} finally {
  // Retain uncertain jobs for reconciliation instead of erasing recovery identity.
  if(evidence.userId&&(!evidence.jobId||['succeeded','failed','cancelled'].includes(evidence.status))) {
    const removed=await request('/auth/v1/admin/users/'+evidence.userId,null,secret,secret,'DELETE');evidence.cleanupStatus=removed.status;
  }
  evidence.finishedAt=new Date().toISOString();save();
  console.log(JSON.stringify({passed:evidence.passed===true,jobId:evidence.jobId,status:evidence.status,shots:evidence.shots,charge:evidence.charge,cleanupStatus:evidence.cleanupStatus}));
}
