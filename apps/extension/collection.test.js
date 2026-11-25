import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
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
  const { api, timers } = runtime({ WebSocket: Socket, BowerbirdPairing: {proof: async () => ({ok:true,protocols:["bowerbird-v1","fixture"]})}, chrome:{runtime:{id:"fixture"}} });
  const unavailable = api.uploadBytes(new Uint8Array([1]).buffer, {});
  await flush(); sockets[0].onerror();
  assert.equal((await unavailable).code, "desktop_unavailable");
  const unknown = api.uploadBytes(new Uint8Array([1]).buffer, { page_url: "https://site.test/note" });
  await flush(); sockets[1].onopen();
  assert.equal(JSON.parse(sockets[1].frames[0]).type, "save_blob");
  assert.equal(JSON.parse(sockets[1].frames[0]).page_url, "https://site.test/note");
  assert.equal(sockets[1].frames.length, 2);
  [...timers.values()][0].fn();
  assert.equal((await unknown).code, "result_unknown");
});

function messageEvent() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, dispatch(...args) { return listeners.map(fn => fn(...args)); } };
}

function backgroundFixture(fetch, videoSupport = true, receipt, pairing) {
  const onMessage = messageEvent();
  const onConnect = messageEvent();
  const uploads = [];
  const sockets = [];
  const batches = [];
  const pings = [];
  const stored = {};
  let now = 0;
  let proofs = 0;
  const storage = { local: {
    get: (key, callback) => callback({ [key]: stored[key] }),
    set: (value, callback) => { Object.assign(stored, value); callback?.(); },
  } };
  class Socket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0;
      sockets.push(this);
      queueMicrotask(() => { this.readyState = Socket.OPEN; this.onopen?.(); });
    }
    send(value) {
      if (typeof value === "string") {
        this.metadata = JSON.parse(value);
        if (this.metadata.type === "ping") {
          pings.push(this.metadata);
          this.reply({ok:true,pong:true,...(videoSupport ? {capabilities:{video_blob:true,video_max_bytes:209715200}} : {})});
        }
      }
      else {
        uploads.push({ metadata: this.metadata, bytes: value });
        if (receipt) receipt(this, this.metadata);
        else this.reply({ok:true,asset_id:"fixture",...(this.metadata.media_kind==="video" ? {media_kind:"video"} : {})});
      }
    }
    reply(value) { queueMicrotask(() => this.onmessage?.({data:JSON.stringify(value)})); }
    close() { if (this.readyState !== 3) { this.readyState = 3; this.onclose?.(); } }
  }
  const sender = tabId => ({ id: "fixture", tab: { id: tabId }, url: "https://site.test/page" });
  const { context, timers, api } = runtime({
    fetch, WebSocket: Socket, performance: { now: () => now },
    fixturePairing: {
      proof: async () => { proofs += 1; return { ok: true, protocols: ["bowerbird-v2", "fixture"] }; },
      load: async () => ({publicKey:"public-key"}),
      generate: async () => ({publicKey:"generated-key"}),
      ...pairing,
    },
    chrome: { storage, runtime: { id: "fixture", getManifest: () => ({version:"1.2.3"}), getURL: path => `chrome-extension://fixture/${path}`, onMessage, onConnect,
      connect({ name }) {
        let closed = false;
        const events = [messageEvent(), messageEvent()];
        const disconnects = [messageEvent(), messageEvent()];
        const messages = [];
        batches.push({
          messages,
          drop() {
            if (closed) return;
            closed = true;
            for (const event of disconnects) event.dispatch();
          },
        });
        const ports = events.map((event, side) => ({ name, sender: sender(1), onMessage: event, onDisconnect: disconnects[side],
          postMessage(message) {
            if (closed) throw new Error("Port closed");
            if (side === 0) messages.push(message);
            queueMicrotask(() => { if (!closed) events[1 - side].dispatch(message); });
          },
          disconnect() { if (!closed) { closed = true; disconnects[1 - side].dispatch(); } },
        }));
        queueMicrotask(() => onConnect.dispatch(ports[1]));
        return ports[0];
      },
    } },
  });
  context.importScripts = (...names) => names.forEach(name=>vm.runInContext(name === "pairing.js" ? 'const BowerbirdPairing = fixturePairing;' : source(name), context));
  vm.runInContext(source("background.js"), context);
  const dispatch = (value, tabId, overrides, respond) => onMessage.dispatch(value, { ...sender(tabId), ...overrides }, respond).includes(true);
  const message = (value, tabId = 1, overrides) => new Promise(resolve => {
    assert.ok(dispatch(value, tabId, overrides, resolve));
  });
  return {
    api, uploads, sockets, batches, pings, timers, message, dispatch,
    send: value => message({ type: "save_image", ...value }),
    time: value => { now = value; },
    proofCount: () => proofs,
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

test("20 tabs share one authenticated heartbeat and receive the browser-wide cooldown", async () => {
  const fixture = backgroundFixture(() => { throw new Error("heartbeat does not read images"); });
  const ping = { type: "collect_heartbeat" };
  const results = await Promise.all(Array.from({length:20}, (_, index) => fixture.message(ping, index + 1)));
  assert.equal(fixture.proofCount(), 1);
  assert.equal(fixture.sockets.length, 1);
  assert.deepEqual(fixture.pings, [{ type: "ping", extension_version: "1.2.3" }]);
  assert.ok(results.every(result => result.ok && result.retryAfterMs === 15000));
  fixture.time(14999);
  assert.equal((await fixture.message(ping)).retryAfterMs, 1);
  assert.equal(fixture.proofCount(), 1);
  fixture.time(15000);
  assert.equal((await fixture.message(ping)).retryAfterMs, 15000);
  assert.equal(fixture.proofCount(), 2);
});

test("authenticated operations import the private signing key once until rotation", async () => {
  const changes = messageEvent();
  let key;
  let imports = 0;
  const { context } = runtime({
    AbortSignal, TextEncoder,
    crypto: {
      getRandomValues: value => webcrypto.getRandomValues(value),
      subtle: {
        generateKey: (...args) => webcrypto.subtle.generateKey(...args),
        exportKey: (...args) => webcrypto.subtle.exportKey(...args),
        sign: (...args) => webcrypto.subtle.sign(...args),
        importKey: (...args) => { imports += 1; return webcrypto.subtle.importKey(...args); },
      },
    },
    chrome: { storage: { onChanged: changes, local: {
      setAccessLevel: async () => {},
      get: async () => ({ collectionKey: key }),
      set: async ({collectionKey}) => { key = collectionKey; changes.dispatch({ collectionKey: {} }, "local"); },
    } } },
    fetch: async () => ({status:204,headers:{get:()=>"0".repeat(32)}}),
  });
  vm.runInContext(source("pairing.js"), context);
  const pairing = vm.runInContext("BowerbirdPairing", context);
  await pairing.generate();
  const proofs = await Promise.all(Array.from({length:8}, () => pairing.proof("chrome-extension://fixture", "extension")));
  assert.ok(proofs.every(proof => proof.ok));
  assert.equal(new Set(proofs.map(proof => proof.protocols[1])).size, 8);
  assert.equal(imports, 1);
  await pairing.generate();
  assert.equal((await pairing.proof("chrome-extension://fixture", "extension")).ok, true);
  assert.equal(imports, 2);
});

function imageResponse(url, bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])) {
  return { ok: true, url, headers: { get: () => null }, arrayBuffer: async () => bytes.buffer };
}

