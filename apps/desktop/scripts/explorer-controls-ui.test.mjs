import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({
  cacheDir: ".tmp/explorer-controls-vite",
  server: { host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.goto(new URL("scripts/fixtures/explorer/preview.html", server.resolvedUrls.local[0]).href);

  const toggle = page.getByRole("button", { name: "探索", exact: true });
  const manage = page.getByRole("button", { name: "管理快捷站点", exact: true });
  const popover = page.getByRole("dialog", { name: "快捷站点", exact: true });
  const address = page.getByRole("combobox", { name: "网页地址", exact: true });
  const choices = page.getByRole("listbox", { name: "最近访问", exact: true });
  const shortcutNames = () => page.locator(".explore-site-links button").allTextContents();
  const waitVisible = visible => page.waitForFunction(expected =>
    window.calls.filter(call => call.command === "resize_source_browser").at(-1)?.args.visible === expected, visible);
  const emit = (event, payload) => page.evaluate(({ event, payload }) => {
    const listener = window.calls.find(call => call.command === "plugin:event|listen" && call.args.event === event);
    window.callbacks[listener.args.handler]({ event, payload });
  }, { event, payload });

  await toggle.click();
  await waitVisible(true);
  assert.deepEqual(await shortcutNames(), ["Pinterest", "花瓣", "小红书", "即梦"]);
  await manage.click();
  await popover.waitFor();
  assert.equal(await popover.getAttribute("aria-modal"), null, "the editor uses the workspace beside Explore");
  const name = popover.getByLabel("站点名称");
  const url = popover.getByLabel("站点地址");
  await name.fill("站酷");
  await url.fill("https://user:secret@zcool.com.cn/");
  await popover.getByRole("button", { name: "添加站点" }).click();
  await popover.getByRole("alert").filter({ hasText: "请输入有效的 HTTP 或 HTTPS 网页地址" }).waitFor();
  await url.fill("zcool.com.cn");
  await popover.getByRole("button", { name: "添加站点" }).click();
  await popover.getByRole("button", { name: "上移 站酷" }).click();
  await popover.getByRole("button", { name: "移除 小红书" }).click();
  assert.deepEqual(await shortcutNames(), ["Pinterest", "花瓣", "站酷", "即梦"]);
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "hidden" });
  assert.equal(await manage.evaluate(element => document.activeElement === element), true);

  await page.reload();
  await toggle.click();
  await waitVisible(true);
  assert.deepEqual(await shortcutNames(), ["Pinterest", "花瓣", "站酷", "即梦"], "reloading keeps customized shortcuts and order");
  await page.setViewportSize({ width: 760, height: 820 });
  await page.getByRole("separator", { name: "调整浏览器宽度" }).focus();
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.querySelector(".explore-browser").getBoundingClientRect().width === 320);
  const narrow = await page.locator(".explore-sites").evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return [...element.children].filter(child => !child.hidden).every(child => child.getBoundingClientRect().right <= bounds.right);
  });
  assert.equal(narrow, true, "shortcut scrolling leaves the fixed controls within the 320px panel");
  for (const label of ["浏览器插件", "采集视频"]) await page.getByRole("button", { name: label, exact: true }).waitFor();
  await manage.click();
  await popover.getByRole("button", { name: "恢复默认" }).click();
  assert.deepEqual(await shortcutNames(), ["Pinterest", "花瓣", "小红书", "即梦"]);
  await page.keyboard.press("Escape");

  const https = "https://www.pinterest.com/search/pins/?q=architecture";
  const http = "http://example.com/reference";
  await emit("source-browser://status", { url: https, loading: true });
  const progress = page.getByRole("progressbar", { name: "正在打开网页" });
  await progress.waitFor();
  await page.getByRole("img", { name: "HTTPS 加密连接" }).waitFor();
  await emit("source-browser://status", { url: https, loading: false });
  await progress.waitFor({ state: "hidden" });
  await emit("source-browser://location", http);
  await page.getByRole("img", { name: "HTTP 未加密连接" }).waitFor();
  await waitVisible(true);
  const focusCallStart = await page.evaluate(() => window.calls.length);
  await address.click();
  assert.equal(await address.getAttribute("aria-expanded"), "false", "clicking the address must not expand history");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(start => window.calls.slice(start).some(call =>
    call.command === "resize_source_browser" && call.args.visible === false), focusCallStart), false);
  await page.keyboard.press("ArrowDown");
  await choices.waitFor();
  await waitVisible(false);
  assert.equal(await choices.getByRole("option").count(), 2);
  await address.fill("architecture");
  assert.equal(await choices.getByRole("option").count(), 1, "typing reveals filtered history");
  await page.keyboard.press("ArrowDown");
  assert.equal(await choices.getByRole("option", { selected: true }).count(), 1);
  await page.keyboard.press("Enter");
  await page.waitForFunction(url => window.calls.some(call => call.command === "navigate_source_browser" && call.args.url === url), https);
  await choices.waitFor({ state: "hidden" });
  await waitVisible(true);
  await address.focus();
  await page.keyboard.press("ArrowDown");
  await choices.waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await choices.isVisible(), false, "Escape dismisses autocomplete while keeping Explore open");
  await waitVisible(true);

  await manage.click();
  await popover.waitFor();
  await page.waitForFunction(() => document.activeElement?.matches(".source-browser-popover"));
  await page.getByRole("textbox", { name: "主页面草稿" }).focus();
  await page.keyboard.press("Control+l");
  assert.equal(await address.evaluate(element => document.activeElement === element), true,
    "a non-modal popover does not block shortcuts outside its own focus");
  assert.equal(await address.getAttribute("aria-expanded"), "false", "the address shortcut only focuses the field");
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForFunction(() => window.calls.some(call => call.command === "source_browser_forward"));
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "hidden" });
  assert.equal(await manage.isVisible(), true, "Escape closes only the popover");

  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "source_browser_back") throw "other: 没有可返回的上一页";
      return invoke(command, args);
    };
  });
  await page.getByRole("button", { name: "返回上一页", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "没有可返回的上一页" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS shortcut customization and restart, narrow navigation, address completion, native history boundary and progress feedback.");
} finally {
  await browser.close();
  await server.close();
}
