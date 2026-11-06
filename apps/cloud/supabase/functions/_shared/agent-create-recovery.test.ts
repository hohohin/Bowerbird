import { recoverAgentCreate } from "./agent-create-recovery.ts";
import type { AuthContext } from "./auth.ts";
import { ApiError } from "./errors.ts";

const hash = "a".repeat(64);
const body = { idempotencyKey: "original-key", inputManifestHash: hash, skillId: "bowerbird-unified-agent", inputCount: 1, imageProvider: "cloud", agentRuntime: "dsh" };
function fixture(status = "uploading") {
  const signed: string[] = [], reads: string[] = [];
  const rows: Record<string, Record<string, unknown>[]> = {
    billing_accounts: [{ id: "billing", auth_user_id: "owner" }],
    credit_holds: [{ id: "hold", user_id: "billing", idempotency_key: "original-key" }],
    agent_runs: [{ id: "run", conversation_id: "conversation", user_id: "billing", hold_id: "hold", status,
      skill_id: body.skillId, input_count: 1, input_manifest_hash: hash, request_object_key: "runs/run/inputs/request.json",
      image_provider: "cloud", agent_runtime: "dsh", visual_profile_id: null, visual_profile_version: null, visual_profile_hash: null }],
  };
  const admin = {
    from(table: string) {
      reads.push(table);
      const filters: [string, unknown][] = [];
      const query = { select: (_: string) => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        maybeSingle: () => Promise.resolve({ data: rows[table].find(row => filters.every(([k, v]) => row[k] === v)) ?? null, error: null }) };
      return query;
    },
    storage: { from: (_: string) => ({ createSignedUploadUrl: (key: string) => { signed.push(key); return Promise.resolve({ data: { signedUrl: "signed:" + key }, error: null }); } }) },
  } as unknown as AuthContext["admin"];
  return { admin, rows, reads, signed };
}
function check(value: unknown, message: string) { if (!value) throw new Error(message); }
async function rejected(fn: () => Promise<unknown>, status: number) {
  try { await fn(); } catch (error) { check(error instanceof ApiError && error.status === status, "wrong error"); return; }
  throw new Error("expected rejection");
}
Deno.test("lost create response recovers the one original run without any write/hold/enqueue API", async () => {
  const f = fixture();
  for (let n = 0; n < 2; n++) {
    const result = await recoverAgentCreate(f.admin, "owner", body);
    check(result.runId === "run" && result.holdId === "hold" && result.inputUploads.length === 1, "original identity lost");
  }
  check(f.signed.length === 4, "only upload signatures are renewed");
});
Deno.test("already queued and terminal runs never receive upload addresses", async () => {
  for (const status of ["queued", "running", "succeeded", "failed", "cancelled"]) {
    const f = fixture(status), result = await recoverAgentCreate(f.admin, "owner", body);
    check(result.status === status && result.uploadUrl === null && result.inputUploads.length === 0 && f.signed.length === 0, "must resume polling only");
  }
});
Deno.test("missing, cross-account and mismatched requests cannot create or expose another run", async () => {
  const f = fixture();
  await rejected(() => recoverAgentCreate(f.admin, "owner", { ...body, idempotencyKey: "missing-key" }), 404);
  await rejected(() => recoverAgentCreate(f.admin, "other-owner", body), 500);
  await rejected(() => recoverAgentCreate(f.admin, "owner", { ...body, inputManifestHash: "b".repeat(64) }), 409);
  await rejected(() => recoverAgentCreate(f.admin, "owner", { ...body, inputCount: 2 }), 409);
  check(f.signed.length === 0, "invalid lookups must not sign files");
  f.rows.agent_runs = [];
  await rejected(() => recoverAgentCreate(f.admin, "owner", body), 404);
});
