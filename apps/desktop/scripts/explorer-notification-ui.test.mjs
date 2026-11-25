import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.goto(new URL("scripts/fixtures/explorer/preview.html", server.resolvedUrls.local[0]).href);
  const smallViewport = await page.addStyleTag({ content: ".source-browser-viewport { flex: 0 0 170px !important; }" });
  await page.getByRole("button", { name: "探索", exact: true }).click();
  const sizeNotice = page.getByRole("status").filter({ hasText: "网页区域过小" });
  await sizeNotice.waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "open_source_browser").length), 0);
  await page.getByRole("button", { name: "花瓣", exact: true }).click();
  await smallViewport.evaluate(style => style.remove());
  const waitVisible = visible => page.waitForFunction(expected =>
    window.calls.filter(call => call.command === "resize_source_browser").at(-1)?.args.visible === expected, visible);
  await waitVisible(true);
  assert.equal(await page.evaluate(() => window.calls.find(call => call.command === "open_source_browser").args.url), "https://huaban.com/",
    "the first usable viewport opens the most recent address");
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
  for (const className of ["caption-ring-layer", "external-drag-backdrop"]) {
    await page.evaluate(className => {
      const overlay = document.createElement("div");
      overlay.className = className;
      overlay.id = "test-canvas-veil";
      overlay.style.cssText = "position:fixed;width:30px;height:30px;right:0;bottom:0";
      document.body.append(overlay);
    }, className);
    await waitVisible(false);
    await page.locator("#test-canvas-veil").evaluate(element => element.remove());
    await waitVisible(true);
  }
  const modalToggle = page.getByRole("button", { name: "测试弹窗", exact: true });
  await modalToggle.click();
  await waitVisible(false);
  const shrinkWhileModal = await page.addStyleTag({ content: ".source-browser-viewport { flex: 0 0 170px !important; }" });
  await sizeNotice.waitFor();
  await modalToggle.click();
  await page.getByRole("dialog").filter({ hasText: "对话框" }).waitFor({ state: "hidden" });
  assert.equal(await sizeNotice.isVisible(), true, "closing a modal leaves the viewport-size notice until the window grows");
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "resize_source_browser").at(-1).args.visible), false);
  await shrinkWhileModal.evaluate(style => style.remove());
  await waitVisible(true);
  await sizeNotice.waitFor({ state: "hidden" });
  const shrinkVisible = await page.addStyleTag({ content: ".source-browser-viewport { flex: 0 0 170px !important; }" });
  await sizeNotice.waitFor();
  await waitVisible(false);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "resize_source_browser").at(-1).args.bounds.height >= 180), true,
    "hiding an undersized view only sends valid native bounds");
  await shrinkVisible.evaluate(style => style.remove());
  await waitVisible(true);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "open_source_browser").length), 1);
  const beforeHistory = await hiddenCount();
  await page.getByTitle("通知", {exact:true}).click();
  await page.getByRole("dialog", {name:"通知历史"}).waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await hiddenCount(), beforeHistory, "notification history beside Explore keeps the webpage visible");
  const scans = await page.evaluate(async () => {
    const stage = document.createElement("div");
    stage.className = "canvas-stage";
    const card = stage.appendChild(document.createElement("div"));
    document.querySelector(".explore-main").append(stage);
    const querySelectorAll = Document.prototype.querySelectorAll;
    let scans = 0;
    Document.prototype.querySelectorAll = function (selector) {
      if (selector.includes(".external-drag-backdrop") && selector.includes('[role="listbox"]')) scans++;
      return querySelectorAll.call(this, selector);
    };
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
    try {
      await nextFrame();
      await nextFrame();
      scans = 0;
      for (let index = 0; index < 30; index++) {
        await nextFrame();
        stage.style.transform = `translateX(${index}px) scale(${1 + index / 100})`;
        card.classList.toggle("dragging");
        card.style.transform = `translateY(${index}px)`;
        card.appendChild(document.createElement("div")).remove();
      }
      await nextFrame();
      await nextFrame();
      return scans;
    } finally {
      Document.prototype.querySelectorAll = querySelectorAll;
      stage.remove();
    }
  });
  assert.equal(scans, 0, "canvas transform and child churn do not scan the document for overlays");
  console.log("PASS overlay avoidance, deferred and recovering small viewport, and no canvas-driven occlusion scans.");
} finally {
  await browser.close();
  await server.close();
}
