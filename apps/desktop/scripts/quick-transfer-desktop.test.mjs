import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import jsQR from "jsqr";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1598, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
page.setDefaultTimeout(6000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const fixture = "http://127.0.0.1:1598/scripts/fixtures/quick-transfer-desktop/preview.html";
const button = name => page.getByRole("button", { name, exact: true });
const dialog = page.getByRole("dialog", { name: "快传", exact: true });
const commandCount = command => page.evaluate(command => window.calls.filter(call => call.command === command).length, command);
const file = (id, status, extra = {}) => ({ id, status, name: `${id}.jpg`, size: 1000, received: status === "receiving" ? 460 : 1000, error: null, assetId: null, retryable: false, ...extra });
try {
  await page.goto(fixture);
  await button("快传").click();
  await dialog.waitFor();
  assert.equal(await commandCount("quick_transfer_start"), 0, "opening the panel never starts a listener");
  await page.getByText("D:\\BowerbirdLibrary\\快传", { exact: true }).waitFor();
  assert.equal(await button("选择文件夹").count(), 0, "the managed default destination needs no picker");
  assert.equal(await page.getByRole("switch", { name: "接收开关" }).isDisabled(), false);
  await page.getByLabel("局域网地址").selectOption("10.0.0.9");
  await page.evaluate(() => { window.holdStart = true; });
  await page.getByRole("switch", { name: "接收开关" }).click();
  assert.equal(await page.getByRole("switch", { name: "接收开关" }).isDisabled(), true);
  assert.equal(await commandCount("quick_transfer_start"), 1);
  await page.evaluate(() => window.releaseStart());
  await page.getByText("接收已开启", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("局域网地址").isDisabled(), true);
  const request = await page.evaluate(() => window.calls.find(call => call.command === "quick_transfer_start").args);
  assert.deepEqual(request, { address: "10.0.0.9" }, "the backend resolves the current library root at start time");
  assert.equal(await commandCount("plugin:dialog|open"), 0);

  const qr = page.getByRole("img", { name: "扫码上传到 Bowerbird" });
  await qr.waitFor();
  const pixels = await qr.evaluate(async img => {
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d"); context.drawImage(img, 0, 0);
    return { data: [...context.getImageData(0, 0, canvas.width, canvas.height).data], width: canvas.width, height: canvas.height };
  });
  assert.equal(jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data,
    "http://10.0.0.9:53317/?pin=01234567", "real QR carries the complete authenticated URL");
  await page.getByText("电脑浏览器打开", { exact: true }).waitFor();
  await page.getByText("http://10.0.0.9:53317", { exact: true }).waitFor();
  await page.getByText("01234567", { exact: true }).waitFor();
  await button("复制上传地址").click();
  assert.equal(await page.evaluate(() => window.copiedAddress), "http://10.0.0.9:53317/?pin=01234567");
  await page.getByText("已复制完整地址", { exact: true }).waitFor();

  await button("收起快传面板").click();
  assert.equal(await dialog.count(), 0);
  assert.equal(await commandCount("quick_transfer_stop"), 0, "hiding does not stop the receiver");
  await page.evaluate(transfers => window.emit({ transfers }), [file("山间晨雾", "complete", { assetId: "asset-photo" }), file("海边散步", "receiving"), file("拍摄笔记", "indexing")]);
  await button("快传").click();
  await page.getByText("46%", { exact: true }).waitFor();
  await page.getByText("正在入库", { exact: true }).waitFor();
  await mkdir(".tmp/quick-transfer-desktop", { recursive: true });
  await page.screenshot({ path: ".tmp/quick-transfer-desktop/receiving-dark.png", animations: "disabled" });
  assert.equal(await dialog.locator(".app-modal").evaluate(node => getComputedStyle(node).opacity), "1");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.screenshot({ path: ".tmp/quick-transfer-desktop/receiving-light.png", animations: "disabled" });
  assert.equal(await dialog.locator(".app-modal-body").evaluate(node => getComputedStyle(node).padding), "0px", "light theme must retain the same content layout");
  assert.equal(await dialog.locator(".app-modal-title").evaluate(node => getComputedStyle(node).fontSize), "24px");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });

  const focusable = dialog.locator("button:not(:disabled),select:not(:disabled),[tabindex='0']");
  await focusable.last().focus(); await page.keyboard.press("Tab");
  assert.equal(await focusable.first().evaluate(node => node === document.activeElement), true);
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focusable.last().evaluate(node => node === document.activeElement), true,
    await dialog.evaluate(node => JSON.stringify({ active: document.activeElement?.outerHTML, targets: [...node.querySelectorAll('button:not(:disabled),select:not(:disabled),[tabindex="0"]')].map(item => item.outerHTML.slice(0, 150)) })));
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 0);
  assert.equal(await button("快传").evaluate(node => node === document.activeElement), true);
  assert.equal(await commandCount("quick_transfer_stop"), 0);
  await button("快传").click();

  await page.evaluate(transfers => window.emit({ transfers }), [file("已保存", "failed", { retryable: true, error: "SQLITE_SECRET C:\\private\\db.sqlite" }), file("未接收", "failed", { error: "HTTP https://secret.invalid/?pin=secret" })]);
  await button("重试入库").click();
  assert.equal(await commandCount("quick_transfer_retry"), 1);
  assert.equal(await button("重试入库").count(), 0, "incomplete files cannot be indexed or resent from desktop");
  assert.ok(!(await dialog.innerText()).includes("SECRET"));
  assert.ok(!(await dialog.innerText()).includes("secret.invalid"));
  await page.getByText("请在手机重新发送这个文件。", { exact: true }).waitFor();
  await page.setViewportSize({ width: 470, height: 650 });
  await page.screenshot({ path: ".tmp/quick-transfer-desktop/narrow-failed.png", animations: "disabled" });
  const viewport = dialog.locator(".collection-scroll-viewport");
  assert.equal(await viewport.evaluate(node => node.scrollWidth <= node.clientWidth), true, "narrow content must not scroll horizontally");
  await viewport.evaluate(node => { node.scrollTop = node.scrollHeight; });
  assert.equal(await dialog.locator(".quick-transfer-bottom").evaluate(node => {
    const row = node.getBoundingClientRect(), parent = node.closest(".collection-scroll-viewport").getBoundingClientRect();
    return row.bottom <= parent.bottom + 1;
  }), true, "long queues and the network notice remain reachable by scrolling");
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.getByRole("switch", { name: "接收开关" }).click();
  await page.getByText("接收已关闭", { exact: true }).waitFor();
  assert.equal(await commandCount("quick_transfer_stop"), 1);
  assert.equal(await qr.count(), 0, "closing removes the stale QR");

  await page.goto(`${fixture}?offline`);
  await button("快传").click();
  await page.getByText("未找到可用的局域网地址，请连接 Wi-Fi 或有线网络后刷新。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("switch", { name: "接收开关" }).isDisabled(), true);
  await page.evaluate(() => { window.addresses = ["192.168.1.23"]; });
  await button("刷新地址").click();
  await page.waitForFunction(() => !document.querySelector('[role="switch"]').disabled);
  await page.evaluate(() => { window.failures = { quick_transfer_start: "upstreamSecretToken https://private.invalid/private" }; });
  await page.getByRole("switch", { name: "接收开关" }).click();
  await page.getByRole("alert").filter({ hasText: "未能开启接收" }).waitFor();
  assert.ok(!(await dialog.innerText()).includes("upstreamSecretToken"));
  assert.equal(await qr.count(), 0);
  await page.screenshot({ path: ".tmp/quick-transfer-desktop/start-failed.png", animations: "disabled" });

  await page.goto(`${fixture}?holdStatus`);
  await button("快传").click();
  await page.waitForFunction(() => !!window.releaseStatus);
  await page.evaluate(() => {
    window.emit({ active: true, directory: "D:\\素材\\手机快传", url: "http://192.168.1.23:53317/?pin=new-session" });
    window.holdStatus = false; window.releaseStatus();
  });
  await page.getByText("接收已开启", { exact: true }).waitFor();
  assert.equal(await page.getByRole("switch", { name: "接收开关" }).getAttribute("aria-checked"), "true", "late initial status cannot undo the event");
  await page.getByRole("switch", { name: "接收开关" }).click();
  await page.evaluate(() => { window.holdStart = true; });
  await page.getByRole("switch", { name: "接收开关" }).click();
  await page.waitForFunction(() => !!window.releaseStart);
  await page.evaluate(() => { window.emit({ active: false, url: null }); window.releaseStart(); });
  await page.getByText("接收已关闭", { exact: true }).waitFor();
  assert.equal(await qr.count(), 0, "a late start reply cannot restore the old QR after a newer stop event");
  await page.evaluate(() => window.emit({ revision: window.snapshot.revision - 1, active: true, url: "http://192.168.1.23:53317/?pin=old-session" }));
  assert.equal(await page.getByRole("switch", { name: "接收开关" }).getAttribute("aria-checked"), "false", "out-of-order event cannot reopen the receiver");
  assert.deepEqual(errors, []);
  console.log("PASS quick transfer: default library folder, no picker, explicit start/address, manual browser address/code, single IPC, true QR decode/copy, hide/reopen, progress/indexing, stop, retry, safe errors, offline refresh, Tab/Esc, themes/narrow scroll, stale status/start/event replies");
} finally { await browser.close(); await server.close(); }
