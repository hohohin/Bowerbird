import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { chatResult, ChatInputError, DSH_CHAT_ENGINE, DSH_CHAT_ENGINE_V2, parseChatToolReceipt, validateChatInput } from "../_shared/chat.ts";

let handler: (request: Request) => Promise<Response>;
const serve = Deno.serve;
try {
  Deno.serve = ((callback: typeof handler) => { handler = callback; return {}; }) as typeof Deno.serve;
  await import("./index.ts");
} finally { Deno.serve = serve; }

const messages = [{ role: "user" as const, content: "整理文案" }];
Deno.test("image provider overrides are opt-in for card-capable v2 clients", () => {
  const input = { messages, conversation_id: "c-fixture", engine: DSH_CHAT_ENGINE_V2 };
  assert(!("image_card_provider" in validateChatInput(input)));
  assertEquals(validateChatInput({ ...input, image_card_provider: true }).image_card_provider, true);
  for (const patch of [{ tools_enabled: false }, { engine: DSH_CHAT_ENGINE }, { image_card_provider: "yes" }]) {
    assertThrows(() => validateChatInput({ ...input, image_card_provider: true, ...patch }), ChatInputError);
  }
});
Deno.test("video options are opt-in for card-capable v2 clients", () => {
  const input = { messages, conversation_id: "c-fixture", engine: DSH_CHAT_ENGINE_V2 };
  assert(!("video_card_options" in validateChatInput(input)));
  assertEquals(validateChatInput({ ...input, video_card_options: true }).video_card_options, true);
  for (const patch of [{ tools_enabled: false }, { engine: DSH_CHAT_ENGINE }, { video_card_options: "yes" }]) {
    assertThrows(() => validateChatInput({ ...input, video_card_options: true, ...patch }), ChatInputError);
  }
});
Deno.test("DSH accepts public history, structured skill IDs and minimal card receipts", () => {
  const base = { messages, engine: DSH_CHAT_ENGINE } as const;
  const skill = { id: "text-editor" } as const;
  assertEquals(validateChatInput({ ...base, skill }), { ...base, skill, tools_enabled: false });
  const h3 = { id: "h3-video-prompt", parameters: { mode: "frames", seconds: 5, ratio: "auto", firstFrameCount: 1, lastFrameCount: 0 } } as const;
  assertEquals(validateChatInput({ ...base, skill: h3 }).skill, h3);
  for (const request of [{ ...base, skill, tools_enabled: true }, { messages, skill }, { ...base, skill: { ...skill, instruction: "override" } },
    { ...base, skill: { ...h3, parameters: { ...h3.parameters, mode: "text" } } },
    { ...base, messages: [{ role: "assistant", content: "old answer" }] },
    { ...base, messages: [{ role: "system", content: "not public" }, ...messages] }]) {
    assertThrows(() => validateChatInput(request), ChatInputError);
  }
  assertThrows(() => parseChatToolReceipt({ success: true, action: { private: "details" } }), ChatInputError);
  assertThrows(() => parseChatToolReceipt({ success: false, error: "local path or private error" }), ChatInputError);
  assertEquals(parseChatToolReceipt({ success: true, created_count: 4 }), { success: true, created_count: 4 });
  for (const run_status of ["started", "failed", "unknown"]) {
    const receipt = { success: true, created_count: 1, run_status };
    assertEquals(parseChatToolReceipt(receipt), receipt);
  }
  assertThrows(() => parseChatToolReceipt({success: true, created_count: 1, run_status: "done"}), ChatInputError);
  const result = { message: { role: "assistant" as const, content: "done" }, usage: { input_tokens: 2000001, output_tokens: 1 } };
  assertThrows(() => chatResult(result), ChatInputError);
  assertEquals(chatResult(result, DSH_CHAT_ENGINE), result);
  assertThrows(() => chatResult({ ...result, message: { role: "assistant", content: " " } }, DSH_CHAT_ENGINE), ChatInputError);
  const session = { messages, engine: DSH_CHAT_ENGINE_V2, conversation_id: "c-01TEST" } as const;
  assertEquals(validateChatInput(session), { ...session, tools_enabled: true });
  for (const input of [{...session,messages:[...messages,...messages]}, {...session,conversation_id:"a/../b"},
    {...session,messages:[{role:"assistant",content:"previous answer"}]}, {...session,session_key:"spoofed"},
    {...session,engine:DSH_CHAT_ENGINE}]) assertThrows(()=>validateChatInput(input),ChatInputError);
});

