import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { chatResult, ChatInputError, DSH_CHAT_ENGINE, DSH_CHAT_ENGINE_V2, parseChatToolReceipt, validateChatInput } from "../_shared/chat.ts";

let handler: (request: Request) => Promise<Response>;
const serve = Deno.serve;
try {
  Deno.serve = ((callback: typeof handler) => { handler = callback; return {}; }) as typeof Deno.serve;
  await import("./index.ts");
} finally { Deno.serve = serve; }

const messages = [{ role: "user" as const, content: "整理文案" }];
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
    CHAT_ENABLED: "true", CHAT_DSH_VPS_ENABLED: "true", CHAT_DSH_VPS_V2_ENABLED:"false", AGENT_DSH_RUNTIME_SELECTION_ENABLED: "true", AGENT_UNIFIED_DSH_ENABLED: "true" };
  const before = new Map(Object.keys(env).map(key => [key, Deno.env.get(key)]));
  for (const [key,value] of Object.entries(env)) Deno.env.set(key,value);
  const original = globalThis.fetch, account = "11111111-1111-4111-8111-111111111111";
  const tool = { id: "call", name: "create_canvas_cards", arguments: { cards: [] } };
  let marked = false, ttl = 60000, lease = 60000, status = "running", begins = 0, credits = 0;
  let caller = account, validToken = true, resumedUploads = 0;
  const job = () => ({ id: "job", status, content_expires_at: new Date(Date.now() + ttl).toISOString(),
    lease_expires_at: new Date(Date.now() + lease).toISOString(), pending_tool: tool, dsh_receipts: { call: "private" } });
  globalThis.fetch = (async (input,init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assertEquals(url.origin, env.SUPABASE_URL);
    switch (url.pathname) {
      case "/auth/v1/user": return validToken
        ? Response.json({ id: caller, app_metadata: { bowerbird_test: marked } })
        : Response.json({message:"session revoked"}, {status:401});
      case "/rest/v1/billing_accounts": return Response.json([{ id: account }]);
      case "/rest/v1/subscriptions": return Response.json([]);
      case "/rest/v1/service_costs": return Response.json([{ active: true, unit_cost: 0 }]);
      case "/rest/v1/chat_completion_jobs":
        assertEquals(url.searchParams.get("user_id"), "eq." + caller);
        if (url.searchParams.has("idempotency_key")) {
          const hashes: Record<string,string> = {
            "eq.old-key":"42eff990c9089edf91cf55d2fad82bb12443bc63597ba33efd073253736a505b",
            "eq.v1-upload":"db3c18cf2315b22e40e4b15ce76459739704ca29f40f7563af6d911f0f04f1e0",
          };
          const digest = hashes[url.searchParams.get("idempotency_key")!];
          return Response.json(digest && caller === account ? [{...job(), request_object_key:"fixture", input_hash:digest}] : []);
        }
        return Response.json(caller === account ? [job()] : []);
      case "/storage/v1/object/generation-temp/fixture": return Response.json({Key:"fixture"});
      case "/rest/v1/rpc/enqueue_chat_completion":
        assertEquals(JSON.parse(String(init?.body)),{p_id:"job",p_hash:"db3c18cf2315b22e40e4b15ce76459739704ca29f40f7563af6d911f0f04f1e0",p_success:true});
        resumedUploads++; return Response.json({...job(),status:"queued"});
      case "/rest/v1/rpc/cancel_chat_dsh":
        assertEquals(JSON.parse(String(init?.body)),{p_user:account,p_id:"job",p_key:null});
        return Response.json({...job(),status:"failed",error_code:"chat_cancelled"});
      case "/rest/v1/rpc/ensure_daily_credits": credits++; return Response.json([{}]);
      case "/rest/v1/rpc/begin_chat_session_turn": {
        begins++;
        const body=JSON.parse(String(init?.body));
        assertEquals(body.p_conversation,"c-01TEST"); assertEquals(body.p_user_id,account);
        return Response.json(job());
      }
      default: throw Error("unexpected local test path " + url.pathname);
    }
  }) as typeof fetch;
  async function run(body: object) {
    const r = await handler(new Request("https://edge.invalid/chat-proxy", { method: "POST", headers: { authorization: "Bearer fixture" }, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
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
    const session = {...create, engine:DSH_CHAT_ENGINE_V2, conversation_id:"c-01TEST"};
    assertEquals(publicQuote.body.dsh_vps_v2_available,false); assertEquals((await run(session)).status,503);
    Deno.env.set("CHAT_DSH_VPS_V2_ENABLED","true");
    assert((await run({action:"quote"})).body.dsh_vps_v2_available); assertEquals((await run(session)).status,202);
    assertEquals((await run({ ...session, skill: { id: "text-editor" } })).status,403);
    assertEquals(begins,1);
    marked = true;
    assert((await run({action:"quote"})).body.dsh_vps_skills_available);
    assertEquals((await run({...session,skill:{id:"text-editor"}})).status,202);
    Deno.env.set("AGENT_UNIFIED_DSH_ENABLED","false");
    assertEquals((await run({...session,skill:{id:"text-editor"}})).status,403);
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
    caller=account; validToken=false;
    const revoked=await get(); assertEquals(revoked.status,401); assert(!("pending_tool" in revoked.body));
  } finally {
    globalThis.fetch=original;
    for (const [key,value] of before) { if (value === undefined) Deno.env.delete(key); else Deno.env.set(key,value); }
  }
});