const imageItems = (count) => Array.from({length:count}, (_, index) => ({
  media_url: `https://cdn.test/${index}.png`, source_url: `https://site.test/${index}`,
}));

test("HEIC major or compatible brands pass octet-stream image validation without copying the buffer", async () => {
  const bytes = (major, compatible, boxSize = 24) => {
    const header = new Uint8Array(24);
    header[3] = boxSize;
    header.set(new TextEncoder().encode(`ftyp${major}0000${compatible}`), 4);
    return header;
  };
  for (const [major, compatible] of [["heic","mif1"], ["xxxx","heix"], ["heif","msf1"]]) {
    const data = bytes(major, compatible);
    const fixture = backgroundFixture(async url => ({ ...imageResponse(url, data), headers:{get: key => key === "content-type" ? "application/octet-stream" : null} }));
    assert.equal((await fixture.send({url:"https://cdn.test/asset"})).ok, true);
    assert.equal(fixture.uploads[0].bytes, data.buffer);
  }
  const fixture = backgroundFixture(async url => imageResponse(url, bytes("isom", "avif", 16)));
  assert.equal((await fixture.send({url:"https://cdn.test/asset"})).ok, false);
  assert.equal(fixture.uploads.length, 0);
  const malformed = backgroundFixture(async url => imageResponse(url, bytes("mif1", "avif")));
  const rejected = await malformed.send({url:"https://cdn.test/asset"});
  assert.equal(rejected.code, "invalid_image");
  assert.equal(malformed.uploads.length, 0);
});

