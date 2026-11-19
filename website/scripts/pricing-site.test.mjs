import assert from "node:assert/strict";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../apps/html-renderer/node_modules/playwright/index.mjs";
import { startServer } from "../server.mjs";

// Exercise the shipped HTML and the real static router after pnpm run build.
// A fresh browser and a disconnected config keep the test independent of accounts.
process.env.BOWERBIRD_WINDOWS_DOWNLOAD_URL = "";
process.env.SUPABASE_URL = "";
const server = startServer({
  root: process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL("../dist", import.meta.url)),
  host: "127.0.0.1", port: 0,
});
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  for (const method of ["GET", "HEAD"]) {
    const redirect = await fetch(origin + "/pricing?from=home", { method, redirect: "manual" });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "/pricing/?from=home");
    assert.equal((await fetch(origin + "/pricing/", { method })).status, 200);
  }
  assert.equal((await fetch(origin + "/pricing/missing", { method: "HEAD" })).status, 404);
  assert.equal((await fetch(origin + "/pricing/", { method: "POST" })).status, 405);

  const config = await (await fetch(origin + "/api/image-config")).json();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === origin && route.request().method() === "GET" ? route.continue() : route.abort();
  });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const checked = new Set();
  for (const path of ["/", "/index-v2.html", "/pricing/"]) {
    const result = await page.goto(origin + path);
    assert.equal(result.status(), 200);
    if (path === "/pricing/") {
      assert.equal((await page.reload()).status(), 200);
    } else {
      const html = await result.text();
      const fallback = html.match(/<a\b[^>]*id="windows-download"[^>]*href="([^"]+)"/)?.[1];
      assert.equal(fallback, config.windowsDownloadUrl, path + " Windows HTML and API download URLs differ");
      assert.equal(await page.locator("#windows-download").getAttribute("href"), config.windowsDownloadUrl);
      assert.ok(await page.locator('a[href="/pricing/"]').count(), path + " missing pricing link");
    }
    const urls = await page.locator("[src], [data-src], [poster], link[href]").evaluateAll(elements =>
      elements.flatMap(el => ["src", "data-src", "poster", "href"].map(key => el.getAttribute(key)))
        .filter(Boolean).map(value => new URL(value, location.href)).filter(url => url.origin === location.origin)
        .map(url => url.href)
    );
    for (const url of new Set(urls)) {
      if (checked.has(url)) continue;
      assert.equal((await fetch(url, { method: "HEAD" })).status, 200, path + " broken resource " + url);
      checked.add(url);
    }
  }
  assert.deepEqual(errors, []);
  for (const [width, height] of [[1440, 900], [320, 640]]) {
    for (const javaScriptEnabled of [true, false]) {
      const context = await browser.newContext({ viewport: { width, height }, javaScriptEnabled });
      await context.route("**/*", route => new URL(route.request().url()).origin === origin
        ? route.continue() : route.abort());
      const pricing = await context.newPage();
      await pricing.goto(origin + "/pricing/");
      const menu = pricing.locator("#site-nav");
      assert.equal(await pricing.locator('a[href*="board-demo"], a[href="#trial"], a[href*="#workflow"]').count(), 0);
      assert.doesNotMatch(await pricing.locator("main").innerText(), /试玩|7 天|注册账号赠|新注册|兑换码|用免费版整理素材、摆放参考图/);
      assert.equal(await pricing.locator('main a[href="#subscription"], main a[href="#recharge"], main details.usage').count(), 0);
      if (width === 320 && javaScriptEnabled) {
        const toggle = pricing.locator("#menu-toggle");
        await toggle.focus();
        await pricing.keyboard.press("Enter");
        assert.equal(await toggle.getAttribute("aria-expanded"), "true");
        assert.equal(await menu.isVisible(), true);
        await pricing.keyboard.press("Escape");
        assert.equal(await toggle.getAttribute("aria-expanded"), "false");
        assert.equal(await toggle.evaluate(button => button === document.activeElement), true);
      } else {
        assert.equal(await menu.isVisible(), true);
      }
      for (const picture of await pricing.locator("main img").all()) {
        await picture.scrollIntoViewIfNeeded();
        await picture.evaluate(img => img.decode());
      }
      const headers = pricing.locator("#subscription thead th[scope=col]");
      assert.equal(await headers.count(), 3);
      assert.match(await headers.nth(1).innerText(), /免费/);
      assert.match(await headers.nth(2).innerText(), /Pro/);
      for (const [index, cell] of (await headers.all()).entries()) {
        assert.equal(await cell.isVisible(), true);
        const bounds = await cell.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `column ${index} falls outside ${width}px`);
      }
      const rows = pricing.locator('#subscription tr:has(th[scope=row])');
      assert.ok(await rows.count() >= 6);
      for (const row of await rows.all()) assert.equal(await row.locator("td").count(), 2);
      assert.ok(await pricing.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      const presetAmounts = [5, 10, 20, 50, 100, 500];
      const presets = pricing.locator(".denominations li");
      assert.equal(await presets.count(), presetAmounts.length);
      for (const [index, yuan] of presetAmounts.entries()) {
        const item = presets.nth(index);
        const label = (await item.innerText()).replace(/[,\s]/g, "");
        assert.ok(label.includes(`${yuan * 20}Bcoin`) && label.includes(`¥${yuan}`), label);
      }
      if (javaScriptEnabled) {
        const amount = pricing.locator("#custom-yuan");
        const total = pricing.locator("#coin-total");
        for (const [index, yuan] of presetAmounts.entries()) {
          const button = presets.nth(index).getByRole("button");
          await button.focus();
          await pricing.keyboard.press("Space");
          assert.equal(await amount.inputValue(), String(yuan));
          assert.equal(await button.getAttribute("aria-pressed"), "true");
          assert.equal(await pricing.locator(".denominations [aria-pressed=true]").count(), 1);
          assert.equal((await total.textContent()).replace(/[,\s]/g, ""), yuan * 20 + "Bcoin");
        }
        for (const input of ["1", "25", "21474836"]) {
          await amount.fill(input);
          assert.equal((await total.textContent()).replace(/[,\s]/g, ""), (Number(input) * 20) + "Bcoin");
        }
        for (const input of ["0", "-1", "1.5", "2e2", "abc", "21474837", ""]) {
          await amount.fill(input);
          assert.equal(await total.textContent(), "—");
          assert.equal(await amount.getAttribute("aria-invalid"), String(input !== ""));
        }
      } else {
        assert.equal(await pricing.locator("#custom-note").isVisible(), true);
        assert.equal(await pricing.locator("#custom-yuan").isVisible(), false);
      }
      await pricing.locator('footer a[href="/#faq"]').click();
      assert.equal(new URL(pricing.url()).hash, "#faq");
      assert.equal(await pricing.locator("#faq").count(), 1);
      for (const homepage of ["/#faq", "/index-v2.html#faq"]) {
        await pricing.goto(origin + homepage);
        const question = pricing.locator("#faq details").filter({ has: pricing.locator("summary", { hasText: "用 Bowerbird Cloud 和用自己的订阅有什么区别" }) });
        assert.equal(await question.count(), 1);
        await question.locator("summary").focus();
        await pricing.keyboard.press("Enter");
        assert.equal(await question.getAttribute("open"), "");
        const answer = question.locator("p");
        assert.match(await answer.allTextContents().then(parts => parts.join("")), /Bcoin/);
        assert.equal(await answer.first().isVisible(), true);
        await pricing.keyboard.press("Enter");
        assert.equal(await question.getAttribute("open"), null);
      }
      await context.close();
    }
  }
  console.log(`PASS pricing route, refresh, both download targets and ${checked.size} built resources; Free/Pro table, six denominations and custom input at desktop/320px with and without JavaScript`);
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
