import assert from "node:assert/strict";
import { dropData } from "./trusted-drag-fixture.mjs";
import { readFile } from "node:fs/promises";
import { chromium } from "../html-renderer/node_modules/playwright/index.mjs";

// Isolated browser only: every network request and desktop receipt is a fixture.
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.fulfill({
    contentType: route.request().url().endsWith(".svg") ? "image/svg+xml" : "text/html",
    body: route.request().url().endsWith(".svg")
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="green"/></svg>'
      : '<!doctype html><title>Extension isolated collection fixture</title><img id="remote" src="/remote.svg" alt="remote"><img id="blob" alt="blob"><img id="data" alt="data">',
  }));
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
    window.fixture = { messages: [], uploads: [], fetched: [], uploadProofs: 0, mode: "pending", callbacks: [] };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (url, options) => { window.fixture.fetched.push(url); return nativeFetch(url, options); };
    const nativeTimeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) => {
      if (delay === 110000) window.fixture.messageTimeout = fn;
      return nativeTimeout(fn, delay, ...args);
    };
    window.chrome = { runtime: {
      getURL: (path) => `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${path}`,
      getManifest: () => ({ version: "0.5.1" }),
      sendMessage: (message, callback) => {
        if (message.type === "button_position_get") { callback({position:null}); return; }
        if (message.type === "button_position_set") { callback({ok:true}); return; }
        if (message.type === "pairing_code_get") { callback({ok:true, code:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.fixture-public-key"}); return; }
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
  for (const name of ["candidate-utils.js", "collection-utils.js", "video-utils.js", "content.js"]) {
    await page.addScriptTag({ content: await readFile(new URL(name, import.meta.url), "utf8") });
  }
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
  assert.match(await menu.innerText(), /采集本页图片[\s\S]*采集本页视频[\s\S]*设置/);
  await page.keyboard.press("Escape");
  assert.equal(await menu.count(), 0);
  assert.equal(await button.evaluate(el => document.activeElement === el), true);
  await page.keyboard.press("Enter");
  await menu.waitFor();
  await menu.getByRole("menuitem", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Bowerbird 设置" });
  await settings.waitFor();
  await page.waitForFunction(() => document.getElementById("__bowerbird_pairing_code")?.textContent.includes("fixture-public-key"));
  await settings.getByRole("button", { name: "复制配对码", exact: true }).click();
  await settings.getByText("已复制配对码").waitFor();
  assert.match(await settings.innerText(), /v0\.5\.1/);
  await page.keyboard.press("Escape");
  assert.equal(await settings.count(), 0);
  assert.equal(await button.evaluate(el => document.activeElement === el), true);
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
  await page.waitForFunction(() => document.getElementById("__bowerbird_toast")?.textContent.includes("采集结束"));
  assert.match(await status.innerText(), /已保存 2 张，失败 1 张/);
  assert.doesNotMatch(await status.innerText(), /private|token|HTTP/);
  assert.equal(await page.evaluate(() => window.fixture.fetched.length), 2);
  assert.deepEqual(await page.evaluate(() => window.fixture.uploads.map((m) => [m.type, m.page_url, m.byteLength > 0])), [
    ["save_blob", "https://fixture.example/page", true], ["save_blob", "https://fixture.example/page", true],
  ]);

  // A mixed drag must keep all items, instead of stopping at its first local URL.
  const html = await page.evaluate(() => {
    window.fixture.mode = "success";
    window.fixture.messages = []; window.fixture.uploads = [];
    return ["remote", "blob", "data"].map((id) => `<img src="${document.getElementById(id).src}">`).join("");
  });
  await dropData(page, button, {"text/html": html});
  await page.waitForFunction(() => document.getElementById("__bowerbird_toast")?.textContent.includes("已保存 3 张（共 3 张）"));
  assert.equal(await page.evaluate(() => window.fixture.messages.length), 1);
  assert.equal(await page.evaluate(() => window.fixture.uploads.length), 2);

  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    document.body.append(canvas);
  });
  await page.locator("canvas").click({modifiers:["Alt"]});
  await page.waitForFunction(() => window.fixture.uploads.some((m) => m.candidate_source === "canvas"));
  await page.waitForFunction(() => document.querySelector('[aria-label="Bowerbird 采集菜单"]').disabled === false);

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
  await page.waitForFunction(() => document.querySelector('[aria-label="Bowerbird 采集菜单"]').disabled === false);

  // No wall-clock wait: trigger the real content message deadline through the fixture timer.
  await page.evaluate(() => { window.fixture.mode = "pending"; });
  await page.locator("#remote").click({modifiers:["Alt"]});
  await page.evaluate(() => window.fixture.messageTimeout());
  await page.waitForFunction(() => document.getElementById("__bowerbird_toast")?.textContent.includes("待确认 1 张"));
  assert.match(await status.innerText(), /先查看桌面素材库，不要重复采集/);
  assert.doesNotMatch(await status.innerText(), /失败 1 张/);

  await page.waitForFunction(() => document.querySelector('[aria-label="Bowerbird 采集菜单"]').disabled === false);
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
  await page.waitForFunction(() => document.querySelector('[aria-label="Bowerbird 采集菜单"]').getBoundingClientRect().left >= -1);
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

  assert.deepEqual(errors, []);
  console.log("PASS: isolated Chromium content integration (menu, keyboard confirmation, HTTP/blob/data, mixed drop, canvas, covered-image Alt, busy guard, partial success, unknown timeout, drag/dock/collapse)");
} finally {
  await browser.close();
}
