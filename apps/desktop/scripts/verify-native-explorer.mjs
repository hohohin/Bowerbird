// Runs a hidden native WebView2 fixture against synthetic local sites, with
// isolated profiles. Does not start Bowerbird's production library or services.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
import { startBrowserDrag, finishBrowserDrag } from "./fixtures/explorer/native-drag.mjs";
import { parseExplorerImage } from "../src/lib/explorer.ts";
const root = path.resolve("../..");
const directory = path.join(root, ".tmp", "explorer-native-" + Date.now());
await mkdir(directory, { recursive: true });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Qy4AAAAASUVORK5CYII=", "base64");
const servers = [];
async function serve(port, handler) {
  const server = createServer(handler); servers.push(server);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
}
let imageRequests = 0;
await serve(1557, (_, res) => { res.setHeader("Content-Type", "text/html"); res.end('<html><body><div id="drop" style="width:250px;height:600px">素材库</div></body></html>'); });
await serve(1558, (req, res) => {
  if (req.url === "/login") { res.setHeader("Set-Cookie", "explorerSession=logged-in; HttpOnly; Max-Age=3600; SameSite=Lax; Path=/"); res.writeHead(302, { Location: "/fixture" }); res.end(); return; }
  res.setHeader("Content-Type", "text/html");
  res.end(`<html><body><h1>${req.headers.cookie?.includes("explorerSession=logged-in") ? "logged in" : "logged out"}</h1><a href="/login">Login</a><a href="/pin/123"><img id="image" draggable="true" style="width:150px;height:150px" src="http://127.0.0.1:1559/small.png" srcset="http://127.0.0.1:1559/small.png 1x, http://127.0.0.1:1559/protected.png 2x"></a></body></html>`);
});
await serve(1559, (req, res) => {
  imageRequests++;
  if (req.url === "/html") { res.setHeader("Content-Type", "text/html"); res.end("<html>Login required</html>"); return; }
  if (!req.headers.cookie?.includes("explorerSession=logged-in")) { res.writeHead(401); res.end("login required"); return; }
  res.setHeader("Content-Type", "image/png"); res.end(png); // deliberately no CORS headers
});
let child; let browser; let sourceBrowser;
async function start() {
  child = spawn(path.resolve(process.argv.slice(2).find(arg => !arg.startsWith("--")) || "src-tauri/target-local-classification/debug/examples/explorer_smoke.exe"), [], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: path.resolve("src-tauri/target-local-classification/debug") + ";" + process.env.PATH,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "", BOWERBIRD_EXPLORER_TEST_DEBUG_PORT: "9558",
      BOWERBIRD_EXPLORER_TEST_DATA_DIR: path.join(directory, "sites"), BOWERBIRD_EXPLORER_TEST_MAIN_DATA_DIR: path.join(directory, "main") }
  });
  let output = ""; child.stderr.on("data", data => { output += data; });
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error("native fixture exited " + child.exitCode + ": " + output);
    try { browser = await chromium.connectOverCDP("http://127.0.0.1:9557"); break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.ok(browser, "native debugging endpoint");
  const context = browser.contexts()[0];
  let main;
  for (let i = 0; i < 80; i++) { main = context.pages().find(page => page.url().startsWith("http://127.0.0.1:1557")); if (main) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(main, "native main webview");
  await main.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  await main.evaluate(() => window.__TAURI_INTERNALS__.invoke("open_source_browser", { url: "http://127.0.0.1:1558/fixture", bounds: { x: 300, y: 100, width: 750, height: 600 } }));
  let source;
  for (let i = 0; i < 80; i++) {
    try { sourceBrowser ||= await chromium.connectOverCDP("http://127.0.0.1:9558"); } catch { /* profile starting */ }
    source = sourceBrowser?.contexts()[0].pages().find(page => page.url().startsWith("http://127.0.0.1:1558"));
    if (source) break; await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(source, "native source webview");
  await source.waitForLoadState("domcontentloaded");
  return { main, source };
}
async function stop(main) {
  const exited = new Promise(resolve => child.once("exit", resolve));
  await main.evaluate(() => { window.__TAURI_INTERNALS__.invoke("smoke_exit").catch(() => {}); }).catch(() => {});
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("native exit timeout")), 10000))]);
  await browser.close().catch(() => {}); browser = null; child = null;
  await sourceBrowser?.close().catch(() => {}); sourceBrowser = null;
}
try {
  let { main, source } = await start();
  assert.equal(await source.locator("h1").textContent(), "logged out");
  await assert.rejects(main.evaluate(() => window.__TAURI_INTERNALS__.invoke("smoke_capture", { url: "http://127.0.0.1:1559/protected.png" })), /401/);
  await source.getByText("Login", { exact: true }).click(); await source.getByText("logged in", { exact: true }).waitFor();
  // Source-generated data crosses into the second isolated WebView through CDP.
  // This exercises each browser's real drag handling, not Windows' OS drag loop.
  await main.evaluate(() => {
    document.querySelector("#drop").addEventListener("dragover", event => event.preventDefault());
    document.querySelector("#drop").addEventListener("drop", event => {
      event.preventDefault();
      window.droppedText = event.dataTransfer.getData("text/plain");
    });
  });
  const { session: sourceSession, data: dragData } = await startBrowserDrag(source,
    ...(await source.locator("#image").boundingBox().then(rect => [rect.x + 30, rect.y + 30])));
  assert.ok(dragData.items.some(item => item.mimeType === "application/x-bowerbird-explorer"));
  const mainSession = await main.context().newCDPSession(main);
  // Exercise Windows' standard-text fallback without relying on custom MIME.
  await finishBrowserDrag(mainSession, { items: dragData.items.filter(item => item.mimeType === "text/plain"), dragOperationsMask: 1 }, 100, 200);
  const droppedText = await main.evaluate(() => window.droppedText);
  const dropped = parseExplorerImage({ getData: type => type === "text/plain" ? droppedText : "" });
  assert.equal(dropped?.imageUrl, "http://127.0.0.1:1559/protected.png");
  assert.equal(dropped?.pageUrl, "http://127.0.0.1:1558/pin/123");
  const droppedBytes = await main.evaluate(url => window.__TAURI_INTERNALS__.invoke("smoke_capture", { url }), dropped.imageUrl);
  assert.deepEqual(Buffer.from(droppedBytes, "base64"), png);
  await sourceSession.send("Input.dispatchDragEvent", { type: "dragCancel", x: 0, y: 0, data: dragData });
  await sourceSession.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 0, y: 0, button: "left", buttons: 0 });
  await sourceSession.detach();
  await source.evaluate(() => {
    window.explorerDocumentToken = "same-live-document";
    const input = document.createElement("input"); input.id = "draft"; input.value = "unsaved web form"; document.body.append(input);
    document.body.style.height = "3000px"; window.scrollTo(0, 500);
  });
  await main.evaluate(async () => {
    await window.__TAURI_INTERNALS__.invoke("hide_source_browser");
    await window.__TAURI_INTERNALS__.invoke("open_source_browser", { url: "http://127.0.0.1:1558/fixture", bounds: { x: 0, y: 100, width: 500, height: 600 } });
  });
  await source.waitForTimeout(300);
  assert.deepEqual(await source.evaluate(() => ({ token: window.explorerDocumentToken, draft: document.querySelector("#draft")?.value, scroll: window.scrollY })),
    { token: "same-live-document", draft: "unsaved web form", scroll: 500 });
  const shade = async dimmed => main.evaluate(dimmed => window.__TAURI_INTERNALS__.invoke("resize_source_browser", {
    bounds: { x: 0, y: 100, width: 500, height: 600 }, visible: true, dimmed,
  }), dimmed);
  await shade(true);
  await source.locator("#bowerbird-onboarding-shade").waitFor();
  assert.deepEqual(await source.locator("#bowerbird-onboarding-shade").evaluate(el => ({
    color: getComputedStyle(el).backgroundColor, topLayer: el.matches(":popover-open"),
  })), { color: "rgba(0, 0, 0, 0.56)", topLayer: true });
  await shade(false);
  await source.locator("#bowerbird-onboarding-shade").waitFor({ state: "detached" });
  assert.deepEqual(await source.evaluate(() => ({ token: window.explorerDocumentToken, draft: document.querySelector("#draft")?.value, scroll: window.scrollY })),
    { token: "same-live-document", draft: "unsaved web form", scroll: 500 });
  const payload = await source.locator("#image").evaluate(image => {
    const transfer = new DataTransfer(); image.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
    return JSON.parse(transfer.getData("application/x-bowerbird-explorer"));
  });
  assert.equal(payload.imageUrl, "http://127.0.0.1:1559/protected.png");
  assert.equal(payload.pageUrl, "http://127.0.0.1:1558/pin/123");
  const data = await main.evaluate(url => window.__TAURI_INTERNALS__.invoke("smoke_capture", { url }), payload.imageUrl);
  assert.deepEqual(Buffer.from(data, "base64"), png);
  await assert.rejects(main.evaluate(() => window.__TAURI_INTERNALS__.invoke("smoke_capture", { url: "http://127.0.0.1:1559/html" })), /不是可识别图片/);
  // The untrusted browser page must not acquire app commands.
  const remote = await source.evaluate(async () => {
    try { await window.__TAURI_INTERNALS__.invoke("smoke_capture", { url: "http://127.0.0.1:1559/protected.png" }); return "allowed"; }
    catch { return "denied"; }
  });
  assert.equal(remote, "denied");
  await shade(true);
  await main.evaluate(() => window.__TAURI_INTERNALS__.invoke("reload_source_browser"));
  await source.waitForLoadState("load");
  await source.waitForFunction(() => !window.explorerDocumentToken && !!document.querySelector("#bowerbird-onboarding-shade:popover-open"));
  await shade(false);
  await source.locator("#bowerbird-onboarding-shade").waitFor({ state: "detached" });
  await stop(main);
  ({ main, source } = await start());
  await source.getByText("logged in", { exact: true }).waitFor();
  const restored = await main.evaluate(() => window.__TAURI_INTERNALS__.invoke("smoke_capture", { url: "http://127.0.0.1:1559/protected.png" }));
  assert.deepEqual(Buffer.from(restored, "base64"), png);
  await stop(main);
  console.log(JSON.stringify({ ok: true, nativeWebView2: true, spotlightDimRestoresWithoutReload: true, spotlightSurvivesPageReload: true, browserGeneratedDragTransferredViaCdp: true, crossOriginImageWithoutCors: true,
    httpOnlyCookiePersistedAcrossRestart: true, reopenPreservesDocumentFormAndScroll: true, remoteIpcDenied: true, dragMetadata: payload, imageRequests, profiles: directory }));
} finally {
  if (child && child.exitCode === null) await new Promise(resolve => {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("exit", resolve);
  });
  if (browser) await browser.close().catch(() => {});
  if (sourceBrowser) await sourceBrowser.close().catch(() => {});
  servers.forEach(server => server.closeAllConnections());
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}