test("50 remote images overlap at most four fetches and use one socket in original order", async t => {
  const items = imageItems(50);
  let concurrency = 0;
  let peak = 0;
  const fetch = async url => {
    concurrency += 1;
    peak = Math.max(peak, concurrency);
    const index = Number(new URL(url).pathname.slice(1).split(".")[0]);
    await new Promise(resolve => setTimeout(resolve, 16 + (index % 4 === 0 ? 4 : 0)));
    concurrency -= 1;
    return imageResponse(url);
  };
  const baseline = backgroundFixture(fetch);
  const baselineStart = performance.now();
  for (const item of items) await baseline.send({ url: item.media_url, pageUrl: item.source_url });
  const baselineMs = performance.now() - baselineStart;
  const fixture = backgroundFixture(fetch);
  const start = performance.now();
  const summary = await fixture.api.runBatch(items, { remote: fixture.api.requestBackground });
  const batchMs = performance.now() - start;
  t.diagnostic(`serial ${baselineMs.toFixed(0)} ms, batched ${batchMs.toFixed(0)} ms in synthetic fixture`);
  assert.equal(summary.saved, 50);
  assert.equal(peak, 4);
  assert.equal(baseline.sockets.length, 50);
  assert.equal(fixture.sockets.length, 1);
  assert.equal(fixture.proofCount(), 1);
  assert.deepEqual(fixture.uploads.map(({metadata}) => [metadata.requested_url, metadata.page_url]),
    items.map(item => [item.media_url, item.source_url]));
});

test("batch reconnects remaining images after a lost receipt and retry excludes already saved items", async () => {
  const items = imageItems(5);
  const fixture = backgroundFixture(async url => url === items[3].media_url ? {ok:false,status:403} : imageResponse(url), true, (socket, metadata) => {
    if (metadata.requested_url === items[1].media_url) queueMicrotask(() => socket.close());
    else if (metadata.requested_url === items[2].media_url) socket.reply({ok:false,saved:true});
    else socket.reply({ok:true});
  });
  const summary = await fixture.api.runBatch(items, { remote: fixture.api.requestBackground });
  assert.equal(fixture.sockets.length, 2);
  assert.equal(summary.saved, 3);
  assert.equal(summary.unconfirmed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.results[1].code, "result_unknown");
  assert.equal(summary.failedItems.length, 1);
  assert.equal(summary.failedItems[0], items[3]);
  assert.deepEqual(fixture.uploads.map(({metadata}) => metadata.requested_url), items.filter((_, index) => index !== 3).map(item => item.media_url));
});

