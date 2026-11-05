import { readFile } from "node:fs/promises";
import { createPrivateKey, createPublicKey, randomBytes, sign, verify, X509Certificate } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

export const defaultConfigPath = fileURLToPath(new URL("../.env.wechatpay.local", import.meta.url));

// Only fixed field names and fixed diagnostics leave this module. Values and
// OpenSSL/parser errors can contain credentials and must never be printed.
export async function checkWechatPayConfig(configPath = defaultConfigPath, now = new Date()) {
  const checks = [];
  const add = (field, ok, message) => checks.push({ field, status: ok ? "通过" : "待补齐", message });
  let config;
  try { config = parseEnv(await readFile(configPath, "utf8")); }
  catch {
    add("配置文件", false, "无法读取私有配置文件，请先填写 .env.wechatpay.local。");
    return { ok: false, checks };
  }
  const base = dirname(resolve(configPath));
  const value = key => config[key]?.trim() ?? "";
  const load = async key => {
    if (!value(key)) return null;
    try { return await readFile(resolve(base, value(key)), "utf8"); } catch { return null; }
  };
  const mchid = value("WECHAT_PAY_MCH_ID"), appid = value("WECHAT_PAY_APP_ID");
  add("WECHAT_PAY_MCH_ID", /^\d{6,20}$/.test(mchid), "填写商户平台的收款商户号。");
  add("WECHAT_PAY_APP_ID", /^wx[a-zA-Z0-9]{16}$/.test(appid), "填写已绑定此商户号的支付 AppID。");
  add("WECHAT_PAY_API_V3_KEY", /^[a-zA-Z0-9]{32}$/.test(value("WECHAT_PAY_API_V3_KEY")), "必须是商户平台已设置的 32 位 APIv3 字母数字密钥。");
  add("WECHAT_PAY_PUBLIC_KEY_ID", /^PUB_KEY_ID_\d+$/.test(value("WECHAT_PAY_PUBLIC_KEY_ID")), "填写下载微信支付公钥时显示的公钥 ID。");

  let certificate, privateKey, publicKey;
  try { certificate = new X509Certificate(await load("WECHAT_PAY_MERCHANT_CERT_FILE")); } catch { /* safe field-level diagnostic below */ }
  try { privateKey = createPrivateKey(await load("WECHAT_PAY_PRIVATE_KEY_FILE")); } catch { /* no parser error output */ }
  try { publicKey = createPublicKey(await load("WECHAT_PAY_PUBLIC_KEY_FILE")); } catch { /* no parser error output */ }
  add("WECHAT_PAY_MERCHANT_CERT_FILE", !!certificate, "需要有效的 apiclient_cert.pem 商户证书文件。");
  const rsa2048 = key => key?.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails?.modulusLength === 2048;
  add("WECHAT_PAY_PRIVATE_KEY_FILE", rsa2048(privateKey), "需要 RSA 2048 位 apiclient_key.pem 商户私钥。");
  add("WECHAT_PAY_PUBLIC_KEY_FILE", rsa2048(publicKey), "需要 RSA 2048 位微信支付公钥 pub_key.pem。");
  let serial = "";
  if (certificate) {
    const normalizeSerial = serialValue => serialValue.replace(/:/g, "").toUpperCase().replace(/^0+/, "");
    serial = certificate.serialNumber.replace(/:/g, "").toUpperCase();
    add("商户证书有效期", Date.parse(certificate.validFrom) <= now.getTime() && now.getTime() < Date.parse(certificate.validTo), "证书必须处于有效期内。");
    add("商户证书归属", certificate.subject.split(/\n/).some(part => part.trim() === `CN=${mchid}`), "商户证书 CN 必须与填写的收款商户号一致。");
    const configuredSerial = value("WECHAT_PAY_MERCHANT_SERIAL_NO");
    add("WECHAT_PAY_MERCHANT_SERIAL_NO", !configuredSerial || (/^[a-fA-F0-9:]+$/.test(configuredSerial) && normalizeSerial(configuredSerial) === normalizeSerial(serial)), "可留空从证书读取；手填时必须与证书一致。");
    let matches = false;
    try {
      const challenge = randomBytes(32);
      matches = rsa2048(privateKey) && verify("RSA-SHA256", challenge, certificate.publicKey, sign("RSA-SHA256", challenge, privateKey));
    } catch { /* do not expose cryptographic inputs */ }
    add("商户证书与私钥匹配", matches, "证书与私钥必须来自同一次申请。");
  }
  const operationalFields = ["WECHAT_PAY_NATIVE_ENABLED", "WECHAT_PAY_APP_ID_BOUND", "WECHAT_PAY_PUBLIC_KEY_MODE_READY"];
  for (const key of operationalFields) {
    add(key, value(key) === "true", key === "WECHAT_PAY_PUBLIC_KEY_MODE_READY"
      ? "确认已使用纯公钥模式后填 true；灰度期不能开启本项目收款。"
      : "在商户平台确认已开通／已绑定后填 true；此项是人工确认，非在线验证。");
  }
  for (const key of ["WECHAT_PAY_NOTIFY_URL", "WECHAT_PAY_REFUND_NOTIFY_URL"]) {
    let valid = false;
    try {
      const url = new URL(value(key));
      const expectedPath = key === "WECHAT_PAY_NOTIFY_URL" ? "/api/pay/wechat/notify" : "/api/pay/wechat/refund-notify";
      valid = url.protocol === "https:" && url.hostname === "bowerbird.cn" && !url.port && !url.username && !url.password
        && url.pathname === expectedPath && !url.search && !url.hash;
    } catch { /* invalid URL is reported without its value */ }
    add(key, valid, "保留预填的 Bowerbird HTTPS 通知地址。");
  }
  const credentialsOk = checks.filter(check => !operationalFields.includes(check.field)).every(check => check.status === "通过");
  const report = { ok: checks.every(check => check.status === "通过"), credentials_ok: credentialsOk, checks };
  // Deliberately non-enumerable: JSON reports cannot accidentally include secrets.
  if (credentialsOk) Object.defineProperty(report, "environment", { enumerable: false, value: {
    WECHAT_PAY_MCH_ID: mchid, WECHAT_PAY_APP_ID: appid,
    WECHAT_PAY_MERCHANT_SERIAL_NO: serial,
    WECHAT_PAY_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    WECHAT_PAY_API_V3_KEY: value("WECHAT_PAY_API_V3_KEY"),
    WECHAT_PAY_PUBLIC_KEY_ID: value("WECHAT_PAY_PUBLIC_KEY_ID"),
    WECHAT_PAY_PUBLIC_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
    WECHAT_PAY_NOTIFY_URL: value("WECHAT_PAY_NOTIFY_URL"),
    WECHAT_PAY_REFUND_NOTIFY_URL: value("WECHAT_PAY_REFUND_NOTIFY_URL"),
  } });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await checkWechatPayConfig(process.argv[2]);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