Deno.test("public chat capability, private skill admission and temporary pending-tool exposure", async () => {
  const env = { SUPABASE_URL: "https://supabase.invalid", SUPABASE_PUBLISHABLE_KEY: "test", SUPABASE_SECRET_KEY: "test",
    CHAT_ENABLED: "true", CHAT_DSH_VPS_ENABLED: "true", CHAT_DSH_VPS_V2_ENABLED:"false", AGENT_DSH_RUNTIME_SELECTION_ENABLED: "true", AGENT_UNIFIED_DSH_ENABLED: "true",
    CHAT_DSH_VPS_V2_TEST_ONLY: "false", CHAT_DSH_TOKEN_BILLING_ENABLED: "false", AGENT_ACCESS_MODE: "test_only",
    CHAT_DAILY_COST_LIMIT_CNY: "120.01", DAILY_COST_LIMIT_CNY: "500", RATE_LIMIT_PER_USER_PER_MIN: "10" };
  const before = new Map(Object.keys(env).map(key => [key, Deno.env.get(key)]));
  for (const [key,value] of Object.entries(env)) Deno.env.set(key,value);
  const original = globalThis.fetch, account = "11111111-1111-4111-8111-111111111111";
  const tool = { id: "call", name: "create_canvas_cards", arguments: { cards: [] } };
  let marked: unknown = false;
  let userMarked = false, ttl = 60000, lease = 60000, status = "running", begins = 0, credits = 0;
  let beginError: string | undefined;
  let paidBegins = 0, paidQuotes = 0;
  const paidQuote = { available:true,model:"deepseek-flash",pricing_version:1,max_credits:71,max_output_tokens:16384,
    rates_nano:{cache_hit:1280,cache_miss:64000,output:256000} };
  let caller = account, validToken = true, resumedUploads = 0;
  const h3Run = "33333333-3333-4333-8333-333333333333";
  let originPublished = false, originContinued = false, originStatus = "succeeded";
  const job = () => ({ id: "job", status, estimated_credits:0, content_expires_at: new Date(Date.now() + ttl).toISOString(),
    lease_expires_at: new Date(Date.now() + lease).toISOString(), pending_tool: tool, dsh_receipts: { call: "private" },
    ...(status === "succeeded" ? { result_json: { message: { role: "assistant", content: "fixture" } } } : {}) });
  globalThis.fetch = (async (input,init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assertEquals(url.origin, env.SUPABASE_URL);
    switch (url.pathname) {
      case "/auth/v1/user": return validToken
        ? Response.json({ id: caller, app_metadata: { bowerbird_test: marked }, user_metadata: { bowerbird_test: userMarked } })
        : Response.json({message:"session revoked"}, {status:401});
      case "/rest/v1/billing_accounts": return Response.json([{ id: account }]);
      case "/rest/v1/subscriptions": return Response.json([]);
      case "/rest/v1/service_costs": return Response.json([{ active: true, unit_cost: 0 }]);
      case "/rest/v1/chat_completion_jobs":
        assertEquals(url.searchParams.get("user_id"), "eq." + caller);
        if (url.searchParams.has("dsh_session_key")) {
          assertMatchSessionKey(url.searchParams.get("dsh_session_key"));
          return Response.json(originContinued && caller === account && url.searchParams.get("status") === "eq.succeeded" ? [{id:"previous"}] : []);
        }
        if (url.searchParams.has("idempotency_key")) {
          const hashes: Record<string,string> = {
            "eq.old-key":"42eff990c9089edf91cf55d2fad82bb12443bc63597ba33efd073253736a505b",
            "eq.v1-upload":"db3c18cf2315b22e40e4b15ce76459739704ca29f40f7563af6d911f0f04f1e0",
            "eq.existing-v2":"fixture-v2-hash",
          };
          const digest = hashes[url.searchParams.get("idempotency_key")!];
          return Response.json(digest && caller === account ? [{...job(), request_object_key:"fixture", input_hash:digest}] : []);
        }
        return Response.json(caller === account ? [job()] : []);
      case "/rest/v1/agent_runs":
        assertEquals(url.searchParams.get("id"), "eq." + h3Run);
        assertEquals(url.searchParams.get("user_id"), "eq." + account);
        assertEquals(url.searchParams.get("status"), "eq.succeeded");
        return Response.json(caller === account && originStatus === "succeeded" ? [{id:h3Run}] : []);
      case "/rest/v1/agent_events":
        assertEquals(url.searchParams.get("run_id"), "eq." + h3Run);
        assertEquals(url.searchParams.get("type"), "eq.text.result");
        assertEquals(url.searchParams.get("display_payload"), 'cs.{"dshContinuation":true}');
        return Response.json(originPublished ? [{seq:90}] : []);
      case "/storage/v1/object/generation-temp/fixture": return Response.json({Key:"fixture"});
      case "/rest/v1/rpc/enqueue_chat_completion":
        assertEquals(JSON.parse(String(init?.body)),{p_id:"job",p_hash:"db3c18cf2315b22e40e4b15ce76459739704ca29f40f7563af6d911f0f04f1e0",p_success:true});
        resumedUploads++; return Response.json({...job(),status:"queued"});
      case "/rest/v1/rpc/cancel_chat_dsh":
        assertEquals(JSON.parse(String(init?.body)),{p_user:account,p_id:"job",p_key:null});
        return Response.json({...job(),status:"failed",error_code:"chat_cancelled"});
      case "/rest/v1/rpc/ack_chat_dsh":
        assertEquals(JSON.parse(String(init?.body)),{p_user:account,p_id:"job",p_call:"call",p_result:{success:true,created_count:0}});
        return Response.json(true);
      case "/rest/v1/rpc/ensure_daily_credits": credits++; return Response.json([{}]);
      case "/rest/v1/rpc/quote_chat_paid_turn":
        paidQuotes++;
        assertEquals(JSON.parse(String(init?.body)), { p_model: "deepseek-flash" });
        return Response.json(paidQuote);
      case "/rest/v1/rpc/begin_chat_paid_turn": {
        paidBegins++;
        const body=JSON.parse(String(init?.body));
        assertEquals([body.p_model,body.p_pricing_version,body.p_max_credits,body.p_max_output_tokens,body.p_user_id], ["deepseek-flash",1,71,16384,account]);
        if (beginError) return Response.json({ code: "P0001", message: "fixture", details: beginError }, { status: 400 });
        return Response.json({...job(),estimated_credits:71});
      }
      case "/rest/v1/rpc/get_chat_paid_receipt": {
        assertEquals(JSON.parse(String(init?.body)), { p_user_id:caller,p_id:account });
        return Response.json(caller === account ? {status:"settled",fee_nano:"140800000",carry_nano:"140800000",debited_credits:0} : null);
      }
      case "/rest/v1/rpc/begin_chat_session_turn": {
        begins++;
        const body=JSON.parse(String(init?.body));
        assert(["c-01TEST", "o-" + h3Run].includes(body.p_conversation)); assertEquals(body.p_user_id,account);
        assertEquals(body.p_daily_cost_limit, 120010000);
        assertEquals(body.p_per_minute, 10);
        if (beginError) return Response.json({ code: "P0001", message: "fixture", details: beginError }, { status: 400 });
        return Response.json(job());
      }
      default: throw Error("unexpected local test path " + url.pathname);
    }
  }) as typeof fetch;
  async function run(body: object) {
    const r = await handler(new Request("https://edge.invalid/chat-proxy", { method: "POST", headers: { authorization: "Bearer fixture" }, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  }
  function assertMatchSessionKey(value: string | null) {
    assert(/^eq\.[a-f0-9]{64}$/.test(value ?? ""));
  }
  try {
    const create = { action: "create", idempotency_key: "request", messages, engine: DSH_CHAT_ENGINE };
    const old = { action:"create", idempotency_key:"old-key", messages };
    assertEquals((await run(old)).body.job_id,"job");
    assertEquals((await run({...old,tools_enabled:false})).status,409);
    status="uploading";
    const resumed=await run({...create,idempotency_key:"v1-upload"});
    assertEquals(resumed.body.status,"queued"); assertEquals(resumedUploads,1);
    status="running";
    assertEquals((await run({action:"cancel",job_id:"job"})).body.status,"failed");
    for (const legacy of [create,{...old,idempotency_key:"new-key"}]) {
      const updated=await run(legacy);
      assertEquals(updated.status,426); assert(updated.body.error.message.includes("更新"));
    }
    caller="22222222-2222-4222-8222-222222222222";
    assertEquals((await run(old)).status,426);
    caller=account;
    assertEquals(credits,0);
    const publicQuote = await run({action:"quote"});
    assertEquals(publicQuote.body.provider,"dsh-cloud"); assertEquals(publicQuote.body.available,false);
    assertEquals(publicQuote.body.dsh_vps_available,false); assertEquals(publicQuote.body.dsh_vps_skills_available,false);
    const session = {...create, idempotency_key:"existing-v2", engine:DSH_CHAT_ENGINE_V2, conversation_id:"c-01TEST"};
    assertEquals(publicQuote.body.dsh_vps_v2_available,false); assertEquals((await run(session)).status,503);
    Deno.env.set("CHAT_DSH_VPS_V2_ENABLED","true");
    Deno.env.delete("CHAT_DSH_VPS_V2_TEST_ONLY");
    assert((await run({action:"quote"})).body.dsh_vps_v2_available); assertEquals((await run(session)).status,202);
    Deno.env.set("CHAT_DSH_VPS_V2_TEST_ONLY","true");
    userMarked = true;
    marked = "true";
    const restricted = await run({action:"quote"});
    for (const capability of ["available","dsh_vps_v2_available","image_card_provider","video_card_options","dsh_vps_skills_available"]) {
      assertEquals(restricted.body[capability],false);
    }
    const creditsBeforeRestriction = credits;
    assertEquals((await run({...session,idempotency_key:"new-v2"})).status,403);
    assertEquals((await run(session)).status,403);
    assertEquals(begins,1);
    assertEquals(credits,creditsBeforeRestriction);
    const getOriginal = () => run({action:"get",idempotency_key:session.idempotency_key});
    assertEquals((await getOriginal()).body.pending_tool,tool);
    assertEquals((await run({action:"tool_result",job_id:"job",call_id:"call",result:{success:true,created_count:0}})).status,200);
    assertEquals((await run({action:"cancel",job_id:"job"})).body.status,"failed");
    status="succeeded"; ttl=-100;
    const expired = await getOriginal();
    assertEquals(expired.body.error.code,"content_expired");
    assert(!("message" in expired.body));
    status="running"; ttl=60000;
    marked=true;
    assert((await run({action:"quote"})).body.dsh_vps_v2_available);
    assertEquals((await run(session)).status,202);
    Deno.env.set("CHAT_DSH_VPS_V2_TEST_ONLY","false");
    marked=false;
    assertEquals((await run({ ...session, skill: { id: "text-editor" } })).status,403);
    assertEquals(begins,2);
    marked = true;
    assert((await run({action:"quote"})).body.dsh_vps_skills_available);
    assertEquals((await run({...session,skill:{id:"text-editor"}})).status,202);
    Deno.env.set("AGENT_UNIFIED_DSH_ENABLED","false");
    assertEquals((await run({...session,skill:{id:"text-editor"}})).status,403);
    beginError = "chat_daily_turn_limit";
    const userCap = await run(session);
    assertEquals(userCap.status, 429);
    assertEquals(userCap.body.error.code, "rate_limited");
    assertEquals(userCap.body.error.retryable, false);
    assert(userCap.body.error.message.includes("明日"));
    beginError = "daily_cost_limit";
    const chatCap = await run(session);
    assertEquals(chatCap.status, 503);
    assertEquals(chatCap.body.error.code, "cost_limit_reached");
    assertEquals(chatCap.body.error.retryable, false);
    assert(chatCap.body.error.message.includes("云端对话"));
    beginError = undefined;
    const paid = {...session, action:"create_paid", idempotency_key:"paid-key", pricing_version:1, max_credits:71,max_output_tokens:16384,
      dsh_options:{model:"deepseek-flash",reasoningEffort:"off"}};
    const quoteRequest = {action:"quote_paid",model:"deepseek-flash"};
    assertEquals((await run(quoteRequest)).body.available,false);
    assertEquals((await run(paid)).status,503);
    assertEquals([paidBegins,paidQuotes],[0,0]);
    Deno.env.set("CHAT_DSH_TOKEN_BILLING_ENABLED","true");
    const beforePaid = begins;
    const legacyPaidMode = (await run({action:"quote"})).body;
    assertEquals(legacyPaidMode.available,false);
    assertEquals(legacyPaidMode.paid_available,true);
    assertEquals((await run({...session,idempotency_key:"no-free-fallback"})).status,426);
    assertEquals(begins,beforePaid);
    assertEquals((await run(quoteRequest)).body,{ ...paidQuote,image_card_provider:true,video_card_options:true,dsh_vps_skills_available:false });
    assertEquals((await run({...paid,max_credits:0})).status,400);
    assertEquals((await run({...paid,max_output_tokens:393217})).status,400);
    assertEquals((await run({...paid,dsh_options:undefined})).status,400);
    assertEquals(paidBegins,0);
    assertEquals((await run(paid)).body.charge.estimated,71);
    beginError = "chat_paid_price_mismatch";
    const expiredQuote = await run(paid);
    assertEquals(expiredQuote.status,409);
    assertEquals(expiredQuote.body.error.code,"quote_changed");
    beginError = "insufficient_credits";
    assertEquals((await run(paid)).status,402);
    beginError = undefined;
    Deno.env.set("CHAT_DSH_TOKEN_BILLING_ENABLED","false");
    assertEquals((await run({action:"get_paid_receipt",job_id:account})).body.receipt.fee_nano,"140800000");
    caller="22222222-2222-4222-8222-222222222222";
    assertEquals((await run({action:"get_paid_receipt",job_id:account})).body.receipt,null);
    caller=account;
    Deno.env.set("CHAT_DSH_VPS_ENABLED","false");
    assertEquals((await run(session)).status,503);
    const get = () => run({action:"get",job_id:"job"});
    const active = await get();
    assertEquals(active.body.pending_tool,tool); assert(!("dsh_receipts" in active.body));
    ttl=-100; assert(!("pending_tool" in (await get()).body));
    ttl=60000; lease=-100; assert(!("pending_tool" in (await get()).body));
    lease=60000; status="outcome_unknown"; assert(!("pending_tool" in (await get()).body));
    status="running"; caller="22222222-2222-4222-8222-222222222222";
    const wrong=await get(); assertEquals(wrong.status,404); assert(!("pending_tool" in wrong.body));
    Deno.env.set("CHAT_DSH_VPS_ENABLED","true");
    const followup = { ...session, idempotency_key:"optimization-followup", conversation_id: "o-" + h3Run };
    originPublished = true;
    const beforeOrigin = begins;
    assertEquals((await run(followup)).status,404, "another account cannot continue a real H3 run");
    caller=account;
    for (const state of ["running", "failed"]) {
      originStatus = state;
      assertEquals((await run(followup)).status,404, "only a completed rewrite may be continued");
    }
    originStatus = "succeeded";
    originPublished = false;
    assertEquals((await run(followup)).status,404, "legacy H3 runs have no native snapshot");
    assertEquals(begins, beforeOrigin);
    originPublished = true;
    assertEquals((await run(followup)).status,202);
    originPublished = false; originContinued = true;
    assertEquals((await run({...followup, idempotency_key:"another-followup"})).status,202);
    caller=account; validToken=false;
    const revoked=await get(); assertEquals(revoked.status,401); assert(!("pending_tool" in revoked.body));
  } finally {
    globalThis.fetch=original;
    for (const [key,value] of before) { if (value === undefined) Deno.env.delete(key); else Deno.env.set(key,value); }
  }
});
