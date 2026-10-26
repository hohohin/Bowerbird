import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

function runtime(extra = {}) {
  let id = 0;
  const timers = new Map();
  const context = vm.createContext({
    URL, TextDecoder, Uint8Array, ArrayBuffer, AbortController, console,
    setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    clearTimeout: (key) => timers.delete(key),
    setInterval: () => 0,
    ...extra,
  });
  vm.runInContext(source("collection-utils.js"), context);
  return { context, api: context.BowerbirdCollection, timers };
}

test("HTTP, blob and data items use their owning context and retain order/source URLs", async () => {
  const { api } = runtime();
  const called = [];
  const items = ["https://cdn.test/a.jpg", "blob:https://site.test/a", "data:image/png;base64,AA=="]
    .map((media_url, index) => ({ media_url, source_url: `https://site.test/note/${index}` }));
  const progress = [];
  const record = (route) => async (item) => { called.push([route, item.media_url, item.source_url]); return { ok: true }; };
  const result = await api.runBatch(items, { remote: record("background"), local: record("page") }, (p) => progress.push(p.completed));
  assert.deepEqual(called.map((entry) => entry[0]), ["background", "page", "page"]);
  assert.deepEqual(called.map((entry) => entry[2]), items.map((item) => item.source_url));
  assert.deepEqual(progress, [0, 1, 2, 3]);
  assert.equal(result.saved, 3);
});

test("partial failures and missing receipts are counted separately without automatic retries", async () => {
  const { api } = runtime();
  const replies = [{ ok: true }, { ok: false, error: "HTTP 403 https://private.test/token" }, { ok: false, code: "result_unknown" }];
  let calls = 0;
  const result = await api.runBatch(replies.map(() => ({ media_url: "https://cdn.test/a" })), {
    remote: async () => replies[calls++],
  });
  assert.equal(calls, 3);
  assert.equal(result.saved, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.unconfirmed, 1);
  assert.match(api.progressMessage(result, true), /已保存 1 张，失败 1 张，待确认 1 张/);
  assert.match(api.progressMessage(result, true), /先查看桌面素材库，不要重复采集/);
  assert.doesNotMatch(api.progressMessage(result, true), /private|token/);
});

test("all batch paths cap at 100 and XHS selection/source records are preserved", async () => {
  const { api } = runtime();
  const items = Array.from({ length: 120 }, (_, index) => ({ media_url: `https://cdn.test/${index}`, source_url: `https://www.xiaohongshu.com/explore/${index}` }));
  const batch = api.limitBatch({ source_site: "xiaohongshu", label: "封面", items });
  assert.equal(batch.items.length, 100);
  assert.equal(batch.items[99], items[99]);
  assert.match(batch.label, /120.*100/);
  let calls = 0;
  const result = await api.runBatch(items, { remote: async () => { calls += 1; return { ok: true }; } });
  assert.equal(result.total, 100);
  assert.equal(calls, 100);
});

test("user error messages never echo raw URL, path or upstream response", () => {
  const { api } = runtime();
  for (const error of ["Error C:\\Users\\person\\secret.png", "HTTP 403 https://private.test/key", '{"error":"upstream diagnostic"}']) {
    const message = api.failureMessage({ error });
    assert.doesNotMatch(message, /private|secret|upstream|HTTP|C:/);
    assert.match(message, /请/);
  }
});

test("background response deadline includes fetch and desktop upload; late reply cannot overwrite timeout", async () => {
  let callback;
  const { api, timers } = runtime({ chrome: { runtime: { sendMessage: (_message, cb) => { callback = cb; } } } });
  const pending = api.requestBackground({ media_url: "https://cdn.test/a" });
  const timer = [...timers.values()][0];
  assert.ok(timer.delay > api.FETCH_TIMEOUT_MS + api.UPLOAD_TIMEOUT_MS);
  timer.fn();
  const result = await pending;
  assert.equal(result.code, "result_unknown");
  callback({ ok: true });
  assert.equal((await pending).code, "result_unknown");
});

test("closed runtime port is uncertain, while invalid extension context asks for reload", async () => {
  const chrome = { runtime: { lastError: { message: "message port closed" }, sendMessage: (_m, cb) => cb() } };
  const { api } = runtime({ chrome });
  assert.equal((await api.requestBackground({})).code, "result_unknown");
  chrome.runtime.sendMessage = () => { throw new Error("Extension context invalidated"); };
  assert.equal((await api.requestBackground({})).code, "reload_extension");
});

