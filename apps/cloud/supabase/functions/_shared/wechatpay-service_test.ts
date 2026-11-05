import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { AuthContext } from "./auth.ts";
import { handleCheckoutStatus, handleWechatNotification, publicPayment, reconcileWechatOrder, reconcileWechatRefund, type PaymentBundle } from "./wechatpay-service.ts";
import { WechatPayClient, type WechatPayConfig } from "./wechatpay.ts";
const encoder = new TextEncoder();
const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]) };
const pair = await crypto.subtle.generateKey(algorithm, true, ["sign","verify"]);
const b64 = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value)));
const config: WechatPayConfig = { mchid: "1900000001", appid: "wx1234567890abcdef", merchantSerial: "ABC123", apiV3Key: "12345678901234567890123456789012", publicKeyId: "PUB_KEY_ID_1234", notifyUrl: "https://example.invalid/notify",
  privateKey: `-----BEGIN PRIVATE KEY-----\n${b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey))}\n-----END PRIVATE KEY-----`,
  publicKey: `-----BEGIN PUBLIC KEY-----\n${b64(await crypto.subtle.exportKey("spki", pair.publicKey))}\n-----END PUBLIC KEY-----` };
async function signed(raw: string) {
  const timestamp = Math.floor(Date.now()/1000);
  return new Headers({ "wechatpay-timestamp": String(timestamp), "wechatpay-nonce": "nonce", "wechatpay-serial": config.publicKeyId,
    "wechatpay-signature": b64(await crypto.subtle.sign(algorithm, pair.privateKey, encoder.encode(`${timestamp}\nnonce\n${raw}\n`))) });
}
function bundle(): PaymentBundle {
  const expires = new Date(Date.now()+900000).toISOString();
  return { order: { id: "11111111-1111-4111-8111-111111111111", user_id: "user", product: "bcoin_100", status: "pending", amount_minor: 500, currency: "CNY", product_snapshot: { credits: 100, months: 0, kind: "credits" } },
  payment: { mchid: config.mchid, appid: config.appid, out_trade_no: "original-order", transaction_id: null, code_url: null, payment_state: "CREATED", time_expire: expires,
    native_request: { mchid:config.mchid,appid:config.appid,out_trade_no:"original-order",description:"Bowerbird 100 Bcoin",time_expire:expires,notify_url:"https://example.invalid/frozen-notify",amount:{total:500,currency:"CNY"} } } };
}
function refund(): NonNullable<PaymentBundle["refund"]> { return { id:"r1",out_refund_no:"original-refund",state:"reserved",amount_minor:500,
  request_payload:{out_trade_no:"original-order",out_refund_no:"original-refund",notify_url:"https://example.invalid/frozen-refund",amount:{refund:500,total:500,currency:"CNY"}} }; }
