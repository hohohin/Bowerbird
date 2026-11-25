import assert from "node:assert/strict";
import { dropData } from "./trusted-drag-fixture.mjs";
import { injectContent } from "./isolated-content-fixture.mjs";
import { chromium } from "../html-renderer/node_modules/playwright/index.mjs";

// Isolated browser only: every network request and desktop receipt is a fixture.
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(".svg")) {
      if (path === "/selection-unavailable.svg") return route.fulfill({ status: 404, body: "" });
      const width = ["/selection-narrow.svg", "/selection-placeholder.svg"].includes(path) ? 100 : path.startsWith("/selection-") ? 320 : 64;
      const height = path === "/selection-short.svg" ? 100 : path.startsWith("/selection-") ? 240 : 64;
      return route.fulfill({
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="green"/></svg>`,
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><title>Extension isolated collection fixture</title><img id="remote" src="/remote.svg" alt="remote"><img id="blob" alt="blob"><img id="data" alt="data">',
    });
  });
  await page.goto("https://fixture.example/page");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://fixture.example" });
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    canvas.getContext("2d").fillRect(0, 0, 64, 64);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    document.getElementById("blob").src = URL.createObjectURL(blob);
    document.getElementById("data").src = canvas.toDataURL();
    await Promise.all(Array.from(document.images).map((image) => image.decode()));
    window.fixture = {
      messages: [], uploads: [], fetched: [], uploadProofs: 0, mode: "pending", callbacks: [], hidden: false,
      pairingCode: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.fixture-public-key",
    };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (url, options) => { window.fixture.fetched.push(url); return nativeFetch(url, options); };
    const nativeTimeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) => {
      if (delay === 110000) window.fixture.messageTimeout = fn;
      return nativeTimeout(fn, delay, ...args);
    };
    window.chrome = { runtime: {
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      onMessage: { addListener: (listener) => { window.fixture.action = () => listener({type:"bowerbird_toolbar_action"}, {id:window.chrome.runtime.id}); } },
      getURL: (path) => `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${path}`,
      getManifest: () => ({ version: "0.5.1" }),
      sendMessage: (message, callback) => {
        if (message.type === "current_project") { callback({ok:true,name:"春季画册"}); return; }
        if (message.type === "site_visibility_get") { callback({ok:true,hidden:window.fixture.hidden}); return; }
        if (message.type === "site_visibility_set") { window.fixture.hidden = message.hidden; callback({ok:true,hidden:message.hidden}); return; }
        if (message.type === "open_pairing_options") { window.fixture.optionsOpened = true; callback({ok:true}); return; }
        if (message.type === "button_position_get") { callback({position:null}); return; }
        if (message.type === "button_position_set") { window.fixture.position = message.position; callback({ok:true}); return; }
        if (message.type === "pairing_code_get") { callback({ok:true,code:window.fixture.pairingCode}); return; }
        if (message.type === "collect_access" || message.type === "collect_heartbeat") {
          if (message.type === "collect_access") window.fixture.uploadProofs++;
          callback({ok:true,protocols:["bowerbird-v1","fixture"]}); return;
        }
        window.fixture.messages.push(message);
        if (window.fixture.mode === "pending") window.fixture.callbacks.push(callback);
        else callback({ ok: true });
      },
    } };
    window.WebSocket = class {
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(value) {
        if (typeof value === "string") {
          this.metadata = JSON.parse(value);
          if (this.metadata.type === "ping") queueMicrotask(() => this.onmessage?.({ data: '{"ok":true,"pong":true}' }));
        } else {
          window.fixture.uploads.push({ ...this.metadata, byteLength: value.byteLength });
          queueMicrotask(() => this.onmessage?.({ data: '{"ok":true,"asset_id":"fixture"}' }));
        }
      }
      close() { this.onclose?.(); }
    };
  });
  await page.addStyleTag({ content: "* {font-size:80px!important;color:#f0f!important;font-family:monospace!important} button {all:unset!important}" });
  await injectContent(page);
  const button = page.getByRole("button", { name: "Bowerbird 采集菜单", exact: true });
  const menu = page.getByRole("menu", { name: "Bowerbird 菜单" });
  const status = page.locator("#__bowerbird_toast");
  await button.evaluate(element => element.click());
  assert.equal(await menu.count(), 0);
  await page.locator("#blob").dispatchEvent("click", {altKey:true});
  await button.dispatchEvent("drop", {});
  assert.equal(await page.locator("#__bowerbird_confirm").count(), 0);
  await button.focus();
  await page.keyboard.press("Enter");
  await menu.waitFor();
  assert.equal(await menu.evaluate(el => getComputedStyle(el).fontSize), "13px");
  assert.equal(await button.evaluate(el => getComputedStyle(el).position), "fixed");
  assert.equal(await button.evaluate(el => getComputedStyle(el).backgroundColor), "rgb(11, 16, 38)");
  const cdp = await page.context().newCDPSession(page);
  const {nodes} = await cdp.send("Accessibility.getFullAXTree");
  assert.ok(nodes.some(node => node.name?.value === "当前项目：春季画册"));
  await cdp.detach();
  assert.match(await menu.innerText(), /采集本页图片[\s\S]*采集本页视频[\s\S]*设置/);
  await page.keyboard.press("Escape");
  assert.equal(await menu.count(), 0);
  assert.equal(await button.evaluate(el => el.getRootNode().activeElement === el), true);
  await page.keyboard.press("Enter");
  await menu.waitFor();
  await menu.getByRole("menuitem", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Bowerbird 设置" });
  await settings.waitFor();
  assert.equal(await settings.evaluate(el => getComputedStyle(el).fontSize), "13px");
  await page.waitForFunction(() => document.getElementById("__bowerbird_overlay").shadowRoot.getElementById("__bowerbird_pairing_code")?.textContent.includes("fixture-public-key"));
  await settings.getByRole("button", { name: "打开完整选项页", exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.optionsOpened), true);
  await page.evaluate(() => {
    const rect = document.getElementById("__bowerbird_overlay").shadowRoot.getElementById("__bowerbird_settings").getBoundingClientRect();
    const image = document.createElement("img");
    image.id = "under-settings";
    image.src = "/remote.svg";
    image.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;z-index:999`;
    document.body.append(image);
  });
  await settings.getByText("设置", { exact: true }).click({ modifiers: ["Alt"] });
  assert.equal(await page.evaluate(() => window.fixture.messages.length), 0, "Alt-click inside settings must never capture the image beneath");
  await page.locator("#under-settings").evaluate(el => el.remove());
  await page.evaluate(() => { window.fixture.pairingCode += "-rotated"; });
  await settings.getByRole("button", { name: "复制配对码", exact: true }).click();
  await settings.getByText("已复制配对码").waitFor();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /fixture-public-key-rotated$/);
  assert.match(await settings.innerText(), /v0\.5\.1/);
  await page.keyboard.press("Escape");
  assert.equal(await settings.count(), 0);
  assert.equal(await button.evaluate(el => el.getRootNode().activeElement === el), true);
  await page.keyboard.press("Enter");
  await menu.waitFor();
  await menu.getByRole("menuitem", { name: "采集本页图片", exact: true }).click();
  assert.equal(await menu.count(), 0);
  assert.match(await page.locator("#__bowerbird_confirm").innerText(), /发现 3 张图片/);
  await page.getByRole("button", { name: "采集", exact: true }).evaluate(el => el.click());
  assert.deepEqual(await page.evaluate(() => [fixture.messages.length, fixture.uploads.length, fixture.fetched.length, fixture.uploadProofs]), [0, 0, 0, 0]);
  await page.getByRole("button", { name: "采集", exact: true }).click();
  await page.waitForFunction(() => window.fixture.messages.length === 1);
  assert.equal(await button.isDisabled(), true);
  assert.match(await status.innerText(), /采集中 0\/3/);
  await button.evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/html", '<img src="https://fixture.example/extra.svg">');
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    document.getElementById("remote").dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
  });
  assert.equal(await page.evaluate(() => window.fixture.messages.length), 1);
  await page.evaluate(() => window.fixture.callbacks.shift()({ ok: false, error: "HTTP 403 https://private.test/token" }));
  await page.waitForFunction(() => document.getElementById("__bowerbird_overlay").shadowRoot.getElementById("__bowerbird_toast")?.textContent.includes("采集结束"));
  assert.match(await status.innerText(), /已保存 2 张，失败 1 张/);
  assert.doesNotMatch(await status.innerText(), /private|token|HTTP/);
  assert.equal(await page.evaluate(() => window.fixture.fetched.length), 2);
  assert.deepEqual(await page.evaluate(() => window.fixture.uploads.map((m) => [m.type, m.page_url, m.byteLength > 0])), [
    ["save_blob", "https://fixture.example/page", true], ["save_blob", "https://fixture.example/page", true],
  ]);
  await page.evaluate(() => { window.fixture.mode = "success"; });
  await status.getByRole("button", { name: "重试失败项（1）" }).click();
  await status.filter({ hasText: /已保存 1 张（共 1 张）/ }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixture.messages.map(item => item.url)), [
    "https://fixture.example/remote.svg", "https://fixture.example/remote.svg",
  ]);
  assert.equal(await page.evaluate(() => window.fixture.uploads.length), 2);

  // A mixed drag must keep all items, instead of stopping at its first local URL.
  const html = await page.evaluate(() => {
    window.fixture.mode = "success";
    window.fixture.messages = []; window.fixture.uploads = [];
    return ["remote", "blob", "data"].map((id) => `<img src="${document.getElementById(id).src}">`).join("");
  });
  await dropData(page, button, {"text/html": html});
  await page.waitForFunction(() => document.getElementById("__bowerbird_overlay").shadowRoot.getElementById("__bowerbird_toast")?.textContent.includes("已保存 3 张（共 3 张）"));
  assert.equal(await page.evaluate(() => window.fixture.messages.length), 1);
  assert.equal(await page.evaluate(() => window.fixture.uploads.length), 2);

  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    document.body.append(canvas);
  });
  await page.locator("canvas").click({modifiers:["Alt"]});
  await page.waitForFunction(() => window.fixture.uploads.some((m) => m.candidate_source === "canvas"));
  await page.waitForFunction(() => document.getElementById("__bowerbird_overlay").shadowRoot.querySelector('[aria-label="Bowerbird 采集菜单"]').disabled === false);

  // Instagram-style transparent overlay: the visible IMG is pointer-events:none, so the
  // click target's composed path has no IMG. Alt+click must still find the image below it.
  await page.evaluate(async () => {
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "position:fixed;left:220px;top:430px;width:120px;height:120px;z-index:5";
    const covered = document.createElement("img");
    covered.id = "covered";
    covered.src = "/remote.svg";
    covered.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
    const overlay = document.createElement("div");
    overlay.id = "overlay";
    overlay.style.cssText = "position:absolute;inset:0;background:transparent";
    wrapper.append(covered, overlay);
    document.body.append(wrapper);
    await covered.decode().catch(() => {});
    window.fixture.mode = "success";
    window.fixture.messages = [];
  });
  await page.locator("#overlay").click({modifiers:["Alt"]});
  await page.waitForFunction(() => window.fixture.messages.length === 1);
  assert.deepEqual(await page.evaluate(() => [window.fixture.messages[0].type, window.fixture.messages[0].url, window.fixture.messages[0].pageUrl]), [
    "save_image", "https://fixture.example/remote.svg", "https://fixture.example/page",
  ]);
  await page.waitForFunction(() => document.getElementById("__bowerbird_overlay").shadowRoot.querySelector('[aria-label="Bowerbird 采集菜单"]').disabled === false);
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "page-shadow";
    const covered = document.getElementById("covered");
    const wrapper = covered.parentElement;
    document.body.append(host);
    host.attachShadow({ mode: "open" }).append(wrapper);
    window.fixture.messages = [];
  });
  await page.locator("#page-shadow #overlay").click({ modifiers: ["Alt"] });
  await page.waitForFunction(() => window.fixture.messages.length === 1);
  assert.equal(await page.evaluate(() => window.fixture.messages[0].url), "https://fixture.example/remote.svg");
  await page.locator("#page-shadow").evaluate(el => el.remove());

  // No wall-clock wait: trigger the real content message deadline through the fixture timer.
  await page.evaluate(() => { window.fixture.mode = "pending"; });
  await page.locator("#remote").click({modifiers:["Alt"]});
  await page.evaluate(() => window.fixture.messageTimeout());
  await page.waitForFunction(() => document.getElementById("__bowerbird_overlay").shadowRoot.getElementById("__bowerbird_toast")?.textContent.includes("待确认 1 张"));
  assert.match(await status.innerText(), /先查看桌面素材库，不要重复采集/);
  assert.doesNotMatch(await status.innerText(), /失败 1 张/);
  assert.equal(await status.getByRole("button", { name: /重试/ }).count(), 0);

  await page.evaluate(() => { window.fixture.callbacks = []; window.fixture.messages = []; });
  await dropData(page, button, { "text/html": '<img src="https://fixture.example/first.svg"><img src="https://fixture.example/second.svg">' });
  await page.waitForFunction(() => window.fixture.callbacks.length === 1);
  await status.getByRole("button", { name: "停止", exact: true }).click();
  await page.evaluate(() => window.fixture.callbacks.shift()({ ok: true }));
  await status.filter({ hasText: /已停止采集.*1 张未采集/ }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixture.messages.map(item => item.url)), ["https://fixture.example/first.svg"]);

  await page.waitForFunction(() => document.getElementById("__bowerbird_overlay").shadowRoot.querySelector('[aria-label="Bowerbird 采集菜单"]').disabled === false);
  const initial = await button.boundingBox();
  assert.ok(initial.x > 700 && initial.y > 500, "default entry stays bottom-right");
  await page.mouse.move(initial.x + 24, initial.y + 24);
  await page.mouse.down();
  await page.mouse.move(20, 150, { steps: 12 });
  await page.mouse.up();
  const docked = await button.boundingBox();
  assert.ok(docked.x <= 1, `expected left edge dock, got ${docked.x}`);
  assert.ok(Math.abs(docked.y - 126) < 3, `expected free vertical position, got ${docked.y}`);
  assert.equal(await menu.count(), 0);
  await page.mouse.move(500, 500);
  await page.waitForTimeout(1400);
  const folded = await button.boundingBox();
  assert.ok(folded.x < 0, `expected collapsed entry, got ${folded.x}`);
  assert.ok(folded.x + folded.width >= 10, "a reachable sliver must stay on screen");
  await page.mouse.move(4, folded.y + 20);
  await page.waitForFunction(() => document.getElementById("__bowerbird_overlay").shadowRoot.querySelector('[aria-label="Bowerbird 采集菜单"]').getBoundingClientRect().left >= -1);
  const expanded = await button.boundingBox();
  await page.mouse.move(expanded.x + 24, expanded.y + 24);
  await page.mouse.down();
  await page.mouse.move(400, 300, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const free = await button.boundingBox();
  assert.ok(Math.abs(free.x - 376) < 3 && Math.abs(free.y - 276) < 3, `expected undocked position, got ${free.x},${free.y}`);
  await page.mouse.move(600, 500);
  await page.waitForTimeout(1400);
  const stillFree = await button.boundingBox();
  assert.ok(Math.abs(stillFree.x - free.x) < 1 && Math.abs(stillFree.y - free.y) < 1, "an undocked entry must stay visible");
  const position = await page.evaluate(() => window.fixture.position);
  await page.setViewportSize({ width: 900, height: 950 });
  await page.waitForFunction(y => {
    const entry = document.getElementById("__bowerbird_overlay").shadowRoot.querySelector('[aria-label="Bowerbird 采集菜单"]');
    return Math.abs(entry.getBoundingClientRect().top - y) < 2;
  }, position.yRatio * (950 - 48));
  const resized = await button.boundingBox();
  assert.ok(Math.abs(resized.y - position.yRatio * (950 - 48)) < 2);
  await page.setViewportSize({ width: 900, height: 650 });
  await button.click();
  await menu.waitFor();
  await menu.getByRole("menuitem", { name: "设置", exact: true }).click();
  await settings.waitFor();
  await settings.getByRole("button", { name: "恢复默认位置", exact: true }).click();
  await settings.getByText("已恢复默认位置").waitFor();
  const reset = await button.boundingBox();
  assert.ok(reset.x > 800 && reset.y > 550, `expected default position, got ${reset.x},${reset.y}`);
  await page.keyboard.press("Escape");
  assert.equal(await settings.count(), 0);
  await button.click();
  await menu.getByRole("menuitem", { name: "设置", exact: true }).click();
  await settings.getByRole("checkbox", { name: "在当前网站隐藏悬浮按钮" }).click();
  await button.waitFor({state:"hidden"});
  assert.equal(await page.evaluate(() => window.fixture.hidden), true);
  await page.evaluate(() => window.fixture.action());
  await button.waitFor();
  assert.equal(await page.evaluate(() => window.fixture.hidden), false);
  await page.evaluate(() => window.fixture.action());
  await menu.waitFor();

  async function installCaptureRecorder() {
    await page.evaluate(() => {
      window.captures = [];
      window.chrome = { runtime: {
        getURL: () => "",
        sendMessage: (message, callback) => {
          if (message.type === "save_image") window.captures.push(message);
          callback({ ok: true });
        },
      } };
    });
    await injectContent(page);
  }

  const picker = page.getByRole("dialog", { name: "选择要采集的图片" });
  async function openImagePicker() {
    await button.click();
    await menu.getByRole("menuitem", { name: "采集本页图片", exact: true }).click();
    await picker.waitFor();
  }

  const selectionUrl = "https://fixture.example/selection";
  await page.route(selectionUrl, route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><img src="/selection-a.svg" alt=""><img src="/selection-narrow.svg" alt=""><img src="/selection-b.svg" alt=""><img src="/selection-short.svg" alt=""><img src="/selection-placeholder.svg" data-src="/selection-c.svg" alt=""><img src="/selection-placeholder.svg" data-src="/selection-unavailable.svg" alt="">',
  }));
  await page.setViewportSize({ width: 375, height: 650 });
  await page.goto(selectionUrl);
  await page.evaluate(() => Promise.all(Array.from(document.images).map(image => image.decode())));
  await installCaptureRecorder();
  await openImagePicker();
  assert.equal(await picker.evaluate(el => el.getRootNode().activeElement === el), true);
  const choose = picker.getByRole("button", { name: "采集", exact: true });
  const filter = picker.getByRole("checkbox", { name: "过滤小图", exact: true });
  const counts = picker.getByRole("status");
  const item = name => picker.locator(`label:has(img[src$="/selection-${name}.svg"]) input`);
  assert.equal(await counts.textContent(), "已选 6 / 6");
  await item("a").evaluate(el => el.click());
  assert.equal(await item("a").isChecked(), true, "a scripted checkbox activation cannot change selection");
  await choose.evaluate(el => el.click());
  assert.equal(await page.evaluate(() => window.captures.length), 0);
  await picker.getByRole("button", { name: "取消", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  assert.equal(await button.evaluate(el => el.getRootNode().activeElement === el), true);
  await openImagePicker();
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "hidden" });
  assert.equal(await button.evaluate(el => el.getRootNode().activeElement === el), true);
  assert.equal(await page.evaluate(() => window.captures.length), 0);

  await openImagePicker();
  await picker.getByRole("button", { name: "全不选", exact: true }).click();
  assert.equal(await counts.textContent(), "已选 0 / 6");
  assert.equal(await choose.isDisabled(), true);
  await picker.getByRole("button", { name: "全选", exact: true }).click();
  await filter.check();
  assert.equal(await item("narrow").isVisible(), false, "width below 200px is small");
  assert.equal(await item("short").isVisible(), false, "height below 200px is small");
  const fullPreview = picker.locator('img[src$="/selection-c.svg"]');
  await fullPreview.evaluate(image => image.decode());
  assert.equal(await fullPreview.evaluate(image => image.naturalWidth), 320);
  assert.equal(await item("c").isVisible(), true, "use actual preview dimensions instead of the small placeholder");
  assert.equal(await item("unavailable").isVisible(), true, "keep an alternate image with unknown dimensions");
  assert.equal(await counts.textContent(), "已选 4 / 4");
  await item("b").uncheck();
  await item("unavailable").uncheck();
  await filter.uncheck();
  assert.equal(await counts.textContent(), "已选 4 / 6");
  await filter.check();
  assert.equal(await item("b").isChecked(), false);
  assert.equal(await counts.textContent(), "已选 2 / 4");
  assert.equal(await page.evaluate(() => window.captures.length), 0);
  await choose.click();
  await status.filter({ hasText: /已保存 2 张（共 2 张）/ }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.captures.map(item => [item.url, item.pageUrl])), [
    ["https://fixture.example/selection-a.svg", selectionUrl],
    ["https://fixture.example/selection-c.svg", selectionUrl],
  ]);

  const noteUrl = "https://www.xiaohongshu.com/explore/fixture-note";
  const images = Array.from({ length: 105 }, (_, index) => ({ urlDefault: `https://cdn.fixture.example/${index}.svg` }));
  const state = { note: { noteDetailMap: { "fixture-note": { note: { title: "图文夹具", imageList: images } } } } };
  await page.route(noteUrl, route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>`,
  }));
  await page.setViewportSize({ width: 900, height: 650 });
  await page.goto(noteUrl);
  await installCaptureRecorder();
  await openImagePicker();
  assert.match(await picker.innerText(), /发现 105 张图片，本次最多采集前 100 张/);
  assert.equal(await picker.getByRole("status").textContent(), "已选 100 / 100");
  assert.equal(await page.evaluate(() => window.captures.length), 0);
  await choose.click();
  await status.filter({ hasText: /已保存 100 张/ }).waitFor();
  const captures = await page.evaluate(() => window.captures.map(item => [item.url, item.pageUrl]));
  assert.deepEqual(captures, images.slice(0,100).map(item => [item.urlDefault, noteUrl]));

  assert.deepEqual(errors, []);
  console.log("PASS: isolated Chromium image picker and selection, hostile CSS, Shadow DOM Alt-click, stop/retry, hostname settings, proportional position, ordered XHS limit");
} finally {
  await browser.close();
}