for (const fault of ["page timeout", "background port loss"]) {
  test(`${fault} resumes only unsent candidates and preserves real upload failures`, async () => {
    const items = imageItems(4);
    let firstSent;
    const firstUpload = new Promise(resolve => { firstSent = resolve; });
    const fixture = backgroundFixture(async url => url === items[2].media_url ? {ok:false,status:403} : imageResponse(url), true, (socket, metadata) => {
      if (metadata.requested_url === items[0].media_url) firstSent(socket);
      else socket.reply({ ok: true });
    });
    const pending = fixture.api.runBatch(items, { remote: fixture.api.requestBackground });
    const originalSocket = await firstUpload;
    if (fault === "page timeout") {
      const deadline = [...fixture.timers.values()].find(timer => timer.delay === fixture.api.MESSAGE_TIMEOUT_MS);
      assert.ok(deadline);
      deadline.fn();
    } else fixture.batches[0].drop();
    originalSocket.reply({ ok: true });
    const summary = await pending;
    assert.equal(summary.unconfirmed, 1);
    assert.equal(summary.results[0].code, "result_unknown");
    assert.equal(summary.saved, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.failedItems[0], items[2]);
    assert.match(summary.results[2].error, /HTTP 403/);
    assert.equal(summary.cancelled, 0);
    assert.equal(fixture.batches.length, 2);
    assert.deepEqual(Array.from(fixture.batches[1].messages[0].items, item => item.index), [1, 2, 3]);
    assert.deepEqual(fixture.uploads.map(({metadata}) => metadata.requested_url), [0,1,3].map(index => items[index].media_url));
  });
}

test("stopping during a reopened batch cancels its fetches and keeps the interrupted result unknown", async () => {
  const items = imageItems(4);
  const controller = new AbortController();
  let firstSent;
  let releaseReplacement;
  let attempts = 0;
  const firstUpload = new Promise(resolve => { firstSent = resolve; });
  const replacementStarted = new Promise(resolve => { releaseReplacement = resolve; });
  const fixture = backgroundFixture((url, { signal }) => {
    if (url !== items[1].media_url) return Promise.resolve(imageResponse(url));
    attempts += 1;
    if (attempts === 2) releaseReplacement(signal);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, true, socket => firstSent(socket));
  const pending = fixture.api.runBatch(items, { remote: fixture.api.requestBackground }, undefined, { signal: controller.signal });
  const originalSocket = await firstUpload;
  fixture.batches[0].drop();
  const replacementSignal = await replacementStarted;
  controller.abort();
  originalSocket.reply({ ok: true });
  const summary = await pending;
  assert.equal(replacementSignal.aborted, true);
  assert.equal(summary.completed, 1);
  assert.equal(summary.unconfirmed, 1);
  assert.equal(summary.cancelled, 3);
  assert.equal(summary.failedItems.length, 0);
  assert.equal(fixture.batches.length, 2);
  assert.equal(fixture.uploads.length, 1);
});

test("mixed batches save page-owned images in order while sharing the remote socket", async () => {
  const [first, last] = imageItems(2);
  const local = { media_url: "blob:https://site.test/inline", source_url: "https://site.test/note" };
  const canvas = { canvas: {}, source_url: "https://site.test/note" };
  const order = [];
  const fixture = backgroundFixture(async url => imageResponse(url), true, (socket, metadata) => {
    order.push(metadata.requested_url);
    socket.reply({ ok: true });
  });
  const summary = await fixture.api.runBatch([first, local, canvas, last], {
    remote: fixture.api.requestBackground,
    local: async item => { order.push(item.media_url); return { ok: true }; },
    canvas: async item => { order.push(item.canvas); return { ok: true }; },
  });
  assert.equal(summary.saved, 4);
  assert.equal(fixture.sockets.length, 1);
  assert.deepEqual(order, [first.media_url, local.media_url, canvas.canvas, last.media_url]);
});

test("cancelling a batch aborts prefetched downloads and waits for an already sent item", async () => {
  const items = imageItems(10);
  const urls = [];
  const aborted = [];
  const controller = new AbortController();
  let uploaded;
  const firstUpload = new Promise(resolve => { uploaded = resolve; });
  const fixture = backgroundFixture((url, { signal }) => {
    urls.push(url);
    if (url === items[0].media_url) return Promise.resolve(imageResponse(url));
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      aborted.push(url);
      reject(signal.reason);
    }));
  }, true, socket => uploaded(socket));
  const result = fixture.api.runBatch(items, { remote: fixture.api.requestBackground }, undefined, { signal: controller.signal });
  const firstSocket = await firstUpload;
  controller.abort();
  await flush();
  assert.equal(aborted.length, 3);
  assert.equal(urls.length, 4);
  firstSocket.reply({ ok: true });
  const summary = await result;
  assert.equal(summary.saved, 1);
  assert.equal(summary.cancelled, 9);
  assert.equal(summary.unconfirmed, 0);
  assert.equal(summary.failedItems.length, 0);
  assert.equal(fixture.uploads.length, 1);
});

