import { assertEquals } from "jsr:@std/assert@1";

let handler: (request: Request) => Promise<Response>;
const serve = Deno.serve;
try {
  Deno.serve = ((callback: typeof handler) => { handler = callback; return {}; }) as typeof Deno.serve;
  await import("./index.ts");
} finally {
  Deno.serve = serve;
}

Deno.test("chat model metering uses worker authentication and preserves RPC replay outcomes", async () => {
  const env = { CHAT_WORKER_TOKEN: "fixture", SUPABASE_URL: "https://supabase.invalid", SUPABASE_SECRET_KEY: "test", CHAT_DSH_TOKEN_BILLING_WORKER_ENABLED: "false" };
  const before = new Map(Object.keys(env).map(key => [key, Deno.env.get(key)]));
  for (const [key,value] of Object.entries(env)) Deno.env.set(key,value);
  const original = globalThis.fetch;
  const identity = { job_id: "fixture-job", lease_id: "fixture-lease", call_id: "a".repeat(64), model: "deepseek-flash" };
  const observation = { status: "observed", input_tokens: 10, output_tokens: 4, cache_hit_tokens: 3, cache_miss_tokens: 7 };
  const calls: unknown[] = [];
  let authorizations = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assertEquals(url.origin, env.SUPABASE_URL);
    if (url.pathname === "/rest/v1/chat_completion_jobs") return Response.json([]);
    if (url.pathname === "/rest/v1/rpc/claim_chat_session_turn" || url.pathname === "/rest/v1/rpc/claim_chat_completion") {
      return Response.json({
        id: identity.job_id, lease_id: identity.lease_id, input_hash: "fixture-hash", request_object_key: "fixture-request",
        ...(url.pathname.endsWith("session_turn") ? { dsh_session_key: "fixture-session", dsh_previous_job_id: null } : {}),
      });
    }
    if (url.pathname === "/rest/v1/rpc/claim_chat_paid_turn") {
      return Response.json({ id:identity.job_id,lease_id:identity.lease_id,input_hash:"fixture-hash",request_object_key:"fixture-request",
        dsh_session_key:"fixture-session",paid_billing:{model:identity.model,max_output_tokens:1024,max_credits:68} });
    }
    if (url.pathname === "/rest/v1/rpc/authorize_chat_paid_model") {
      assertEquals(JSON.parse(String(init?.body)), {p_job_id:identity.job_id,p_lease:identity.lease_id,p_call_id:identity.call_id,
        p_model:identity.model,p_max_output_tokens:1024});
      return ++authorizations === 1 ? Response.json(true)
        : Response.json({code:"P0001",message:"private",details:"chat_paid_budget_exhausted"}, {status:400});
    }
    if (url.pathname === "/rest/v1/rpc/finish_chat_paid_turn") {
      assertEquals(JSON.parse(String(init?.body)), { p_id:identity.job_id,p_lease:identity.lease_id,p_status:"outcome_unknown",
        p_result:null,p_error:"chat_dsh_billing_limit" });
      return Response.json(null);
    }
    if (url.pathname === "/storage/v1/object/sign/generation-temp/fixture-request") {
      return Response.json({ signedURL: "/object/sign/generation-temp/fixture-request?token=fixture" });
    }
    assertEquals(url.pathname, "/rest/v1/rpc/record_chat_model_call");
    const args = JSON.parse(String(init?.body));
    calls.push(args);
    if (args.p_observation?.input_tokens === 100) return Response.json({ code: "22023", message: "private" }, { status: 400 });
    return Response.json(calls.length !== 2);
  }) as typeof fetch;
  async function request(payload: object, token = "fixture") {
    const response = await handler(new Request("https://edge.invalid/chat-worker", {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(payload),
    }));
    return {status:response.status,body:await response.json()};
  }
  try {
    const submit = {action:"model_submit",...identity};
    assertEquals((await request(submit,"wrong")).status,401);
    assertEquals((await request({...submit,call_id:"short"})).status,400);
    assertEquals((await request({action:"model_observe",...identity,observation:null})).status,400);
    assertEquals((await request({action:"model_submit",...identity,model:"new-model"})).status,400);
    assertEquals(calls.length,0);
    assertEquals(await request(submit),{status:200,body:{recorded:true}});
    assertEquals(await request(submit),{status:200,body:{recorded:false}});
    assertEquals(await request({action:"model_observe",...identity,observation}),{status:200,body:{recorded:true}});
    const args = {p_job_id:identity.job_id,p_lease:identity.lease_id,p_call_id:identity.call_id,p_model:identity.model};
    assertEquals(calls,[{...args,p_observation:null},{...args,p_observation:null},{...args,p_observation:observation}]);
    const conflict = await request({action:"model_observe",...identity,observation:{...observation,input_tokens:100}});
    assertEquals(conflict.status,409);
    assertEquals(conflict.body.error.code,"invalid_request");
    const v2 = await request({action:"claim",engine:"dsh-vps-v2"});
    assertEquals(v2.status,200);
    assertEquals(v2.body.job.model_metering,true);
    const legacy = await request({action:"claim"});
    assertEquals(legacy.status,200);
    assertEquals(legacy.body.job.model_metering,undefined);
    const paidClaim = {action:"claim",engine:"dsh-vps-v2",paid_token_billing:true};
    const authorize = {action:"model_authorize",...identity,max_output_tokens:1024};
    assertEquals((await request(paidClaim)).body.job.paid_billing,undefined);
    assertEquals((await request(authorize)).status,503);
    Deno.env.set("CHAT_DSH_TOKEN_BILLING_WORKER_ENABLED", "true");
    assertEquals((await request({action:"claim",engine:"dsh-vps-v2"})).body.job.paid_billing,undefined);
    assertEquals((await request(paidClaim)).body.job.paid_billing,{model:identity.model,max_output_tokens:1024});
    assertEquals((await request({...authorize,max_output_tokens:0})).status,400);
    assertEquals((await request({...authorize,max_output_tokens:393217})).status,400);
    assertEquals(await request(authorize),{status:200,body:{authorized:true}});
    assertEquals(await request(authorize),{status:200,body:{authorized:false}});
    assertEquals(await request({action:"finish",...identity,status:"outcome_unknown",error_code:"chat_dsh_billing_limit"}),{status:200,body:{ok:true}});
  } finally {
    globalThis.fetch = original;
    for (const [key,value] of before) { if (value === undefined) Deno.env.delete(key); else Deno.env.set(key,value); }
  }
});
