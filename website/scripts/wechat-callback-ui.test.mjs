import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../apps/html-renderer/node_modules/playwright/index.mjs";
import { startServer } from "../server.mjs";

const root = path.resolve(process.argv[2] || fileURLToPath(new URL("../dist/", import.meta.url)));
const screenshots = fileURLToPath(new URL("../.tmp/wechat-callback-integration/", import.meta.url));
await mkdir(screenshots, { recursive: true });
const html = await readFile(path.join(root, "wechat-callback.html"), "utf8");
assert.ok(html.includes("window.location.replace(desktopHref)"));
// Replace only navigation in the served test response. The real DOM, styles,
// callback state machine and auth exchange run unchanged; no OS scheme opens.
const fixture = html
  .replace("window.location.replace(desktopHref)", "window.__callbackNavigation(desktopHref)")
  .replace('window.location.replace("/")', 'window.__callbackNavigation("/")');
const server = startServer({ root, host: "127.0.0.1", port: 0 });
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__navigations = [];
    window.__callbackNavigation = href => {
      window.__navigations.push(href);
      if (href.startsWith("bowerbird:")) throw new Error("synthetic browser refusal");
    };
    window.__manualOpen = null;
    document.addEventListener("click", event => {
      const link = event.target.closest("a");
      if (link?.href.startsWith("bowerbird:")) {
        event.preventDefault();
        window.__manualOpen = { href: link.href, trusted: event.isTrusted };
      }
    }, true);
    sessionStorage.setItem("bowerbird.wechatLoginState", "web_fixture");
  });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === "/wechat-callback.html") {
      return route.fulfill({ contentType: "text/html", body: fixture });
    }
    if (url.origin === origin && url.pathname === "/api/image-config") {
      return route.fulfill({ json: { supabaseUrl: "https://fixture.supabase.co", supabasePublishableKey: "synthetic" } });
    }
    if (url.hostname === "fixture.supabase.co") {
      return route.fulfill({ json: { access_token: "synthetic", refresh_token: "synthetic" } });
    }
    if (url.hostname === "cdn.jsdelivr.net") {
      return route.fulfill({ contentType: "application/javascript", body: `window.supabase = { createClient: () => ({ auth: {
        setSession: () => new Promise(resolve => { window.__finishSession = () => resolve({ error: null }); })
      } }) };` });
    }
    if (url.origin !== origin) return route.abort();
    return route.continue();
  });
  const screenshot = name => page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
  const callback = query => page.goto(`${origin}/wechat-callback.html?${new URLSearchParams(query)}`);
  const code = "synthetic+code /?=&%";
  const state = "dt_synthetic+state";
  await callback({ code, state });
  await page.getByRole("heading", { name: "准备返回 Bowerbird" }).waitFor();
  assert.equal(await page.locator(".logo-wrap img").evaluate(img => img.complete && img.naturalWidth === 256), true);
  assert.equal(await page.locator(".login-card").evaluate(el => getComputedStyle(el).borderRadius), "28px");
  assert.equal(await page.locator("#journey").isVisible(), true);
  assert.equal(await page.locator(".preview-controls").count(), 0);
  await screenshot("desktop-returning");
  await page.getByRole("heading", { name: "回到应用，继续登录" }).waitFor();
  await page.getByRole("link", { name: "再次打开 Bowerbird" }).click();
  const manual = await page.evaluate(() => window.__manualOpen);
  assert.equal(manual.trusted, true);
  assert.equal(new URL(manual.href).searchParams.get("code"), code);
  assert.equal(new URL(manual.href).searchParams.get("state"), state);
  assert.doesNotMatch(await page.locator("main").innerText(), /登录成功|synthetic|code=|state=|callback/);
  await screenshot("desktop-retry");
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: retry overflow`);
  }
  await page.setViewportSize({ width: 390, height: 944 });
  await screenshot("mobile-retry");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await callback({ code, state });
  assert.equal(await page.locator("#spinner").evaluate(el => getComputedStyle(el).animationName), "none");
  await page.locator("#primary").focus();
  assert.equal(await page.locator("#primary").evaluate(el => getComputedStyle(el).outlineStyle), "solid");
  const raw = "SQLITE_BUSY C:/private/path WECHAT_APP_SECRET";
  await callback({ state, error_description: raw });
  await page.getByRole("alert").getByText("这次登录未完成").waitFor();
  assert.equal(await page.locator("#primary").getAttribute("href"), "/");
  assert.doesNotMatch(await page.locator("body").innerText(), /SQLITE|private|WECHAT_APP_SECRET/);
  assert.deepEqual(await page.evaluate(() => window.__navigations), []);
  await screenshot("mobile-error");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await screenshot("desktop-error");
  await callback({ state: "web_fixture", code: "synthetic" });
  await page.waitForFunction(() => typeof window.__finishSession === "function");
  assert.equal(await page.locator("#login-card").getAttribute("data-state"), "processing");
  assert.equal(await page.locator("#journey").isVisible(), false);
  assert.equal(await page.locator("#primary").isVisible(), false);
  assert.doesNotMatch(await page.locator("main").innerText(), /登录成功/);
  await screenshot("web-processing");
  await page.evaluate(() => window.__finishSession());
  await page.getByRole("heading", { name: "微信登录成功" }).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("bowerbird.wechatLoginState")), null);
  await screenshot("web-success");
  await page.waitForFunction(() => window.__navigations.includes("/"));
  assert.deepEqual(errors, []);
  console.log("PASS: built callback styles/logo, desktop automatic refusal/manual gesture, web pending/success, errors, mobile layout, focus and reduced motion");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
