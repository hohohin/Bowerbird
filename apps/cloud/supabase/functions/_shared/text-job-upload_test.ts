import { settleSyncUnderstand } from "../understand-proxy/settlement.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { acceptTextUpload, cleanupTextJobs, readableTextResult } from "./text-job-upload.ts";
import { ApiError } from "./errors.ts";

Deno.test("legacy sync reservations survive ambiguous dispatch and lost confirmation; only definite rejection refunds", async () => {
  for (const mode of ["ok","before","rejected","timeout","confirmation-lost"]) {
    const calls: string[] = [];
    const admin = { rpc(name: string) {
      calls.push(name);
      if ((mode === "before" && name === "mark_hold_pending_settlement") ||
          (mode === "confirmation-lost" && name === "credit_confirm")) return { error: { message: "fixture" } };
      return { data: [{}], error: null };
    } } as unknown as SupabaseClient;
    const run = () => settleSyncUnderstand(admin, "fixture", async () => {
      calls.push("provider");
      if (mode === "rejected") throw new ApiError("upstream_failed", "fixture", false, 422);
      if (mode === "timeout") throw new ApiError("upstream_timeout", "fixture", true);
      return { actualCost: 1 };
    });
    if (mode === "ok") await run(); else await assertRejects(run);
    assertEquals(calls, ["mark_hold_pending_settlement", ...(mode === "before" ? [] : ["provider"]),
      ...(["ok","confirmation-lost"].includes(mode) ? ["credit_confirm"] :
        ["before","rejected"].includes(mode) ? ["credit_rollback"] : [])]);
  }
});

Deno.test("result retrieval stops at expiry even if the body has not been cleared", () => {
  const deadline = "2030-05-04T17:00:00+08:00";
  const row = { result_text: "fixture", deleted_at: null, content_expires_at: deadline };
  const now = Date.parse(deadline);
  assertEquals(readableTextResult(row, now - 1), "fixture");
  assertEquals(readableTextResult(row, now), null);
  assertEquals(readableTextResult(row, now + 1), null);
  assertEquals(readableTextResult({ ...row, deleted_at: deadline }, now - 1), null);
  assertEquals(readableTextResult({ ...row, content_expires_at: "" }, now - 1), null);
});

const input = { userId: "fixture", key: "original", payload: "input bytes", manifestHash: "a".repeat(64),
  service: "caption", operation: "autoname", cards: null };

Deno.test("replay resumes interrupted upload, lost storage response and lost enqueue response on the same job", async () => {
  let status = "uploading", stored = "", uploads = 0;
  const row = () => ({ id: "fixture", status, input_manifest_hash: input.manifestHash, request_object_key: "fixture/request.json" });
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      if (name === "begin_text_upload") assertEquals(args.p_key, input.key);
      else {
        assertEquals(name, "transition_text_upload"); assertEquals(args.p_id, "fixture"); assertEquals(args.p_hash, input.manifestHash);
        status = "queued";
        return { error: new Error("lost response after commit") };
      }
      return { data: row() };
    },
    storage: { from: () => ({
      upload(_key: string, body: string, options: { upsert: boolean }) {
        assertEquals(options.upsert, false); uploads++;
        if (uploads === 2) stored = body;
        return { error: new Error("lost storage response") };
      },
      list: () => ({ data: stored ? [{ name: "request.json" }] : [] }),
    }) },
  } as unknown as SupabaseClient;
  const create = () => acceptTextUpload(admin, "understand_jobs", input);
  await assertRejects(create, Error, "输入上传未确认");
  await assertRejects(create, Error, "读取上传进度失败");
  assertEquals((await create()).status,"queued");
  assertEquals(uploads,2);
});

Deno.test("partial storage deletion and lost DB response converge without erasing inputs still waiting to be submitted", async () => {
  const ids = ["expired-success", "expired-failure"];
  const objects = new Set(ids);
  const cleared = new Set<string>();
  let pass = 0;
  const admin = {
    rpc: () => ({ data: 0 }),
    from: () => ({
      select() { return this; }, lt() { return this; }, is() { return this; }, order() { return this; },
      or(filter: string) {
        assertEquals(filter,"finished_at.not.is.null,upstream_submitted_at.not.is.null"); return this;
      },
      limit: () => ({ data: ids.filter(id=>!cleared.has(id)).map(id => ({ id, request_object_key: id + "/request.json" })) }),
      update(values: { deleted_at: string; result_text: null }) {
        assertEquals(values.result_text,null); const selected: string[] = [];
        return {
          in(_column: string, ids: string[]) { selected.push(...ids); return this; }, or() { return this; },
          is() {
            if (pass === 2) return { error: new Error("DB unavailable") };
            selected.forEach(id => cleared.add(id)); return {};
          },
        };
      },
    }),
    storage: { from: () => ({
      remove() {
        pass++; objects.delete(ids[0]);
        if (pass >= 2) objects.delete(ids[1]);
        return { data: [] }; // The API omits already absent files.
      },
      list: (folder: string) => ({ data: objects.has(folder) ? [{name:"request.json"}] : [] }),
    }) },
  } as unknown as SupabaseClient;
  const cleanup = () => cleanupTextJobs(admin, "understand_jobs");
  await assertRejects(cleanup, Error, "部分输入对象");
  assertEquals([...cleared],[ids[0]]);
  await assertRejects(cleanup, Error, "过期结果标记失败");
  await cleanup();
  assertEquals([...cleared],ids);
});