test("desktop disconnect before upload is unavailable; disconnect/timeout after sending is uncertain", async () => {
  const sockets = [];
  class Socket {
    constructor() { sockets.push(this); this.frames = []; }
    send(value) { this.frames.push(value); }
    close() { this.onclose?.(); }
  }
  const { api, timers } = runtime({ WebSocket: Socket });
  const unavailable = api.uploadBytes(new Uint8Array([1]).buffer, {});
  sockets[0].onerror();
  assert.equal((await unavailable).code, "desktop_unavailable");
  const unknown = api.uploadBytes(new Uint8Array([1]).buffer, { page_url: "https://site.test/note" });
  sockets[1].onopen();
  assert.equal(JSON.parse(sockets[1].frames[0]).type, "save_blob");
  assert.equal(JSON.parse(sockets[1].frames[0]).page_url, "https://site.test/note");
  assert.equal(sockets[1].frames.length, 2);
  [...timers.values()][0].fn();
  assert.equal((await unknown).code, "result_unknown");
});

function contentFixture({ urls = [], xhsState, remote, localResult = { ok: true } } = {}) {
  const nodes = [];
  const documentListeners = {};
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.style = {}; this.attributes = {}; this.listeners = {}; this.children = []; }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); }
    remove() { this.removed = true; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key] || ""; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    closest() { return null; }
    getBoundingClientRect() { return { width: 600, height: 400 }; }
  }
  const images = urls.map((url) => Object.assign(new Element("img"), { currentSrc: url, naturalWidth: 600, naturalHeight: 400 }));
  const page = xhsState ? "https://www.xiaohongshu.com/explore/note-id" : "https://site.test/page";
  const document = {
    baseURI: page,
    scripts: xhsState ? [{ textContent: `window.__INITIAL_STATE__=${JSON.stringify(xhsState)}` }] : [],
    createElement: (tag) => { const node = new Element(tag); nodes.push(node); return node; },
    documentElement: new Element("html"),
    getElementById: (id) => nodes.findLast((node) => node.id === id && !node.removed),
    querySelectorAll: (selector) => selector === "img" || selector === "*" ? images : [],
    addEventListener: (name, fn) => { documentListeners[name] = fn; },
  };
  const fetched = [];
  const uploads = [];
  class Socket {
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(value) {
      if (typeof value === "string") {
        this.metadata = JSON.parse(value);
        if (this.metadata.type === "ping") queueMicrotask(() => this.onmessage?.({ data: '{"ok":true,"pong":true}' }));
      } else {
        uploads.push(this.metadata);
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(localResult) }));
      }
    }
    close() { this.onclose?.(); }
  }
  const messages = [];
  const { context, timers } = runtime({
    document, Element, window: {}, location: new URL(page), WebSocket: Socket,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", backgroundImage: "none" }),
    fetch: async (url) => {
      fetched.push(url);
      return { ok: true, headers: { get: (key) => key === "content-type" ? "image/png" : "8" }, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer };
    },
    chrome: { runtime: {
      getURL: (url) => `chrome-extension://fixture/${url}`,
      sendMessage: (message, cb) => { messages.push(message); if (remote) remote(message, cb); else cb({ ok: true }); },
    } },
  });
  vm.runInContext(source("candidate-utils.js"), context);
  vm.runInContext(source("content.js"), context);
  const button = document.documentElement.children[0];
  const confirm = async () => {
    await button.listeners.click();
    const card = document.getElementById("__bowerbird_confirm");
    card.children[1].children[1].onclick();
    await flush();
  };
  return { document, button, nodes, messages, fetched, uploads, confirm, documentListeners, timers };
}

test("real content click/confirmation saves mixed HTTP/blob/data batch with correct partial summary", async () => {
  const fixture = contentFixture({
    urls: ["https://cdn.test/a.jpg", "blob:https://site.test/b", "data:image/png;base64,AA=="],
    remote: (_m, cb) => cb({ ok: false, error: "HTTP 403 private-data" }),
  });
  await fixture.confirm();
  assert.equal(fixture.messages.length, 1);
  assert.equal(fixture.fetched.length, 2);
  assert.equal(fixture.uploads.length, 2);
  assert.ok(fixture.uploads.every((meta) => meta.page_url === "https://site.test/page"));
  const text = fixture.document.getElementById("__bowerbird_toast").textContent;
  assert.match(text, /已保存 2 张，失败 1 张/);
  assert.doesNotMatch(text, /private-data/);
});

