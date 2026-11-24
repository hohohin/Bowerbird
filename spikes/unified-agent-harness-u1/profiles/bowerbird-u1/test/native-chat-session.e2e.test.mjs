import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";

const workerRoot = process.env.BOWERBIRD_CHAT_TEST_WORKER ?? resolve(import.meta.dirname, "../../../../../apps/agent-worker");
const profile = process.env.BOWERBIRD_DSH_PROFILE_TEMPLATE ?? resolve(import.meta.dirname, "..");
const {processChatJob} = await import(pathToFileURL(join(workerRoot, "src/cloud-chat/runtime.ts")).href);
const engine = "dsh-vps-v2";
const key = "aa".repeat(32);

function completion(text, inputTokens, model) {
  const chunk = {id:randomUUID(),model,choices:[{index:0,delta:{content:text},finish_reason:"stop"}],
    usage:{prompt_tokens:inputTokens,completion_tokens:9,prompt_cache_hit_tokens:2,prompt_cache_miss_tokens:inputTokens-2}};
  return {ok:true,status:200,text:async()=>"data: "+JSON.stringify(chunk)+"\n\ndata: [DONE]\n\n"};
}

test("two real DSH processes resume the same native log by server-owned identity, an independent key starts empty", async() => {
  const root=mkdtempSync(join(process.env.BOWERBIRD_DSH_RUNTIME_ROOT ?? tmpdir(),"native-chat-"));
  const state=mkdtempSync(join(process.env.BOWERBIRD_DSH_SESSION_ROOT ?? tmpdir(),"native-state-"));
  let lastRequests = [];
  async function turn(sessionKey, previous, prompt, answer, inputTokens = 35, conversationId = "room-"+sessionKey.slice(0,2)) {
    const selectedModel = prompt === "one shot" ? "deepseek-v4-pro" : prompt === "third user" ? "deepseek-flash" : null;
    const expectedModel = selectedModel ?? "deepseek-flash";
    const request = JSON.stringify({engine,conversation_id:conversationId,messages:[{role:"user",content:prompt}],tools_enabled:false,
      ...(selectedModel ? { dsh_options:{model:selectedModel,reasoningEffort:"off"} } : {})});
    const id = randomUUID(), lease = randomUUID(), calls=[];
    const metering = prompt !== "independent";
    const submitted = new Set(), observations = new Map();
    let revealLostReceipt = prompt === "first user 67890";
    lastRequests=[];
    await processChatJob({engine,id,lease_id:lease,input_url:"fixture:",input_hash:createHash("sha256").update(request).digest("hex"),
      session_key:sessionKey,previous_job_id:previous,...(metering ? {model_metering:true} : {})}, async body=>{
        calls.push(body);
        if (body.action === "model_submit" || body.action === "model_observe") {
          assert.ok(metering);
          assert.equal(body.lease_id,lease);
          assert.equal(body.job_id,id);
          assert.match(body.call_id,/^[0-9a-f]{64}$/);
          assert.equal(body.model,expectedModel);
          if (body.action === "model_submit") {
            assert.ok(!submitted.has(body.call_id));
            submitted.add(body.call_id);
          } else {
            assert.ok(submitted.has(body.call_id));
            if (observations.has(body.call_id)) assert.deepEqual(observations.get(body.call_id),body.observation);
            else observations.set(body.call_id,body.observation);
            if (revealLostReceipt) {
              revealLostReceipt=false;
              throw Error("simulated observation response loss after commit");
            }
          }
          return {recorded:true};
        }
        return {active:true};
      },{chat(){assert.fail("legacy");}},
      "legacy",async()=>new Response(request),{upstream:{apiKey:"parent-only",model:"deepseek-flash",baseUrl:"https://fixture.invalid"},runtimeRoot:root,
        profileTemplateDir:profile,sessionRoot:state,turnTimeoutMs:40000,fetch:async(_url,init)=>{
          const request = JSON.parse(init.body);
          lastRequests.push(request);
          assert.equal(request.model,expectedModel);
          assert.equal(submitted.size,metering ? lastRequests.length : 0,"each real DSH completion is authorized before the mock model");
          const compact = request.messages.at(-1).content.includes("You are now acting as a compaction engine");
          if (compact) assert.equal(request.max_tokens,8192);
          return completion(compact ? "## Critical Context\nNative compaction proof." : answer, compact ? 35 : inputTokens, expectedModel);
        }});
    assert.deepEqual(readdirSync(root),[]);
    const finish=calls.find(x=>x.action==="finish");
    assert.equal(finish?.status,"succeeded",JSON.stringify(finish));
    assert.deepEqual(finish.result.message,{role:"assistant",content:answer});
    assert.equal(observations.size,metering ? lastRequests.length : 0);
    if (metering) {
      const usage = [...observations.values()];
      assert.ok(usage.every(observation => observation.status === "observed" && observation.cache_hit_tokens === 2
        && observation.cache_miss_tokens === observation.input_tokens-2 && observation.output_tokens === 9
        && observation.provider_model === expectedModel));
      assert.deepEqual(finish.result.usage,{input_tokens:usage.reduce((total,item)=>total+item.input_tokens,0),output_tokens:9*usage.length});
    }
    if (prompt === "first user 67890") assert.equal(calls.filter(call => call.action === "model_observe").length,2,"one provider call, one receipt replay");
    return id;
  }
  try {
    const first=await turn(key,null,"first user 67890","first answer 54321");
    assert.ok(readdirSync(join(state,key)).includes(first));
    const next=await turn(key,first,"second user 12345","second answer 98765");
    const messages = lastRequests.at(-1).messages;
    for(const content of ["first user 67890","first answer 54321","second user 12345"])
      assert.equal(messages.filter(m=>m.content===content).length,1,content);
    const third=await turn(key,next,"third user","third answer");
    assert.deepEqual(readdirSync(join(state,key)).sort(),[next,third].sort(),"obsolete full snapshots reclaimed");
    await turn("bb".repeat(32),null,"independent","isolated");
    assert.doesNotMatch(JSON.stringify(lastRequests), /67890|54321|12345|98765/);
    await turn("cc".repeat(32),null,"one shot","temporary",35,"t-"+randomUUID());
    assert.ok(!readdirSync(state).includes("cc".repeat(32)));
    const longKey="dd".repeat(32);
    const firstLong=await turn(longKey,null,"long source "+ "source words ".repeat(320000), "earlier answer",1000000);
    const longSecond=await turn(longKey,firstLong,"second part " + "more words ".repeat(320000), "more answer",1000000);
    const compactedSecond = lastRequests.some(request=>request.max_tokens===8192);
    await turn(longKey,longSecond,"continue after pressure","visible final");
    assert.ok(compactedSecond || lastRequests.some(request=>request.max_tokens===8192),"the real DSH compaction model call ran");
    assert.ok(lastRequests.at(-1).messages.some(message=>String(message.content).includes("Native compaction proof.")));
  } finally { rmSync(root,{recursive:true,force:true});rmSync(state,{recursive:true,force:true}); }
});
