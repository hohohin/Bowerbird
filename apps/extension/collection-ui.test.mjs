import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "../html-renderer/node_modules/playwright/index.mjs";

// Isolated browser only: every network request and desktop receipt is a fixture.
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.fulfill({
    contentType: route.request().url().endsWith("remote.svg") ? "image/svg+xml" : "text/html",
    body: route.request().url().endsWith("remote.svg")
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="green"/></svg>'
      : '<!doctype html><title>Extension isolated collection fixture</title><img id="remote" src="/remote.svg" alt="remote"><img id="blob" alt="blob"><img id="data" alt="data">',
  }));
  await page.goto("https://fixture.example/page");
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    canvas.getContext("2d").fillRect(0, 0, 64, 64);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    document.getElementById("blob").src = URL.createObjectURL(blob);
    document.getElementById("data").src = canvas.toDataURL();
    await Promise.all(Array.from(document.images).map((image) => image.decode()));
    window.fixture = { messages: [], uploads: [], fetched: [], mode: "pending", callbacks: [] };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (url, options) => { window.fixture.fetched.push(url); return nativeFetch(url, options); };
    const nativeTimeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) => {
      if (delay === 110000) window.fixture.messageTimeout = fn;
      return nativeTimeout(fn, delay, ...args);
    };
    window.chrome = { runtime: {
      getURL: (path) => `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${path}`,
      sendMessage: (message, callback) => {
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
  for (const name of ["candidate-utils.js", "collection-utils.js", "content.js"]) {
    await page.addScriptTag({ content: await readFile(new URL(name, import.meta.url), "utf8") });
  }
  const button = page.getByRole("button", { name: "采集网页图片", exact: true });
  const status = page.locator("#__bowerbird_toast");
  await button.focus();
  await page.keyboard.press("Enter");
  assert.match(await page.locator("#__bowerbird_confirm").innerText(), /发现 3 张图片/);
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
  await button.evaluate((element) => {
    window.fixture.mode = "success";
    window.fixture.messages = []; window.fixture.uploads = [];
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/html", ["remote", "blob", "data"].map((id) => `<img src="${document.getElementById(id).src}">`).join(""));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  });
  await page.waitForFunction(() => document.getElementById("__bowerbird_toast")?.textContent.includes("已保存 3 张（共 3 张）"));
  assert.equal(await page.evaluate(() => window.fixture.messages.length), 1);
  assert.equal(await page.evaluate(() => window.fixture.uploads.length), 2);

  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    document.body.append(canvas);
    canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
  });
  await page.waitForFunction(() => window.fixture.uploads.some((m) => m.candidate_source === "canvas"));
  await page.waitForFunction(() => document.querySelector('[aria-label="采集网页图片"]').disabled === false);

  // No wall-clock wait: trigger the real content message deadline through the fixture timer.
  await page.evaluate(() => {
    window.fixture.mode = "pending";
    document.getElementById("remote").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
    window.fixture.messageTimeout();
  });
  await page.waitForFunction(() => document.getElementById("__bowerbird_toast")?.textContent.includes("待确认 1 张"));
  assert.match(await status.innerText(), /先查看桌面素材库，不要重复采集/);
  assert.doesNotMatch(await status.innerText(), /失败 1 张/);
  assert.deepEqual(errors, []);
  console.log("PASS: isolated Chromium content integration (keyboard confirmation, HTTP/blob/data, mixed drop, canvas, busy guard, partial success, unknown timeout)");
} finally {
  await browser.close();
}
