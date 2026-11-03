// Real native commands + WebView2, entirely synthetic Pinterest responses and isolated storage.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const directory = path.resolve(".tmp/pinterest-search-native-" + Date.now());
await mkdir(directory, { recursive: true });
const server = createServer((_, res) => { res.setHeader("Content-Type", "text/html"); res.end("<html><body>Isolated native fixture</body></html>"); });
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(1557, "127.0.0.1", resolve); });
let child; let browser; let sourceBrowser; let main;
let loggedIn = false; let fullNavigation = false; const blockedRequests = [];
const fixture = () => `<html><head><title>Lens native fixture</title></head><body>
<script id="__PWS_DATA__" type="application/json">${JSON.stringify({ context: { is_authenticated: loggedIn } })}</script>
${loggedIn ? "" : '<input type="password" aria-label="Password">'}
<button aria-label="Lens" onclick="showUploader()">Lens</button><div id="uploader"></div>
<script>window.received=[]; window.showUploader=()=>{
 document.querySelector('#uploader').innerHTML='<input id="lens-file-upload" data-test-id="lens-file-upload" type="file" accept="image/*">';
 document.querySelector('#lens-file-upload').addEventListener('change',async event=>{
 const file=event.target.files[0]; if(!file)return;
 const bytes=Array.from(new Uint8Array(await file.arrayBuffer()));
 window.received.push({name:file.name,type:file.type,bytes});
 sessionStorage.setItem('syntheticUploads', String(Number(sessionStorage.getItem('syntheticUploads')||0)+1));
 ${fullNavigation ? "location.assign('/lens-search/?synthetic=full-navigation');" : "history.pushState({},'', '/lens-search/?synthetic=1');"}
});};</script></body></html>`;

