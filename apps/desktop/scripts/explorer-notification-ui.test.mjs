import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.goto(new URL("scripts/fixtures/explorer/preview.html", server.resolvedUrls.local[0]).href);
  await page.getByRole("button", { name: "探索", exact: true }).click();
  const waitVisible = visible => page.waitForFunction(expected =>
    window.calls.filter(call => call.command === "resize_source_browser").at(-1)?.args.visible === expected, visible);
  await waitVisible(true);
  const hiddenCount = () => page.evaluate(() => window.calls.filter(call => call.command === "resize_source_browser" && !call.args.visible).length);
  const initialCount = await hiddenCount();
  await page.evaluate(async () => {
    const { notifySuccess } = await import("/src/lib/notify.ts");
    notifySuccess("测试消息", undefined, "generation");
  });
  await page.getByRole("status", { name: "新通知" }).waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await hiddenCount(), initialCount);
  for (const role of ["dialog", "alertdialog", "menu", "listbox"]) {
    const before = await hiddenCount();
    await page.evaluate(role => {
      const viewport = document.querySelector("[data-source-browser-viewport]").getBoundingClientRect();
      const popup = document.createElement("div");
      popup.id = "test-card-popup";
      popup.setAttribute("role", role);
      popup.style.cssText = `position:fixed;width:60px;height:40px;top:${viewport.top + 10}px;left:${viewport.right + 8}px`;
      document.body.append(popup);
    }, role);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await hiddenCount(), before, role + " outside the webpage");
    const popup = page.locator("#test-card-popup");
    await popup.evaluate(el => el.style.left = document.querySelector("[data-source-browser-viewport]").getBoundingClientRect().left + "px");
    await waitVisible(false);
    await popup.evaluate(el => el.remove());
    await waitVisible(true);
  }
  await page.getByRole("button", {name:"采集记录", exact:true}).click();
  await waitVisible(false);
  await page.keyboard.press("Escape");
  await waitVisible(true);
  const beforeHistory = await hiddenCount();
  await page.getByTitle("通知", {exact:true}).click();
  await page.getByRole("dialog", {name:"通知历史"}).waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await hiddenCount(), beforeHistory, "notification history beside Explore keeps the webpage visible");
  console.log("PASS incoming notification keeps Explore visible, and a deliberate dialog still suspends and restores it.");
} finally {
  await browser.close();
  await server.close();
}
