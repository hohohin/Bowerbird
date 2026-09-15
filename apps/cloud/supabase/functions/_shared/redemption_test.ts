import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { ApiError } from "./errors.ts";
import { assertRedemptionResult, normalizeRedemptionCode, readRedemptionBody, redemptionCodeHash } from "./redemption.ts";

Deno.test("redemption accepts pasted separators and case, rejects invalid input", async () => {
  const code = "0123456789ABCDEF0123456789ABCDEF";
  assertEquals(normalizeRedemptionCode(" 01234567-89abcdef-01234567-89abcdef\n"), code);
  assertEquals(await redemptionCodeHash(code), await redemptionCodeHash(code.toLowerCase()));
  for (const invalid of [null, {}, "", "z".repeat(32), "a".repeat(129), 123]) {
    assertThrows(() => normalizeRedemptionCode(invalid), ApiError);
  }
});

Deno.test("redemption body limits actual streamed bytes without Content-Length", async () => {
  const req = (body: string) => new Request("https://example.test", { method: "POST", body });
  assertEquals(await readRedemptionBody(req('{"code":"x"}')), { code: "x" });
  for (const body of ["{", "null", "[]", "x".repeat(1025)]) {
    await assertRejects(() => readRedemptionBody(req(body)), ApiError);
  }
});

Deno.test("redemption business failures map to safe user messages", () => {
  assertRedemptionResult({ status: "redeemed" });
  for (const status of ["invalid_code", "studio_active", "permanent_pro", "unauthorized", "rate_limited", "unknown"]) {
    const error = assertThrows(() => assertRedemptionResult({ status }), ApiError);
    assertEquals(error.status, status === "rate_limited" ? 429 : status === "unauthorized" ? 401 : status === "unknown" ? 500 : 400);
  }
});
