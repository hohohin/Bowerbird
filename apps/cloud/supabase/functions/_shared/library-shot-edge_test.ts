import assert from "node:assert/strict";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { libraryShotAction, quoteLibraryShots } from "./library-shot-edge.ts";

Deno.test("quotes use the verified subject and private rates without opening the public gate", async () => {
  const before = new Map(["LIBRARY_SHOT_ENABLED", "BOWERBIRD_CLOUD_MOCK"].map(k => [k, Deno.env.get(k)]));
  const shots = [{ start_ms: 12, end_ms: 15012 }, { start_ms: 15012, end_ms: 30013 }];
  let calls = 0;
  const admin = {
    rpc(name: string, args: { p_user_id: string; p_public_enabled: boolean }) {
      assert.equal(name, "library_shot_price");
      assert.equal(args.p_public_enabled, false);
      calls++;
      return { maybeSingle: () => ({ data: args.p_user_id === "pilot" ? { pricing_version: 7, short_milli: 54, long_milli: 134 } : null }) };
    },
  } as unknown as SupabaseClient;
  try {
    Deno.env.delete("LIBRARY_SHOT_ENABLED");
    Deno.env.set("BOWERBIRD_CLOUD_MOCK", "true");
    assert.equal((await quoteLibraryShots(admin, "pilot", shots)).available, false);
    assert.equal(calls, 0);
    Deno.env.set("BOWERBIRD_CLOUD_MOCK", "false");
    const forged = await libraryShotAction(admin, "outsider", {
      action: "library-shot-quote", shots, user_id: "pilot", pilot_user_id: "pilot", public_enabled: true,
    }, {});
    assert.equal((await forged.json()).available, false);
    assert.deepEqual(await quoteLibraryShots(admin, "pilot", shots), {
      available: true, pricing_version: 7, total_milli: 188,
      lines: [{ ...shots[0], amount_milli: 54 }, { ...shots[1], amount_milli: 134 }],
    });
    await assert.rejects(quoteLibraryShots(admin, "pilot", [shots[0], shots[0]]));
    await assert.rejects(quoteLibraryShots(admin, "pilot", [{ start_ms: 0, end_ms: 60001 }]));
  } finally {
    for(const [name, value] of before) value == null ? Deno.env.delete(name) : Deno.env.set(name,value);
  }
});

Deno.test("prepare receives only the authenticated owner, server gates and real cost policy", async () => {
  const before = new Map(["LIBRARY_SHOT_ENABLED", "BOWERBIRD_CLOUD_MOCK"].map(k => [k, Deno.env.get(k)]));
  const inputs: Record<string, unknown>[] = [];
  const admin = { rpc(name: string, args: Record<string, unknown>) {
    assert.equal(name, "begin_library_shot");
    inputs.push(args);
    return { error: { details: "price_unavailable" } };
  } } as unknown as SupabaseClient;
  const digest = "a".repeat(64);
  const raw = { action: "library-shot-prepare", idempotency_key: "library-shot:attempt-from-fixture",
    source_sha256: digest, expected_milli: 54, pricing_version: 7, user_id:"pilot", pilot_only:true, p_enabled:true,
    video:{ mime:"video/mp4",bytes:128,sha256:digest,duration_ms:3000,start_ms:0,end_ms:3000,source_duration_ms:3000 } };
  try {
    Deno.env.delete("LIBRARY_SHOT_ENABLED");
    for (const mode of ["false", "true", "invalid"]) {
      Deno.env.set("BOWERBIRD_CLOUD_MOCK",mode);
      await assert.rejects(libraryShotAction(admin,"outsider",raw,{}));
      const args = inputs.at(-1)!;
      assert.equal(args.p_user_id,"outsider");
      assert.equal(args.p_enabled,false);
      assert.equal(Number(args.p_unit_cost_micros)>0,mode==="false");
    }
    assert.equal(inputs.length,3);
  } finally {
    for(const [name, value] of before) value == null ? Deno.env.delete(name) : Deno.env.set(name,value);
  }
});

Deno.test("get-by-key binds owner, returns structured shot and original charge", async () => {
  const id = "library-shot:test-original";
  const scopes: unknown[][] = [];
  const fields = { description: "蓝色球场", first_frame_prompt: "固定镜位", motion_prompt: "球员挥拍" };
  const table = {
    select() {
      return this;
    },
    eq(k: string, v: string) {
      scopes.push([k, v]);
      return this;
    },
    maybeSingle() {
      return {
        data: {
          id: "job",
          hold_id: "hold",
          status: "succeeded",
          expires_at: new Date(Date.now() + 60000).toISOString(),
          amount_milli: 54,
          pricing_version: 3,
          result_text: JSON.stringify(fields),
        },
      };
    },
  };
  const response = await libraryShotAction({ from: () => table } as unknown as SupabaseClient, "owner", {
    action: "get-by-key",
    idempotency_key: id,
  }, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.result, fields);
  assert.equal(body.charge.actual_milli, 54);
  assert.deepEqual(scopes, [["user_id", "owner"], ["idempotency_key", id]]);
});
