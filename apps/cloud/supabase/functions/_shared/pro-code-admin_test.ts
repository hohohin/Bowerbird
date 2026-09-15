import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import type { AuthContext } from "./auth.ts";
import { ApiError } from "./errors.ts";
import { assertCodeAdmin, codeEncryptionKey, encryptCode, decryptCode, handleCodeAdmin, issueParameters } from "./pro-code-admin.ts";

Deno.test("admin claim must be server-owned boolean true", () => {
  assertCodeAdmin({ app_metadata: { bowerbird_admin: true } });
  for (const claim of [undefined, {}, { bowerbird_admin: "true" }, { bowerbird_test: true }]) {
    assertThrows(() => assertCodeAdmin({ app_metadata: claim }), ApiError);
  }
});
Deno.test("code encryption authenticates ciphertext, key and code ID", async () => {
  const key = await codeEncryptionKey(btoa("a".repeat(32)));
  const other = await codeEncryptionKey(btoa("b".repeat(32)));
  const code = "01234567-89ABCDEF-01234567-89ABCDEF";
  const encrypted = await encryptCode(key, "id-one", code);
  assertEquals(encrypted.includes(code), false);
  assertEquals(await decryptCode(key, "id-one", encrypted), code);
  await assertRejects(() => decryptCode(other, "id-one", encrypted), ApiError);
  await assertRejects(() => decryptCode(key, "id-two", encrypted), ApiError);
  await assertRejects(() => decryptCode(key, "id-one", encrypted.slice(0, -5) + "aaaaa"), ApiError);
  await assertRejects(() => codeEncryptionKey("invalid"), ApiError);
});
Deno.test("issue validation bounds count, label and expiry", () => {
  const body = { batch_id: crypto.randomUUID(), label: "测试", count: 20, expires_at: "2027-01-01T00:00:00Z" };
  const now = Date.parse("2026-09-14T00:00:00Z");
  assertEquals(issueParameters(body, now).count, 20);
  for (const override of [{ count: 0 }, { count: 1001 }, { count: 1.5 }, { count: "20" }, { label: " " }, { expires_at: "2020-01-01" }, { expires_at: "2030-01-01" }, { batch_id: "bad" }]) {
    assertThrows(() => issueParameters({ ...body, ...override }, now), ApiError);
  }
});
Deno.test("admin HTTP rejects callers before RPC and overrides supplied actor", async () => {
  const calls: unknown[] = [];
  const actor = crypto.randomUUID();
  const authenticate = (isAdmin: boolean) => async () => ({ user: { id: actor, app_metadata: { bowerbird_admin: isAdmin } },
    admin: { rpc: (name: string, args: unknown) => { calls.push({ name, args }); return Promise.resolve({ data: { rows: [] }, error: null }); } } }) as unknown as AuthContext;
  const request = (action: string) => new Request("https://example.test", { method: "POST", body: JSON.stringify({ action, p_actor: "forged", user_id: "forged" }) });
  for (const action of ["list", "issue", "reveal", "export", "disable"]) assertEquals((await handleCodeAdmin(request(action), authenticate(false))).status, 403);
  assertEquals(calls.length, 0);
  const result = await handleCodeAdmin(request("list"), authenticate(true));
  assertEquals(result.status, 200); assertEquals(result.headers.get("cache-control"), "no-store");
  assertEquals((calls[0] as { args: { p_actor: string } }).args.p_actor, actor);
  const denied = await handleCodeAdmin(request("list"), async () => { throw new ApiError("unauthorized", "请先登录"); });
  assertEquals(denied.status, 401);
});
