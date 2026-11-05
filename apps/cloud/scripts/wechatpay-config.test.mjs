import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { checkWechatPayConfig } from "./wechatpay-config.mjs";

test("private config preflight checks key/certificate ownership without exposing secrets", async t => {
  const dir = await mkdtemp(join(tmpdir(), "bowerbird-wechat-config-"));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    await rm(dir, { recursive: true, force: true });
  });
  const openssl = process.env.OPENSSL_EXE || (process.platform === "win32" ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl");
  execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=1900000001"], { stdio: "ignore" });
  const publicKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" });
  await writeFile(join(dir, "public.pem"), publicKey);
  const config = [
    "WECHAT_PAY_MCH_ID=1900000001", "WECHAT_PAY_APP_ID=wx0123456789abcdef",
    "WECHAT_PAY_API_V3_KEY=0123456789abcdefghijklmnopqrstuv", "WECHAT_PAY_PUBLIC_KEY_ID=PUB_KEY_ID_123456",
    "WECHAT_PAY_MERCHANT_CERT_FILE=cert.pem", "WECHAT_PAY_PRIVATE_KEY_FILE=key.pem", "WECHAT_PAY_PUBLIC_KEY_FILE=public.pem",
    "WECHAT_PAY_NATIVE_ENABLED=true", "WECHAT_PAY_APP_ID_BOUND=true", "WECHAT_PAY_PUBLIC_KEY_MODE_READY=true",
    "WECHAT_PAY_NOTIFY_URL=https://bowerbird.cn/api/pay/wechat/notify",
    "WECHAT_PAY_REFUND_NOTIFY_URL=https://bowerbird.cn/api/pay/wechat/refund-notify",
  ].join("\n");
  const path = join(dir, "config.local");
  await writeFile(path, config);
  const valid = await checkWechatPayConfig(path);
  assert.equal(valid.ok, true, JSON.stringify(valid.checks));
  assert.ok(valid.environment.WECHAT_PAY_PRIVATE_KEY.startsWith("-----BEGIN PRIVATE KEY-----"));
  const serialized = JSON.stringify(valid);
  for (const secret of ["1900000001", "wx0123456789abcdef", "0123456789abcdefghijklmnopqrstuv", "BEGIN PRIVATE KEY", "PUB_KEY_ID_123456"]) assert.ok(!serialized.includes(secret));
  for (const changed of [
    config.replace("1900000001", "1900000002"),
    config + "\nWECHAT_PAY_MERCHANT_SERIAL_NO=DEADBEEF",
    config.replace("API_V3_KEY=0123456789abcdefghijklmnopqrstuv", "API_V3_KEY=too-short"),
    config.replace("https://bowerbird.cn/api/pay/wechat/notify", "https://evil.invalid/api/pay/wechat/notify"),
  ]) {
    await writeFile(path, changed);
    const invalid = await checkWechatPayConfig(path);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.environment, undefined);
  }
  for (const field of ["NATIVE_ENABLED", "APP_ID_BOUND", "PUBLIC_KEY_MODE_READY"]) {
    await writeFile(path, config.replace(`${field}=true`, `${field}=false`));
    const pending = await checkWechatPayConfig(path);
    assert.equal(pending.ok, false);
    assert.equal(pending.credentials_ok, true);
    assert.ok(pending.environment, "non-financial echo can test credentials before sales readiness");
  }
  await writeFile(path, config);
  assert.equal((await checkWechatPayConfig(path, new Date("2099-01-01"))).ok, false);
  await writeFile(join(dir, "key.pem"), "invalid-key-do-not-echo");
  const invalidKey = await checkWechatPayConfig(path);
  assert.equal(invalidKey.ok, false);
  assert.ok(!JSON.stringify(invalidKey).includes("invalid-key-do-not-echo"));
  await writeFile(join(dir, "key.pem"), generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }));
  assert.equal((await checkWechatPayConfig(path)).checks.find(check => check.field === "商户证书与私钥匹配").status, "待补齐");
  assert.ok((await readFile(path, "utf8")).includes("MCH_ID"));
});

test("missing configuration produces only a fixed diagnostic", async () => {
  const report = await checkWechatPayConfig(join(tmpdir(), "does-not-exist-wechat-config"));
  assert.equal(report.ok, false);
  assert.ok(!JSON.stringify(report).includes(tmpdir()));
});