function transaction(b: PaymentBundle, state: string) { return { mchid: config.mchid, appid: config.appid, out_trade_no: b.payment.out_trade_no, trade_type: "NATIVE", trade_state: state, amount: { total: 500, currency: "CNY" }, ...(state === "SUCCESS" ? { transaction_id: "tx1" } : {}) }; }
function database(result: unknown = { accepted: true, status: "applied" }) {
  const calls: Array<{name:string; args:Record<string,unknown>}> = [];
  const admin = { rpc(name: string, args: Record<string,unknown>) { calls.push({name,args}); return Promise.resolve({ data:result,error:null }); } } as unknown as SupabaseClient;
  return {admin,calls};
}
function transport(responses: Array<unknown | Error | {errorCode:string}>) {
  const calls: Array<{url:string;body:Record<string,unknown>|null;method:string}> = [];
  const fetcher = (async (input: string|URL|Request, init?: RequestInit) => {
    calls.push({url:String(input),body:init?.body?JSON.parse(String(init.body)):null,method:String(init?.method)});
    const next = responses.shift(); if(next instanceof Error) throw next;
    if(next && typeof next === "object" && "errorCode" in next) return new Response(JSON.stringify({code:next.errorCode}),{status:404});
    const raw = next === null ? "" : JSON.stringify(next);
    return new Response(raw || null,{status:next === null ? 204 : 200,headers:await signed(raw)});
  }) as typeof fetch;
  return {calls,client:new WechatPayClient(config,fetcher)};
}
Deno.test("first order queries before native create using server quote and frozen number",async()=>{
  const b=bundle(), db=database(), http=transport([{errorCode:"ORDER_NOT_EXIST"},{code_url:"weixin://wxpay/fixture"}]);
  await reconcileWechatOrder(db.admin,b,http.client);
  assertEquals(http.calls.map(c=>c.method),["GET","POST"]);
  assertEquals(http.calls[1].body?.amount,{total:500,currency:"CNY"});
  assertEquals(http.calls[1].body?.out_trade_no,"original-order");
  assertEquals(http.calls[1].body,b.payment.native_request);
  assertEquals(db.calls[0].name,"update_wechatpay_checkout");
});
Deno.test("unknown Native outcome retains number; next attempt queries and issues no second paid order",async()=>{
  const b=bundle(), db=database(), http=transport([{errorCode:"ORDER_NOT_EXIST"},new TypeError("offline"),transaction(b,"SUCCESS")]);
  await assertRejects(()=>reconcileWechatOrder(db.admin,b,http.client));
  await reconcileWechatOrder(db.admin,b,http.client);
  assertEquals(http.calls.filter(c=>c.method==="POST").length,1);
  assertEquals(db.calls[0].name,"apply_wechatpay_transaction");
});
Deno.test("unpaid query missing optional amount uses local quote but a supplied mismatch is preserved",async()=>{
  const b=bundle(); b.payment.code_url="weixin://wxpay/existing";
  const db=database(), state=transaction(b,"NOTPAY");
  const {amount:_amount,...withoutAmount}=state;
  await reconcileWechatOrder(db.admin,b,transport([withoutAmount]).client);
  assertEquals((db.calls[0].args.p_transaction as Record<string,unknown>).amount,{total:500,currency:"CNY"});
  await reconcileWechatOrder(db.admin,b,transport([{...state,amount:{total:1,currency:"USD"}}]).client);
  assertEquals((db.calls[1].args.p_transaction as Record<string,unknown>).amount,{total:1,currency:"USD"});
});
Deno.test("expire queries before close; signed 204 is the only local close trigger for existing order",async()=>{
  const b=bundle(); b.payment.time_expire=new Date(Date.now()-1000).toISOString();
  const db=database(),http=transport([transaction(b,"NOTPAY"),null]);
  await reconcileWechatOrder(db.admin,b,http.client);
  assertEquals(http.calls[1].url.endsWith("/close"),true);
  assertEquals((db.calls[1].args.p_transaction as Record<string,unknown>).trade_state,"CLOSED");
});
Deno.test("payment wins expiry: success does not invoke close or create",async()=>{
  const b=bundle(); b.payment.time_expire=new Date(Date.now()-1000).toISOString();
  const db=database(),http=transport([transaction(b,"SUCCESS")]); await reconcileWechatOrder(db.admin,b,http.client);
  assertEquals(http.calls.length,1);assertEquals(db.calls.length,1);
});
Deno.test("refund queries original number before POST; processing is not refunded",async()=>{
  const b=bundle();b.order.status="paid";b.payment.transaction_id="tx1";b.refund=refund();
  const db=database(),http=transport([{errorCode:"RESOURCE_NOT_EXISTS"},{status:"PROCESSING",out_refund_no:"original-refund",out_trade_no:"original-order",transaction_id:"tx1"}]);
  await reconcileWechatRefund(db.admin,b,http.client);
  assertEquals(http.calls[1].body?.out_refund_no,"original-refund");assertEquals(http.calls[1].body?.amount,{refund:500,total:500,currency:"CNY"});
  assertEquals(http.calls[1].body,b.refund.request_payload);
  assertEquals((db.calls[0].args.p_refund as Record<string,unknown>).status,"PROCESSING");
});
Deno.test("refund uncertain result never releases financial reservation",async()=>{
  const b=bundle();b.refund=refund();
  const db=database(),http=transport([{errorCode:"RESOURCE_NOT_EXISTS"},new TypeError("offline")]);
  await assertRejects(()=>reconcileWechatRefund(db.admin,b,http.client));assertEquals(db.calls.length,0);
});
Deno.test("signed response for another order or refund never reaches its ledger",async()=>{
  const b=bundle(),db=database();
  await assertRejects(()=>reconcileWechatOrder(db.admin,b,transport([{...transaction(b,"SUCCESS"),out_trade_no:"other-order"}]).client));
  b.refund=refund();
  await assertRejects(()=>reconcileWechatRefund(db.admin,b,transport([{out_refund_no:"other-refund",out_trade_no:"original-order",transaction_id:null,status:"SUCCESS"}]).client));
  assertEquals(db.calls.length,0);
});
Deno.test("refund persistence rejection remains a reconciliation failure",async()=>{
  const b=bundle();b.payment.transaction_id="tx1";b.refund=refund();
  const db=database({accepted:false,status:"failed"});
  await assertRejects(()=>reconcileWechatRefund(db.admin,b,transport([{out_refund_no:"original-refund",out_trade_no:"original-order",transaction_id:"tx1",status:"SUCCESS"}]).client));
});
Deno.test("later signed observations use distinct IDs so official timestamps can be added",async()=>{
  const b=bundle(),db=database(); b.payment.code_url="weixin://wxpay/existing";
  await reconcileWechatOrder(db.admin,b,transport([transaction(b,"NOTPAY")]).client);
  await reconcileWechatOrder(db.admin,b,transport([transaction(b,"NOTPAY")]).client);
  assert(db.calls[0].args.p_event_id!==db.calls[1].args.p_event_id);
});
Deno.test("unknown refund query after a minute retries the same refund number only",async()=>{
  const b=bundle();b.payment.transaction_id="tx1";b.refund={...refund(),created_at:new Date(Date.now()-120000).toISOString()};
  const db=database(),http=transport([new TypeError("offline"),new TypeError("offline"),{status:"PROCESSING",out_refund_no:"original-refund",out_trade_no:"original-order",transaction_id:"tx1"}]);
  await reconcileWechatRefund(db.admin,b,http.client);
  assertEquals(http.calls.map(c=>c.method),["GET","GET","POST"]);assertEquals(http.calls[2].body?.out_refund_no,"original-refund");
});
async function notification(data:Record<string,unknown>, eventType="TRANSACTION.SUCCESS", originalType="transaction") {
  const key=await crypto.subtle.importKey("raw",encoder.encode(config.apiV3Key),"AES-GCM",false,["encrypt"]);
  const resource={algorithm:"AEAD_AES_256_GCM",nonce:"fixture12345",associated_data:"transaction",original_type:originalType,
    ciphertext:b64(await crypto.subtle.encrypt({name:"AES-GCM",iv:encoder.encode("fixture12345"),additionalData:encoder.encode("transaction"),tagLength:128},key,encoder.encode(JSON.stringify(data))))};
  const raw=JSON.stringify({id:"notice-1",event_type:eventType,resource_type:"encrypt-resource",resource});
  return new Request(config.notifyUrl,{method:"POST",headers:await signed(raw),body:raw});
}
Deno.test("valid payment notice persists synchronously before 204; durable failed event remains acknowledged",async()=>{
  const db=database({accepted:false,status:"failed"});
  const response=await handleWechatNotification(await notification(transaction(bundle(),"SUCCESS")),db.admin,new WechatPayClient(config));
  assertEquals(response.status,204); assertEquals(db.calls.length,1); assertEquals(db.calls[0].args.p_event_id,"notice-1");
});
Deno.test("persistence failure returns failure for WeChat retry",async()=>{
  const admin={rpc:()=>Promise.resolve({data:null,error:{code:"db-unavailable"}})} as unknown as SupabaseClient;
  const response=await handleWechatNotification(await notification(transaction(bundle(),"SUCCESS")),admin,new WechatPayClient(config));
  assert(response.status>=500);
});
Deno.test("wrong event, non-native or tampered notice never reaches ledger",async()=>{
  for(const data of [{...transaction(bundle(),"SUCCESS"),trade_type:"JSAPI"},transaction(bundle(),"NOTPAY"),{...transaction(bundle(),"SUCCESS"),mchid:"other-merchant"}]) {
    const db=database(),response=await handleWechatNotification(await notification(data),db.admin,new WechatPayClient(config));
    assertEquals(response.status,400);assertEquals(db.calls.length,0);
  }
  const req=await notification(transaction(bundle(),"SUCCESS"));req.headers.set("wechatpay-signature","WECHATPAY/SIGNTEST/fake");
  const db=database(),response=await handleWechatNotification(req,db.admin,new WechatPayClient(config));assertEquals(response.status,401);assertEquals(db.calls.length,0);
});
Deno.test("official refund notification without currency is durably handed to the refund ledger",async()=>{
  const db=database(),data={mchid:config.mchid,out_trade_no:"original-order",transaction_id:"tx1",out_refund_no:"original-refund",refund_id:"refund1",refund_status:"SUCCESS",amount:{total:500,refund:500,payer_total:500,payer_refund:500}};
  const response=await handleWechatNotification(await notification(data,"REFUND.SUCCESS","refund"),db.admin,new WechatPayClient(config));
  assertEquals(response.status,204);assertEquals(db.calls[0].name,"apply_wechatpay_refund");assertEquals(db.calls[0].args.p_mchid,config.mchid);
  assertEquals(db.calls[0].args.p_refund,data);
});
Deno.test("refund event status or merchant mismatch cannot reach refund ledger",async()=>{
  for(const data of [{mchid:config.mchid,refund_status:"CLOSED"},{mchid:"other-merchant",refund_status:"SUCCESS"}]) {
    const db=database(),response=await handleWechatNotification(await notification(data,"REFUND.SUCCESS","refund"),db.admin,new WechatPayClient(config));
    assertEquals(response.status,400);assertEquals(db.calls.length,0);
  }
});
Deno.test("public DTO reveals only own display fields and hides expired QR",()=>{
  const b=bundle();b.payment.code_url="weixin://wxpay/foo";b.payment.time_expire=new Date(Date.now()-1000).toISOString();
  const result=publicPayment(b);assertEquals(result.code_url,null);assertEquals(result.status,"pending");assertEquals("mchid" in result,false);assertEquals("user_id" in result,false);
  assertEquals(publicPayment(b,"processing").status,"refunding");
});
Deno.test("checkout lookup binds order to authenticated owner before recovery",async()=>{
  const filters: Array<[string,unknown]> = [];
  const query={select:()=>query,eq:(column:string,value:unknown)=>{filters.push([column,value]);return query;},maybeSingle:()=>Promise.resolve({data:null,error:null})};
  const admin={from:(name:string)=>{assertEquals(name,"orders");return query;}} as unknown as SupabaseClient;
  const orderId=bundle().order.id;
  const response=await handleCheckoutStatus(new Request("https://example.invalid/checkout-status",{method:"POST",body:JSON.stringify({order_id:orderId})}),
    async()=>({user:{id:"current-owner"},admin} as AuthContext));
  assertEquals(response.status,404);
  assertEquals(filters,[["provider","wechatpay"],["user_id","current-owner"],["id",orderId]]);
  assertEquals((await response.text()).includes(orderId),false);
});
