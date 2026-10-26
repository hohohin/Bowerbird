import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
const button = name => page.getByRole("button", { name, exact: true });
const dialog = () => page.getByRole("dialog", { name: "浏览器插件", exact: true });
const calls = command => page.evaluate(command => window.calls.filter(call => call.command === command), command);
const lastVisible = visible => page.waitForFunction(visible => window.calls.filter(call => call.command === "resize_source_browser").at(-1)?.args.visible === visible, visible);
const fixtureUrl = query => `http://127.0.0.1:${port}/scripts/fixtures/extension/preview.html${query ? `?${query}` : ""}`;

async function load(query = "") {
  await page.goto(fixtureUrl(query));
  await button("浏览器插件").waitFor();
  await lastVisible(true);
  assert.equal(await dialog().count(), 0, "the installation panel never opens automatically");
}

async function open() {
  await button("浏览器插件").click();
  await dialog().waitFor();
  await lastVisible(false);
  await button("重新检测").waitFor();
}

async function assertError() {
  const alerts = dialog().getByRole("alert");
  await alerts.first().waitFor();
  const text = (await alerts.allTextContents()).join(" ");
  assert.match(text, /[\u3400-\u9fff]/, "errors must provide a Chinese explanation");
  assert.doesNotMatch(text, /fixture (?:status|folder|clipboard) failure/, "raw diagnostics stay out of the user message");
}

async function noNavigationSince(before) {
  const after = await page.evaluate(() => window.calls.filter(call => ["open_source_browser", "navigate_source_browser", "reload_source_browser"].includes(call.command)));
  assert.deepEqual(after, before, "the dialog only changes native visibility, preserving the same page");
}

