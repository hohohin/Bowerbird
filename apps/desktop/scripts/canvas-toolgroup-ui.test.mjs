import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
import { enableCanvasToolbarPro } from "./fixtures/canvas-reference/place-card.mjs";

const server = await createServer({ cacheDir: ".tmp/canvas-toolgroup-ui-vite", server: { host: "127.0.0.1", port: 1453, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(6500);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + "scripts/fixtures/canvas-reference/preview.html", { timeout: 60000 });
  const toolbar = page.getByRole("toolbar", { name: "画板工具" });
  await toolbar.waitFor();
  assert.equal(await toolbar.locator(":scope > button").count(), 6, "The toolbar has exactly six top-level buttons");
  assert.equal(await toolbar.locator("hr").count(), 1);
  const group = name => toolbar.locator('[data-canvas-tool-group="' + name + '"]');
  const menu = page.getByRole("menu", { name: "工作流工具" });
  const workflow = group("workflow");
  await workflow.focus();
  await page.keyboard.press("ArrowRight");
  const agent = menu.getByRole("menuitem", { name: "Agent 卡片" });
  await agent.waitFor();
  assert.equal(await agent.locator("svg.agent-card-icon path").getAttribute("fill"), "#1296db");
  const shortcut = await agent.locator("kbd").boundingBox();
  const badge = await agent.locator(".canvas-tool-pro-badge").boundingBox();
  assert.ok(shortcut.x + shortcut.width <= badge.x, "B is left of PRO");
  await page.keyboard.press("Escape");
  assert.equal(await workflow.evaluate(button => button === document.activeElement), true);
  await page.keyboard.press("a");
  await page.keyboard.press("b");
  const upgrade = page.getByRole("dialog", { name: "解锁 Pro" });
  await upgrade.waitFor();
  assert.equal(await upgrade.getByText("已有结果仍可查看和导出").count(), 1);
  await page.keyboard.press("Escape");
  await upgrade.waitFor({ state: "hidden" });
  assert.equal(await toolbar.getByRole("button", { name: "抓手工具" }).getAttribute("aria-pressed"), "true");
  const originalAccount = await page.evaluate(() => {
    const { cloudAuth, cloudEntitlement } = window.store.getState();
    return { cloudAuth, cloudEntitlement };
  });
  await enableCanvasToolbarPro(page);
  await page.keyboard.press("b");
  assert.equal(await workflow.getAttribute("aria-pressed"), "true");
  await page.evaluate(account => window.store.setState(account), originalAccount);
  await page.waitForFunction(() => {
    const slot = document.querySelector('[data-canvas-tool-group="workflow"]');
    return slot?.getAttribute("aria-label") === "Agent 卡片" && slot.getAttribute("aria-pressed") === "false"
      && !!slot.querySelector(".canvas-tool-pro-badge");
  });

  const content = group("content");
  const contentMenu = page.getByRole("menu", { name: "基础内容工具" });
  const epoch = Date.UTC(2026, 0, 1);
  await page.clock.install({ time: epoch });
  await page.clock.pauseAt(epoch + 5000);
  const bounds = await content.boundingBox();
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.clock.runFor(109);
  assert.equal(await contentMenu.count(), 0);
  await page.mouse.up();
  assert.equal(await content.getAttribute("aria-pressed"), "true");
  await page.mouse.down();
  await page.clock.runFor(110);
  assert.equal(await contentMenu.count(), 1);
  const text = await contentMenu.getByRole("menuitem", { name: "文本卡片" }).boundingBox();
  await page.mouse.move(text.x + 50, text.y + text.height / 2, { steps: 4 });
  await page.mouse.up();
  assert.equal(await contentMenu.count(), 0);
  assert.equal(await content.getAttribute("data-tip"), "文本卡片");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.clock.runFor(110);
  assert.equal(await contentMenu.count(), 1);
  await content.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse" });
  assert.equal(await contentMenu.count(), 0);
  await page.mouse.up();
  await page.reload({ timeout: 60000 });
  assert.equal(await group("content").getAttribute("data-tip"), "文本卡片");
  assert.deepEqual(errors, []);
  console.log("PASS six slots, Agent SVG and shortcut order, paywall and focus, 109/110ms, slide release, tool memory");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
