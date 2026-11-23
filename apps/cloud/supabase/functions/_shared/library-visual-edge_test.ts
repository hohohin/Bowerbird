import assert from "node:assert/strict";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { commitLibraryVisual, libraryVisualCapabilities } from "./library-visual-edge.ts";

const jobId = "00000000-0000-0000-0000-000000000001";
const owner = "00000000-0000-0000-0000-000000000002";
const payload = new Uint8Array([1, 2, 3]);
const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", payload)), b => b.toString(16).padStart(2, "0")).join("");

function fixture(bytes: Uint8Array<ArrayBuffer>) {
  const actions: string[] = [];
  const parent = { credits: 1, hold_id: jobId, pricing_version: 20261123, expires_at: new Date(Date.now() + 60_000).toISOString(), finished_status: null };
  const segment = { id: jobId, status: "uploading",
    video: { mime: "video/mp4", bytes: 3, sha256: digest, start_ms: 0, end_ms: 1000, duration_ms: 1000, source_duration_ms: 1000 } };
  const admin = {
    from(table: string) {
      assert.equal(table, "library_visual_segments");
      const filters = new Map<string, string>();
      return {
        select() { return this; },
        eq(field: string, value: string) { filters.set(field, value); return this; },
        maybeSingle() {
          return { data: filters.get("id") === jobId && filters.get("user_id") === owner ? { ...segment, parent } : null };
        },
      };
    },
    storage: {
      from(bucket: string) {
        assert.equal(bucket, "generation-temp");
        return {
          list(folder: string, options: { search: string }) {
            assert.equal(folder, `understand/${jobId}/inputs`);
            assert.equal(options.search, "visual-input.mp4");
            return { data: [{ name: options.search, metadata: { size: 3, mimetype: "video/mp4" } }] };
          },
          download(key: string) {
            assert.equal(key, `understand/${jobId}/inputs/visual-input.mp4`);
            return { data: new Blob([bytes]) };
          },
        };
      },
    },
    rpc(name: string, args: { p_action: string; p_user_id: string; p_segment_id: string }) {
      assert.equal(name, "control_library_visual_segment");
      assert.equal(args.p_user_id, owner);
      assert.equal(args.p_segment_id, jobId);
      actions.push(args.p_action);
      return { data: {
        segment: { ...segment, status: args.p_action === "commit" ? "queued" : "failed" },
        parent: { ...parent, finished_status: args.p_action === "commit" ? null : "failed" },
      } };
    },
  } as unknown as SupabaseClient;
  return { admin, actions };
}

Deno.test("visual capabilities are closed without consulting pricing when the env gate is off", async () => {
  const previous = Deno.env.get("LIBRARY_VISUAL_ENABLED");
  Deno.env.delete("LIBRARY_VISUAL_ENABLED");
  try {
    assert.deepEqual(await libraryVisualCapabilities({} as SupabaseClient), {
      available: false, credits_per_hour: null, pricing_version: null, max_segment_duration_ms: 7200000,
    });
  } finally {
    if (previous !== undefined) Deno.env.set("LIBRARY_VISUAL_ENABLED", previous);
  }
});

Deno.test("only the owned matching SHA-256 is admitted to the visual queue", async () => {
  const valid = fixture(payload);
  await assert.rejects(commitLibraryVisual(valid.admin, jobId, jobId, {}), /未找到原画面分析任务/);
  assert.deepEqual(valid.actions, []);
  const accepted = await commitLibraryVisual(valid.admin, owner, jobId, {});
  assert.equal((await accepted.json()).status, "queued");
  assert.deepEqual(valid.actions, ["commit"]);

  const wrong = fixture(new Uint8Array([1, 2, 4]));
  const rejected = await commitLibraryVisual(wrong.admin, owner, jobId, {});
  const result = await rejected.json();
  assert.equal(result.status, "failed");
  assert.equal(result.charge.refunded, true);
  assert.deepEqual(wrong.actions, ["reject-upload"]);
});