test("manifest resolves every declared content script inside the canonical extension", () => {
  const manifest = JSON.parse(source("manifest.json"));
  assert.match(manifest.version, /^\d+(?:\.\d+){2}$/);
  const scripts = manifest.content_scripts[0].js;
  assert.equal(scripts.at(-1), "content.js");
  assert.equal(new Set(scripts).size, scripts.length);
  for (const file of scripts) assert.ok(source(file).trim().length > 0, file);
});

test("background exposes the public pairing code for the settings panel", async () => {
  const fixture=backgroundFixture(async()=>{ throw new Error("pairing code messages must not fetch"); });
  const result=await fixture.message({type:"pairing_code_get"});
  assert.equal(result.ok,true);
  assert.equal(result.code,"fixture.public-key");
});

test("pairing initialization and rotation share one queue and only options may rotate", async () => {
  let key;
  let generations = 0;
  let release;
  const initialGeneration = new Promise(resolve => { release = resolve; });
  const fixture = backgroundFixture(() => { throw new Error("pairing codes must not fetch"); }, true, undefined, {
    load: async () => key,
    generate: async () => {
      const count = ++generations;
      await initialGeneration;
      key = { publicKey: `public-${count}`, privateKey: `private-${count}` };
      return key;
    },
  });
  const get = { type: "pairing_code_get" };
  const rotate = { type: "pairing_code_rotate" };
  const options = { url: "chrome-extension://fixture/options.html" };
  const tabCode = fixture.message(get, 1);
  const optionsCode = fixture.message(get, 2, options);
  await flush();
  assert.equal(generations, 1);
  release();
  assert.equal(JSON.stringify(await tabCode), '{"ok":true,"code":"fixture.public-1"}');
  assert.equal((await optionsCode).code, "fixture.public-1");
  assert.equal(fixture.dispatch(rotate, 1, {}, () => {}), false);
  assert.equal(fixture.dispatch(rotate, 2, {...options,id:"other-extension"}, () => {}), false);
  const rotated = fixture.message(rotate, 2, options);
  const refreshed = fixture.message(get, 1);
  assert.equal((await rotated).code, "fixture.public-2");
  assert.equal((await refreshed).code, "fixture.public-2");
  assert.equal(generations, 2);
});

test("video background negotiates capability before browser-session download and sends verified video bytes", async () => {
  const calls=[];
  const bytes=Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]);
  const fixture=backgroundFixture(async(url,options)=>{calls.push({url,options});return {ok:true,url:"https://cdn.test/final.mp4",headers:{get:key=>key==="content-type" ? "video/mp4" : String(bytes.length)},arrayBuffer:async()=>bytes.buffer};});
  const result=await fixture.send({type:"save_video",url:"https://cdn.test/input.mp4",pageUrl:"https://site.test/note"});
  assert.equal(result.ok,true);
  assert.equal(calls[0].options.credentials,"include");
  assert.equal(calls[0].options.referrer,"https://site.test/note");
  assert.equal(fixture.uploads[0].metadata.media_kind,"video");
  assert.equal(fixture.uploads[0].metadata.byte_length,bytes.length);
  assert.equal(fixture.uploads[0].metadata.effective_url,"https://cdn.test/final.mp4");
  assert.equal(fixture.uploads[0].metadata.page_url,"https://site.test/note");
});