test("content busy guard blocks repeat click, drop and Alt while an upload is pending", async () => {
  let done;
  const fixture = contentFixture({ urls: ["https://cdn.test/a.jpg"], remote: (_m, cb) => { done = cb; } });
  await fixture.confirm();
  await fixture.button.listeners.click();
  await fixture.button.listeners.drop({ preventDefault() {}, dataTransfer: { getData() { throw new Error("busy drop must not read"); } } });
  await fixture.documentListeners.click({ altKey: true, composedPath() { throw new Error("busy Alt must not scan"); } });
  assert.equal(fixture.messages.length, 1);
  assert.equal(fixture.document.getElementById("__bowerbird_confirm"), undefined);
  assert.match(fixture.document.getElementById("__bowerbird_toast").textContent, /采集中 0\/1/);
  done({ ok: true });
  await flush();
  assert.equal(fixture.button.attributes["aria-busy"], "false");
});

test("real XHS detail path keeps image order and note URL while limiting confirmation/upload to 100", async () => {
  const imageList = Array.from({ length: 110 }, (_, i) => ({ urlDefault: `https://sns.xhscdn.com/${i}.jpg` }));
  const fixture = contentFixture({ xhsState: { note: { noteDetailMap: { "note-id": { note: { type: "normal", imageList } } } } } });
  await fixture.button.listeners.click();
  const card = fixture.document.getElementById("__bowerbird_confirm");
  assert.match(card.children[0].textContent, /110.*100/);
  card.children[1].children[1].onclick();
  for (let i = 0; i < 15; i += 1) await flush();
  assert.equal(fixture.messages.length, 100);
  assert.equal(fixture.messages[99].url, "https://sns.xhscdn.com/99.jpg");
  assert.ok(fixture.messages.every((message) => message.pageUrl === "https://www.xiaohongshu.com/explore/note-id"));
});

function backgroundFixture(fetch) {
  let listener;
  const uploads = [];
  class Socket {
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(value) {
      if (typeof value === "string") this.metadata = JSON.parse(value);
      else {
        uploads.push({ metadata: this.metadata, bytes: value });
        queueMicrotask(() => this.onmessage?.({ data: '{"ok":true,"asset_id":"fixture"}' }));
      }
    }
    close() { this.onclose?.(); }
  }
  const { context, timers } = runtime({
    fetch, WebSocket: Socket,
    chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
  });
  context.importScripts = (name) => vm.runInContext(source(name), context);
  vm.runInContext(source("background.js"), context);
  return {
    uploads, timers,
    send: (message) => new Promise((resolve) => {
      assert.equal(listener({ type: "save_image", ...message }, {}, resolve), true);
    }),
  };
}

test("actual background fetch uses browser credentials and sends metadata plus binary receipt", async () => {
  const calls = [];
  const fixture = backgroundFixture(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true, url: "https://cdn.test/final.png", headers: { get: (key) => key === "content-type" ? "image/png" : "8" },
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
    };
  });
  const result = await fixture.send({ url: "https://cdn.test/input.png", pageUrl: "https://site.test/note", candidateSource: "srcset" });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.referrer, "https://site.test/note");
  assert.equal(fixture.uploads.length, 1);
  assert.equal(fixture.uploads[0].metadata.type, "save_blob");
  assert.equal(fixture.uploads[0].metadata.requested_url, "https://cdn.test/input.png");
  assert.equal(fixture.uploads[0].metadata.effective_url, "https://cdn.test/final.png");
  assert.equal(fixture.uploads[0].metadata.page_url, "https://site.test/note");
  assert.equal(fixture.uploads[0].bytes.byteLength, 8);
});

test("actual background fetch abort has no upload and is reported as a read timeout", async () => {
  const fixture = backgroundFixture((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }));
  const pending = fixture.send({ url: "https://cdn.test/input.png" });
  [...fixture.timers.values()].find((timer) => timer.delay === 45000).fn();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, "fetch_timeout");
  assert.equal(fixture.uploads.length, 0);
});

test("packaged manifest loads all content dependencies and Windows runtime stays identical", () => {
  const manifest = JSON.parse(source("manifest.json"));
  assert.equal(manifest.version, "0.2.0");
  assert.deepEqual(manifest.content_scripts[0].js, ["candidate-utils.js", "collection-utils.js", "content.js"]);
  for (const file of ["manifest.json", "candidate-utils.js", "collection-utils.js", "content.js", "background.js"]) {
    assert.equal(source(file), readFileSync(new URL(`../../Windows/extension/${file}`, import.meta.url), "utf8"), file);
  }
});
