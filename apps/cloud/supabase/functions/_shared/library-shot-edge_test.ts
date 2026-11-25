import assert from "node:assert/strict";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { libraryShotAction, quoteLibraryShots } from "./library-shot-edge.ts";

Deno.test("shot quote checks the gate, cut ranges, duplicate selection and exact milli tiers", async () => {
  const previous = Deno.env.get("LIBRARY_SHOT_ENABLED");
  const previousMock = Deno.env.get("BOWERBIRD_CLOUD_MOCK");
  const table = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    maybeSingle: () => ({
      data: { active: true, pricing_version: 7, parameters: { pricing_ready: true, short_milli: 54, long_milli: 134 } },
    }),
  };
  const admin = { from: () => table } as unknown as SupabaseClient;
  const shots = [{ start_ms: 12, end_ms: 15012 }, { start_ms: 15012, end_ms: 30013 }];
  try {
    Deno.env.delete("LIBRARY_SHOT_ENABLED");
    assert.equal((await quoteLibraryShots(admin, shots)).available, false);
    Deno.env.set("LIBRARY_SHOT_ENABLED", "true");
    Deno.env.set("BOWERBIRD_CLOUD_MOCK", "true");
    assert.equal((await quoteLibraryShots(admin, shots)).available, false);
    Deno.env.set("BOWERBIRD_CLOUD_MOCK", "false");
    assert.deepEqual(await quoteLibraryShots(admin, shots), {
      available: true,
      pricing_version: 7,
      total_milli: 188,
      lines: [{ ...shots[0], amount_milli: 54 }, { ...shots[1], amount_milli: 134 }],
    });
    await assert.rejects(quoteLibraryShots(admin, [shots[0], shots[0]]));
    await assert.rejects(quoteLibraryShots(admin, [{ start_ms: 0, end_ms: 60001 }]));
  } finally {
    if (previous == null) Deno.env.delete("LIBRARY_SHOT_ENABLED");
    else Deno.env.set("LIBRARY_SHOT_ENABLED", previous);
    if (previousMock == null) Deno.env.delete("BOWERBIRD_CLOUD_MOCK");
    else Deno.env.set("BOWERBIRD_CLOUD_MOCK", previousMock);
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