test("old desktop causes no video download; playlists, oversized and fake video never upload", async () => {
  let requests=0;
  const old=backgroundFixture(async()=>{requests++;throw new Error("must not fetch");},false);
  assert.equal((await old.send({type:"save_video",url:"https://cdn.test/clip.mp4"})).code,"desktop_upgrade");
  assert.equal(requests,0);
  for(const [url,mime,length,content,expected] of [
    ["https://cdn.test/a.m3u8","video/mp4",0,"","unsupported_stream"],
    ["https://cdn.test/a.mp4","video/mp4",209715201,"","too_large"],
    ["https://cdn.test/a.mp4","video/mp4",10,"<html>login","invalid_video"],
    ["https://cdn.test/a.mp4","application/dash+xml",10,"<MPD></MPD>","unsupported_stream"],
    ["https://cdn.test/a.mp4","application/octet-stream",20,"#EXTM3U\n#EXT-X-VERSION:3","unsupported_stream"],
  ]) {
    const fixture=backgroundFixture(async()=>({ok:true,url,headers:{get:key=>key==="content-type" ? mime : String(length)},arrayBuffer:async()=>new TextEncoder().encode(content).buffer}));
    assert.equal((await fixture.send({type:"save_video",url})).code,expected);
    assert.equal(fixture.uploads.length,0);
  }
});

test("video upload rechecks desktop capability and never accepts an image-only receipt as success", async()=>{
  const sockets=[];
  class Socket{constructor(){sockets.push(this);this.sent=[];}send(value){this.sent.push(value);}close(){this.onclose?.();}}
  const {api}=runtime({WebSocket:Socket,BowerbirdPairing:{proof:async()=>({ok:true,protocols:["bowerbird-v1","fixture"]})},chrome:{runtime:{id:"fixture"}}});
  const old=api.uploadBytes(new Uint8Array([1]).buffer,{media_kind:"video"});
  await flush(); sockets[0].onopen();assert.equal(JSON.parse(sockets[0].sent[0]).type,"ping");
  sockets[0].onmessage({data:'{"ok":true,"pong":true}'});
  assert.equal((await old).code,"desktop_upgrade");assert.equal(sockets[0].sent.length,1);
  const unknown=api.uploadBytes(new Uint8Array([1]).buffer,{media_kind:"video"});
  await flush(); sockets[1].onopen();sockets[1].onmessage({data:'{"ok":true,"capabilities":{"video_blob":true,"video_max_bytes":209715200}}'});
  assert.equal(sockets[1].sent.length,3);
  sockets[1].onmessage({data:'{"ok":true,"asset_id":"image-only"}'});
  assert.equal((await unknown).code,"result_unknown");
});

test("video timeout aborts fetch and unknown transport diagnostics stay out of video feedback", async()=>{
  const fixture=backgroundFixture((_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(Object.assign(new Error("private-url"),{name:"AbortError"})))));
  const pending=fixture.send({type:"save_video",url:"https://cdn.test/a.mp4"});
  await flush();
  [...fixture.timers.values()].find(timer=>timer.delay===120000).fn();
  assert.equal((await pending).code,"fetch_timeout");assert.equal(fixture.uploads.length,0);
  const {api}=runtime();
  assert.doesNotMatch(api.failureMessage({error:"https://private.test/token C:/secret"},"video"),/private|secret|token/);
});

test("partial video responses never upload and saved-but-unpreviewable receipts never invite another download",async()=>{
  const bytes=Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]);
  const fixture=backgroundFixture(async()=>({ok:true,status:206,url:"https://cdn.test/clip.mp4",headers:{get:key=>key==="content-type" ? "video/mp4" : String(bytes.length)},arrayBuffer:async()=>bytes.buffer}));
  assert.equal((await fixture.send({type:"save_video",url:"https://cdn.test/clip.mp4"})).code,"incomplete_video");
  assert.equal(fixture.uploads.length,0);
  const {api}=runtime();
  assert.match(api.failureMessage({ok:false,saved:true,asset_id:"saved",code:"preview_unavailable"},"video"),/已保存.*预览暂不可用/);
});