try {
  await mkdir(".tmp/extension-panel", { recursive: true });
  await load();
  await page.getByRole("textbox", { name: "网页地址" }).fill("https://fixture.example/collection/kept");
  await page.getByRole("textbox", { name: "网页地址" }).press("Enter");
  const nativeBefore = await page.evaluate(() => window.calls.filter(call => ["open_source_browser", "navigate_source_browser", "reload_source_browser"].includes(call.command)));
  await open();
  await dialog().getByText("未连接", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().extensionOnboardingForceOpen), true);
  assert.ok((await calls("extension_status")).length >= 1, "opening checks the backend instead of trusting a stale store");
  await dialog().getByRole("textbox", { name: "插件文件夹路径" }).waitFor();
  assert.equal(await dialog().getByRole("textbox", { name: "插件文件夹路径" }).inputValue(), await page.evaluate(() => window.folderPath));
  assert.equal(await dialog().getByRole("textbox", { name: "插件文件夹路径" }).getAttribute("readonly"), "");

  // Both browser destinations and the exact current bundle path are copied via an isolated clipboard.
  await button("Chrome").click();
  await button("复制 Chrome 扩展页地址").click();
  assert.equal(await page.evaluate(() => window.clipboardWrites.at(-1)), "chrome://extensions");
  await button("Edge").click();
  assert.equal(await button("Edge").getAttribute("aria-pressed"), "true");
  await button("复制 Edge 扩展页地址").click();
  assert.equal(await page.evaluate(() => window.clipboardWrites.at(-1)), "edge://extensions");
  await button("复制插件文件夹路径").click();
  assert.equal(await page.evaluate(() => window.clipboardWrites.at(-1)), await page.evaluate(() => window.folderPath));

  // Clipboard completion belongs to the request and selected browser that started it.
  await button("Chrome").click();
  await page.evaluate(() => { window.holdClipboard = true; });
  await button("复制 Chrome 扩展页地址").click();
  await page.waitForFunction(() => window.clipboardPending.length === 1);
  await button("Edge").click();
  await page.evaluate(async () => {
    window.holdClipboard = false;
    window.clipboardPending[0].resolve();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(await page.evaluate(() => window.clipboardWrites.at(-1)), "chrome://extensions");
  assert.doesNotMatch(await button("复制 Edge 扩展页地址").innerText(), /已复制/, "late Chrome success cannot claim the Edge address was copied");
  assert.equal(await dialog().getByRole("status").innerText(), "");

  await page.evaluate(() => { window.holdClipboard = true; });
  await button("复制 Edge 扩展页地址").click();
  await page.waitForFunction(() => window.clipboardPending.length === 2);
  await page.evaluate(() => { window.holdClipboard = false; });
  await button("复制插件文件夹路径").click();
  await button("复制插件文件夹路径").getByText("已复制", { exact: true }).waitFor();
  await page.evaluate(async () => {
    window.clipboardPending[1].reject(new Error("fixture clipboard failure"));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.match(await button("复制插件文件夹路径").innerText(), /已复制/, "an earlier rejection cannot erase the newer successful copy");
  assert.equal(await dialog().getByRole("alert").count(), 0, "an earlier rejection cannot report failure for the newer successful copy");
  assert.equal(await page.evaluate(() => window.clipboardWrites.at(-1)), await page.evaluate(() => window.folderPath));

  await button("Chrome").click();
  const illustration = button("放大：在地址栏打开扩展管理页");
  await illustration.click();
  await page.getByRole("dialog", { name: "示例图放大", exact: true }).waitFor();
  await page.keyboard.press("Tab");
  assert.equal(await button("关闭示例图").evaluate(element => element === document.activeElement), true);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "示例图放大", exact: true }).waitFor({ state: "detached" });
  assert.equal(await dialog().count(), 1, "Escape closes the zoom without dismissing installation");
  assert.equal(await illustration.evaluate(element => element === document.activeElement), true);
  await lastVisible(false);

  // The modal keeps keyboard focus and yields the native webview while the tutorial is open.
  const focusable = dialog().locator('button:not([disabled]), input:not([disabled]), [tabindex="0"]');
  await focusable.last().focus();
  await page.keyboard.press("Tab");
  assert.equal(await focusable.first().evaluate(element => element === document.activeElement), true);
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focusable.last().evaluate(element => element === document.activeElement), true);
  await noNavigationSince(nativeBefore);
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached" });
  await lastVisible(true);
  assert.equal(await button("浏览器插件").evaluate(element => element === document.activeElement), true, "closing returns focus to the plugin entry");
  assert.equal(await page.evaluate(() => window.closedBrowser), 0, "Escape closes the dialog, not the exploration page");
  assert.equal(await page.getByRole("textbox", { name: "网页地址" }).inputValue(), "https://fixture.example/collection/kept");
  assert.equal(await page.getByRole("textbox", { name: "主页面草稿" }).inputValue(), "保留主页面状态");
  await noNavigationSince(nativeBefore);

  // Heartbeats change status in place; connecting never dismisses the panel.
  await open();
  await page.evaluate(() => window.setConnection(true));
  await dialog().getByText("已连接", { exact: true }).waitFor();
  assert.equal(await dialog().count(), 1);
  assert.equal(await button("安装或更新教程").getAttribute("aria-expanded"), "true", "a new connection leaves the user's open instructions intact");
  await page.evaluate(() => window.setConnection(false));
  await dialog().getByText("未连接", { exact: true }).waitFor();
  const checks = (await calls("extension_status")).length;
  await page.evaluate(() => { window.connected = true; });
  await button("重新检测").click();
  await dialog().getByText("已连接", { exact: true }).waitFor();
  assert.equal((await calls("extension_status")).length, checks + 1);
  assert.equal(await page.evaluate(() => window.store.getState().extensionConnected), true);
  await page.evaluate(() => { window.holdStatus = true; });
  await button("重新检测").click();
  await page.waitForFunction(() => typeof window.resolveStatus === "function");
  assert.equal(await button("正在检测…").isDisabled(), true);
  await page.evaluate(async () => { await window.setConnection(false); await window.setConnection(true); window.holdStatus = false; window.resolveStatus(false); });
  await dialog().getByText("已连接", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().extensionConnected), true, "a late query snapshot cannot overwrite a newer heartbeat");
  await page.evaluate(() => { window.holdStatus = true; window.resolveStatus = null; });
  await button("重新检测").click();
  await page.waitForFunction(() => typeof window.resolveStatus === "function");
  await page.evaluate(async () => { await window.setConnection(true); window.holdStatus = false; window.resolveStatus(false); });
  await dialog().getByText("已连接", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().extensionConnected), true, "a repeated true heartbeat is newer evidence even when the store boolean stays unchanged");
  await button("关闭").click();
  await lastVisible(true);

  // Already-connected users see usage and can deliberately reopen installation/update instructions.
  await load("connected");
  await open();
  await dialog().getByText("已连接", { exact: true }).waitFor();
  await button("安装或更新教程").waitFor();
  assert.equal(await button("安装或更新教程").getAttribute("aria-expanded"), "false");
  assert.match(await dialog().innerText(), /Alt/);
  await button("安装或更新教程").click();
  assert.equal(await button("安装或更新教程").getAttribute("aria-expanded"), "true");
  await dialog().getByRole("textbox", { name: "插件文件夹路径" }).waitFor();
  assert.match(await dialog().innerText(), /更新/);
  await page.evaluate(() => { window.clipboardError = "fixture clipboard failure"; });
  const writesBefore = await page.evaluate(() => window.clipboardWrites.length);
  await button("复制插件文件夹路径").click();
  await assertError();
  assert.equal(await page.evaluate(() => window.clipboardWrites.length), writesBefore);
  assert.equal(await dialog().getByRole("textbox", { name: "插件文件夹路径" }).inputValue(), await page.evaluate(() => window.folderPath), "manual path selection remains available after clipboard failure");
  await page.evaluate(() => { window.clipboardError = null; });
  await button("复制插件文件夹路径").click();
  assert.equal(await page.evaluate(() => window.clipboardWrites.length), writesBefore + 1);

  // A failed status query must not masquerade as a disconnected extension, and retry must recover.
  await load("status-error");
  await open();
  await dialog().getByText("暂时无法确认连接状态", { exact: true }).waitFor();
  await assertError();
  await page.evaluate(() => { window.statusError = null; window.connected = true; });
  await button("重新检测").click();
  await dialog().getByText("已连接", { exact: true }).waitFor();
  await load("folder-error");
  await open();
  await assertError();
  assert.equal(await button("复制插件文件夹路径").isDisabled(), true, "failed path lookup must not copy an empty or invented directory");
  await page.evaluate(() => { window.folderError = null; });
  await button("重新获取插件文件夹路径").click();
  await page.waitForFunction(() => document.querySelector('[aria-label="插件文件夹路径"]')?.value === window.folderPath);
  await button("复制插件文件夹路径").click();
  assert.equal(await page.evaluate(() => window.clipboardWrites.at(-1)), await page.evaluate(() => window.folderPath));

  // Screenshots and geometry cover the native desktop minimum plus a smaller dialog viewport.
  await load();
  await open();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [900, 560]) {
      await page.setViewportSize({ width, height: 680 });
      await page.waitForTimeout(220);
      const geometry = await dialog().locator(".app-modal").evaluate(element => {
        const rect = element.getBoundingClientRect();
        const body = element.querySelector(".app-modal-body");
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight,
          overflow: body.scrollWidth > body.clientWidth + 1 };
      });
      assert.ok(geometry.left >= 0 && geometry.right <= geometry.width + 1 && geometry.top >= 0 && geometry.bottom <= geometry.height + 1, JSON.stringify(geometry));
      assert.equal(geometry.overflow, false, "tutorial and full path wrap without horizontal overflow");
      await page.screenshot({ path: `.tmp/extension-panel/${theme}-${width}.png`, animations: "disabled" });
    }
  }
  assert.deepEqual(errors, []);
  console.log("PASS extension entry, connection/recheck, Chrome/Edge/path copy and late-result isolation, failure recovery, focus/Escape, native visibility without navigation, and narrow light/dark layouts.");
} catch (error) {
  console.error(error);
  console.log(JSON.stringify({ errors, calls: await page.evaluate(() => window.calls?.slice(-12)).catch(() => []), text: await page.locator("body").innerText().catch(() => "") }));
  await page.screenshot({ path: ".tmp/extension-panel/failure.png" }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await server.close();
}