async function poll(check, message) {
  for (let i = 0; i < 120; i++) {
    if (child?.exitCode != null) throw new Error("fixture exited " + child.exitCode);
    const value = await check().catch(() => null);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

try {
  child = spawn(path.resolve(process.argv[2] || "src-tauri/target/debug/examples/pinterest_search_smoke.exe"), [], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BOWERBIRD_PINTEREST_TEST_ROOT: directory, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "" },
  });
  let diagnostic = ""; child.stderr.on("data", value => { diagnostic += value; });
  browser = await poll(() => chromium.connectOverCDP("http://127.0.0.1:9567"), "main native CDP missing: " + diagnostic);
  main = await poll(async () => browser.contexts()[0].pages().find(page => page.url().startsWith("http://127.0.0.1:1557")), "main page missing");
  await main.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  await main.evaluate(async () => {
    window.searchEvents = [];
    const handler = window.__TAURI_INTERNALS__.transformCallback(event => window.searchEvents.push(event.payload));
    await window.__TAURI_INTERNALS__.invoke("plugin:event|listen", { event: "source-browser://pinterest-search", target: { kind: "Any" }, handler });
    await window.__TAURI_INTERNALS__.invoke("open_source_browser", { url: "http://127.0.0.1:1557/source", bounds: { x: 250, y: 100, width: 800, height: 600 } });
  });
  sourceBrowser = await poll(() => chromium.connectOverCDP("http://127.0.0.1:9568"), "source native CDP missing");
  const source = await poll(async () => sourceBrowser.contexts()[0].pages().find(page => page.url().includes("/source")), "source page missing");
  await source.context().route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "www.pinterest.com") return route.fulfill({ contentType: "text/html", body: fixture(), headers: { "Set-Cookie": "fixtureSession=present; HttpOnly; Path=/; Secure; SameSite=Lax" } });
    if (url.hostname === "127.0.0.1") return route.continue();
    // Let Tauri itself reject the deliberate remote command attempt.
    if (url.hostname === "ipc.localhost" && url.pathname === "/start_pinterest_image_search") return route.continue();
    blockedRequests.push(url.toString()); return route.abort();
  });
  const assetId = await main.evaluate(() => window.__TAURI_INTERNALS__.invoke("smoke_asset"));
  const start = requestId => main.evaluate(args => window.__TAURI_INTERNALS__.invoke("start_pinterest_image_search", args), { assetId, requestId });
  const cancel = requestId => main.evaluate(requestId => window.__TAURI_INTERNALS__.invoke("cancel_pinterest_image_search", { requestId }), requestId);
  const hasStatus = (requestId, status) => main.evaluate(({requestId,status}) => window.searchEvents.some(event => event.requestId === requestId && event.status === status), {requestId,status});

  await cancel("late-start"); await start("late-start");
  assert.equal(await hasStatus("late-start", "preparing"), false, "cancel received before start blocks the delayed request");

  await start("login-first");
  await poll(() => hasStatus("login-first", "waiting-login"), "real native login notice missing");
  assert.equal(await source.evaluate(() => window.received.length), 0);
  const remoteAttempt = await source.evaluate(async ({ assetId }) => {
    if (!window.__TAURI_INTERNALS__?.invoke) return "no-ipc";
    try { await window.__TAURI_INTERNALS__.invoke("start_pinterest_image_search", {assetId, requestId:"remote"}); return "accepted"; }
    catch { return "rejected"; }
  }, { assetId });
  assert.notEqual(remoteAttempt, "accepted", "remote page cannot request registered files");
  await source.evaluate(() => window.open('bowerbird-pinterest://wrong/status?data='+encodeURIComponent(JSON.stringify({requestId:'login-first',status:'submitted'}))));
  assert.equal(await hasStatus("login-first", "submitted"), false, "private bridge rejects forged token");
  await main.evaluate(async () => {
    await window.__TAURI_INTERNALS__.invoke("hide_source_browser");
    await window.__TAURI_INTERNALS__.invoke("resize_source_browser", { bounds: { x:250,y:100,width:800,height:600 }, visible:true });
  });
  loggedIn = true;
  await source.reload();
  await poll(() => hasStatus("login-first", "submitted"), "native image submission missing after login");
  await poll(() => source.evaluate(() => window.received.length === 1), "uploaded File was not readable by the page");
  const received = await source.evaluate(() => window.received);
  assert.equal(received.length, 1);
  assert.equal(received[0].type, "image/png");
  assert.deepEqual(received[0].bytes.slice(0, 8), [137,80,78,71,13,10,26,10]);
  assert.ok(source.url().includes("/lens-search/"));
  assert.equal((await source.context().cookies("https://www.pinterest.com")).some(cookie => cookie.name === "fixtureSession"), true);
  await start("login-first");
  assert.equal(await source.evaluate(() => window.received.length), 1, "completed request ID is not replayed");

  fullNavigation = true;
  await source.evaluate(() => sessionStorage.removeItem("syntheticUploads"));
  await start("full-navigation");
  await poll(() => hasStatus("full-navigation", "submitted"), "full-page results navigation did not finish the pending search");
  await poll(() => source.evaluate(() => location.pathname === "/lens-search/" && window.received?.length === 0), "results must be a fresh document");
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await source.evaluate(() => sessionStorage.getItem("syntheticUploads")), "1", "results documents must not receive a second File/change upload");
  assert.equal(await hasStatus("full-navigation", "searching"), true, "native handoff precedes the results navigation");
  fullNavigation = false;

  loggedIn = false;
  await source.goto("https://www.pinterest.com/");
  const oldDocument = await source.evaluate(() => performance.timeOrigin);
  await start("cancelled");
  await poll(() => hasStatus("cancelled", "waiting-login"), "second waiting request missing");
  assert.ok(await source.evaluate(value => performance.timeOrigin > value, oldDocument), "new search requires a fresh Pinterest document");
  await cancel("cancelled"); await cancel("cancelled");
  loggedIn = true; await source.reload();
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await source.evaluate(() => window.received.length), 0, "cancel prevents login-delayed delivery");

  loggedIn = false; await source.reload(); await start("old");
  await poll(() => hasStatus("old", "waiting-login"), "old request missing");
  await start("new");
  await poll(() => hasStatus("new", "waiting-login"), "new request missing");
  await cancel("old");
  loggedIn = true; await source.reload();
  await poll(() => hasStatus("new", "submitted"), "stale cancel must not affect newest request");
  assert.equal(await hasStatus("old", "submitted"), false);

  loggedIn = false; await source.goto("https://www.pinterest.com/"); await start("leave-site");
  await poll(() => hasStatus("leave-site", "waiting-login"), "leave request missing");
  await source.goto("http://127.0.0.1:1557/external");
  assert.equal(await hasStatus("leave-site", "error"), false, "external login may return to Pinterest");
  assert.equal(await source.evaluate(() => window.__bowerbirdPinterestSearch), undefined);
  loggedIn = true; await source.goto("https://www.pinterest.com/");
  await poll(() => hasStatus("leave-site", "submitted"), "return from external login resumes the pending image");
  const original = await readFile(path.join(directory, "synthetic.png"));
  assert.ok(original.length > 0);
  assert.equal(blockedRequests.length, 0, "no outside network requests from the synthetic pages: " + JSON.stringify(blockedRequests));
  console.log("PASS native Pinterest login resume, File delivery, full-page result without reupload, request idempotence/replacement, cancel, external login origin boundary, synthetic session");
} finally {
  if (child && child.exitCode == null && main) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    await main.evaluate(() => window.__TAURI_INTERNALS__.invoke("smoke_exit")).catch(() => {});
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
  }
  if (child && child.exitCode == null) child.kill();
  await browser?.close().catch(() => {}); await sourceBrowser?.close().catch(() => {});
  server.close();
}
