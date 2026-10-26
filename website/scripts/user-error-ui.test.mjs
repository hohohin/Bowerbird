import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { chromium } from "../../apps/html-renderer/node_modules/playwright/index.mjs";
import { startServer } from "../server.mjs";

const root = path.resolve(process.argv[2] || fileURLToPath(new URL("../", import.meta.url)));
const server = startServer({ root, host: "127.0.0.1", port: 1565 });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const raw = "SQLITE_BUSY: secret-path C:/private/library.db / WECHAT_APP_SECRET";
try {
  const context = await browser.newContext({ viewport: { width: 1512, height: 1040 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = []; page.on("pageerror", e => { errors.push(e.message); console.error("PAGE ERROR", e.message); });
  let configured = true, legacy = true;
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (legacy && url.pathname === "/app-v2.bundle.js") return route.fulfill({ contentType: "application/javascript", body: await readFile(path.join(root, "app.bundle.js"), "utf8") });
    if (url.pathname === "/api/image-config") return route.fulfill({ json: {
      configured, label: "图片创作", supabaseUrl: "https://fixture.supabase.co", supabasePublishableKey: "fixture",
      trialLimit: 3, trialDay: "2026-10-24",
    } });
    if (url.pathname === "/api/generate") return route.fulfill({ status: 500, json: { error: raw } });
    if (url.hostname === "fixture.supabase.co") {
      if (route.request().method() === "POST") return route.fulfill({ json: { access_token: "synthetic", refresh_token: "synthetic" } });
      return route.fulfill({ status: 503, json: { error: { message: raw } } });
    }
    if (url.hostname === "cdn.jsdelivr.net") return route.fulfill({ contentType: "application/javascript", body: `window.supabase = { createClient: () => ({ auth: {
      getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => {},
      signInWithOtp: async () => ({ error: { message: ${JSON.stringify(raw)}, code: 'over_email_send_rate_limit' } }),
      setSession: async () => ({ error: { message: ${JSON.stringify(raw)} } })
    } }) };` });
    if (url.hostname !== "127.0.0.1") return route.abort();
    return route.continue();
  });
  for (const entry of ["/index.html?bundle=legacy", "/index.html?bundle=current"]) {
    console.log("Checking", entry, legacy ? "legacy bundle" : "current bundle");
    await page.goto(`http://127.0.0.1:1565${entry}`);
    await page.locator("#account-state").getByText("登录后使用云端积分").waitFor();
    await page.locator("#account-state").evaluate(el => el.scrollIntoView({ block: "center" }));
    await page.locator("#account-state").click();
    await page.getByRole("button", { name: "微信扫码登录" }).click();
    await page.locator("#account-state").getByText("微信登录暂不可用，请稍后重新扫码。").waitFor();
    assert.ok(!(await page.locator("body").innerText()).includes(raw));
    await page.locator("#account-state").evaluate(el => el.scrollIntoView({ block: "center" }));
    await page.locator("#account-state").click();
    page.once("dialog", dialog => dialog.accept("synthetic@example.test"));
    await page.getByRole("button", { name: "邮箱魔法链接" }).click();
    await page.locator("#account-state").getByText("操作过于频繁，请稍后再试。").waitFor();
    await page.locator("#generate-image").click();
    await page.locator("#generation-result").getByText("暂未获得生成结果", { exact: false }).waitFor();
    assert.ok(!(await page.locator("body").innerText()).includes(raw));
    legacy = false;
  }
  configured = false;
  await page.goto("http://127.0.0.1:1565/index.html");
  await page.getByText("在线创作暂不可用，请稍后再试，或使用桌面应用继续创作。").waitFor();
  assert.doesNotMatch(await page.locator("body").innerText(), /\.env\.local|pnpm|API Key/);
  await page.goto(`http://127.0.0.1:1565/wechat-callback.html?error_description=${encodeURIComponent(raw)}`);
  await page.locator("#status").getByText("微信登录未完成，请回到发起页重新扫码。").waitFor();
  assert.ok(!(await page.locator("body").innerText()).includes(raw));
  assert.equal(await page.locator("#primary").getAttribute("href"), "/", "failed login must offer a valid website exit instead of resending rejected codes");
  assert.equal(await page.locator("#spinner").isVisible(), false, "failed login must stop loading");
  assert.equal(await page.locator("#secondary").isVisible(), true, "failed login must retain the website exit");
  await page.evaluate(() => sessionStorage.setItem("bowerbird.wechatLoginState", "web_fixture"));
  await page.goto("http://127.0.0.1:1565/wechat-callback.html?state=web_fixture&code=synthetic");
  await page.locator("#status").getByText("微信登录未完成，请回到官网重新扫码。").waitFor();
  assert.ok(!(await page.locator("body").innerText()).includes(raw));
  assert.ok(await page.evaluate(() => sessionStorage.getItem("bowerbird.wechatLoginState")), "failed session must not be reported as login success");
  assert.deepEqual(errors, []);
  console.log("PASS: website login, returned auth failures, generation errors, unconfigured service, OAuth query and callback diagnostics are hidden");
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
