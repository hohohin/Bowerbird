import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
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
  await page.getByRole("dialog", { name: "新通知" }).waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await hiddenCount(), initialCount);
  const dialog = page.getByRole("button", { name: "测试弹窗" });
  await dialog.click();
  await waitVisible(false);
  await dialog.click();
  await waitVisible(true);
  console.log("PASS incoming notification keeps Explore visible, and a deliberate dialog still suspends and restores it.");
} finally {
  await browser.close();
  await server.close();
}
