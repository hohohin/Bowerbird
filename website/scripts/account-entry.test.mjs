import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "../../apps/html-renderer/node_modules/playwright/index.mjs";
import { startServer } from "../server.mjs";

const server = startServer({ root: fileURLToPath(new URL("../dist", import.meta.url)), port: 0, host: "127.0.0.1" });
await once(server, "listening");
const origin = "http://127.0.0.1:" + server.address().port;
const cloud = "https://fixture.supabase.co";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const path of ["/", "/index-v2.html"]) {
    const context = await browser.newContext();
    const requests = [];
    const errors = [];
    let configured = true;
    await context.route("**/*", route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin === origin && url.pathname === "/api/image-config") {
        return route.fulfill({ json: { configured: false, supabaseUrl: configured ? cloud : null, supabasePublishableKey: "fixture" } });
      }
      if (url.origin === origin) return route.continue();
      if (url.origin === cloud && url.pathname === "/auth/v1/otp") {
        requests.push(req.postDataJSON());
        return route.fulfill({ json: {} });
      }
      return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin + path);
    await page.getByRole("button", { name: "登录 / 注册" }).click();
    const dialog = page.getByRole("dialog");
    assert.match(await dialog.innerText(), /新账号注册赠 200 Bcoin，到账后 30 天有效/);
    await dialog.getByLabel("邮箱地址").fill("fixture@example.test");
    await dialog.getByRole("button", { name: "发送注册链接" }).click();
    await dialog.getByRole("status").getByText("邮件已发送", { exact: false }).waitFor();
    await dialog.getByLabel("登录账号").check();
    assert.equal(await dialog.locator(".account-gift").isVisible(), false);
    await dialog.getByRole("button", { name: "发送登录链接" }).click();
    await dialog.getByRole("status").getByText("邮件已发送", { exact: false }).waitFor();
    assert.deepEqual(requests.map(request => request.create_user), [true, false]);
    assert.ok(requests.every(request => request.email === "fixture@example.test"));
    await page.keyboard.press("Escape");
    if (path === "/") {
      await page.locator("#account-state").click();
      await dialog.getByLabel("邮箱地址").fill("first-use@example.test");
      await dialog.getByRole("button", { name: "发送登录链接" }).click();
      await dialog.getByRole("status").getByText("邮件已发送", { exact: false }).waitFor();
      assert.equal(requests.at(-1).create_user, true, "demo retains first-use creation");
    }
    configured = false;
    await page.reload();
    await page.getByRole("button", { name: "登录 / 注册" }).click();
    assert.equal(await dialog.getByRole("button", { name: "发送注册链接" }).isDisabled(), true);
    assert.match(await dialog.getByRole("status").innerText(), /账号服务暂不可用/);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS real SDK with intercepted OTP: registration, existing-user login, original first-use demo and unconfigured state on both homepages");
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
