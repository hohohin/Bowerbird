// Runs a hidden native WebView2 fixture against synthetic local sites, with
// isolated profiles. Does not start Bowerbird's production library or services.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
import { startBrowserDrag, finishBrowserDrag } from "./fixtures/explorer/native-drag.mjs";
import { parseExplorerImage } from "../src/lib/explorer.ts";
const root = path.resolve("../..");
const directory = path.join(root, ".tmp", "explorer-native-" + Date.now());
const useNativePointer = process.argv.includes("--native-pointer");
await mkdir(directory, { recursive: true });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Qy4AAAAASUVORK5CYII=", "base64");
const video = await readFile("src-tauri/tests/fixtures/media/fragmented.mp4");
const visualScript = await readFile("src/lib/explorerDragVisual.js", "utf8");
const visualImage = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><path fill="#587c91" d="M40 20h120v120H40z"/><path fill="white" d="M200 20h100v120H200z"/></svg>';
const servers = [];
async function serve(port, handler) {
  const server = createServer(handler); servers.push(server);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
}
let imageRequests = 0;
await serve(1557, (req, res) => {
  if (req.url === "/visual.js") { res.setHeader("Content-Type", "text/javascript"); res.end(visualScript); return; }
  res.setHeader("Content-Type", "text/html"); res.end('<html><body><div id="drop" style="width:250px;height:600px">素材库</div><script src="/visual.js"></script></body></html>');
});
await serve(1558, (req, res) => {
  if (req.url === "/login") { res.setHeader("Set-Cookie", "explorerSession=logged-in; HttpOnly; Max-Age=3600; SameSite=Lax; Path=/"); res.writeHead(302, { Location: "/fixture" }); res.end(); return; }
  res.setHeader("Content-Type", "text/html");
  if (req.url === "/visual-fixture") { res.end('<html><body style="padding:30px"><img id="visual-image" width="320" height="160" src="http://127.0.0.1:1559/visual.svg"></body></html>'); return; }
  res.end(`<html><body><h1>${req.headers.cookie?.includes("explorerSession=logged-in") ? "logged in" : "logged out"}</h1><a href="/login">Login</a><a href="/pin/123"><img id="image" draggable="true" style="width:150px;height:150px" src="http://127.0.0.1:1559/small.png" srcset="http://127.0.0.1:1559/small.png 1x, http://127.0.0.1:1559/protected.png 2x"></a><video id="video" controls muted style="display:block;width:320px;height:180px" poster="http://127.0.0.1:1559/protected.png" src="http://127.0.0.1:1559/video.mp4"></video></body></html>`);
});
await serve(1559, (req, res) => {
  imageRequests++;
  if (req.url === "/html") { res.setHeader("Content-Type", "text/html"); res.end("<html>Login required</html>"); return; }
  if (!req.headers.cookie?.includes("explorerSession=logged-in")) { res.writeHead(401); res.end("login required"); return; }
  if (req.url === "/visual.svg") { res.setHeader("Content-Type", "image/svg+xml"); res.end(visualImage); return; }
  if (req.url === "/video-partial.mp4") { res.writeHead(206, { "Content-Type":"video/mp4", "Content-Range":`bytes 0-1023/${video.length}` }); res.end(video.subarray(0,1024)); return; }
  if (req.url === "/video.mp4") { res.setHeader("Content-Type", "video/mp4"); res.end(video); return; }
  res.setHeader("Content-Type", "image/png"); res.end(png); // deliberately no CORS headers
});
let child; let browser; let sourceBrowser;
async function start() {
  child = spawn(path.resolve(process.argv.slice(2).find(arg => !arg.startsWith("--")) || "src-tauri/target-local-classification/debug/examples/explorer_smoke.exe"), [], {
    windowsHide: !useNativePointer, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: path.resolve("src-tauri/target-local-classification/debug") + ";" + process.env.PATH,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "", BOWERBIRD_EXPLORER_TEST_DEBUG_PORT: "9558",
      BOWERBIRD_EXPLORER_TEST_VISIBLE: useNativePointer ? "1" : undefined,
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

async function verifyLocationVisibility(main, source) {
  const original = source.url();
  await main.evaluate(async () => {
    window.nativeLocations = [];
    const handler = window.__TAURI_INTERNALS__.transformCallback(event => window.nativeLocations.push(event.payload));
    await window.__TAURI_INTERNALS__.invoke("plugin:event|listen", { event: "source-browser://location", target: { kind: "Any" }, handler });
  });
  const bounds = { x: 300, y: 100, width: 750, height: 600 };
  const resize = visible => main.evaluate(({bounds, visible}) => window.__TAURI_INTERNALS__.invoke("resize_source_browser", {bounds, visible}), {bounds, visible});
  const hide = () => main.evaluate(() => window.__TAURI_INTERNALS__.invoke("hide_source_browser"));
  const open = () => main.evaluate(({bounds, url}) => window.__TAURI_INTERNALS__.invoke("open_source_browser", {bounds, url}), {bounds, url: original});
  const changeLocation = url => source.evaluate(url => history.replaceState(null, "", url), url);
  const waitForLocation = url => main.waitForFunction(url => window.nativeLocations.includes(url), url, { timeout: 3000 });
  const verifyTransition = async (suspend, resume, suffix) => {
    const url = new URL(suffix, original).href;
    await suspend();
    await changeLocation(url);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.ok(!(await main.evaluate(url => window.nativeLocations.includes(url), url)), `hidden WebView reported ${suffix}`);
    await resume();
    await waitForLocation(url);
  };
  const visibleUrl = new URL("#visible", original).href;
  await changeLocation(visibleUrl);
  await waitForLocation(visibleUrl);
  await verifyTransition(() => resize(false), () => resize(true), "#occluded");
  await verifyTransition(hide, open, "#collapsed");
  await changeLocation(original);
  await waitForLocation(original);
  const locations = await main.evaluate(() => window.nativeLocations.filter(url => new URL(url).hash));
  assert.deepEqual(locations.map(url => new URL(url).hash), ["#visible", "#occluded", "#collapsed"]);
  console.log("PASS native SPA address observation pauses on occlusion and collapse, then resumes on both show paths");
}

async function verifyNativeHistory(main, source) {
  const original = source.url();
  const invoke = command => main.evaluate(command => window.__TAURI_INTERNALS__.invoke(command), command);
  await assert.rejects(invoke("source_browser_forward"), /没有可前往的下一页/);
  await source.evaluate(() => history.pushState(null, "", "#native-history"));
  await invoke("source_browser_back");
  await source.waitForURL(original);
  await invoke("source_browser_forward");
  await source.waitForURL(new URL("#native-history", original).href);
  await assert.rejects(invoke("source_browser_forward"), /没有可前往的下一页/);
  await invoke("source_browser_back");
  await source.waitForURL(original);
  console.log("PASS native back and forward use the WebView2 history and report the forward boundary");
}

async function verifyNativePointer(main, source) {
  const invoke = (command, params = {}) => main.evaluate(({command, params}) => window.__TAURI_INTERNALS__.invoke(command, params), {command, params});
  const pointer = (x, y, action) => invoke("smoke_native_pointer", {x, y, action});
  await pointer(0, 0, "focus");
  const traceInput = () => {
    window.nativePointerInput = [];
    for (const name of ["pointerdown", "pointerup", "click", "wheel"]) {
      document.addEventListener(name, event => {
        if (event.isTrusted) window.nativePointerInput.push({
          name, target: event.target.id || event.target.tagName, x: event.clientX, y: event.clientY,
          screenX: event.screenX, screenY: event.screenY,
        });
      }, true);
    }
  };
  await main.evaluate(traceInput);
  await source.evaluate(traceInput);
  let bounds = { x: 300, y: 100, width: 680, height: 580 };
  let side;
  const resize = (visible, masked = true) => invoke("resize_source_browser", {
    bounds: { ...bounds, ...(masked && {overlay: {x: side === "left" ? 0 : bounds.width - 18, y: 200, width: 18, height: 80, cut: 4, side}}) }, visible,
  });
  await source.evaluate(() => {
    document.body.style.minHeight = "2600px";
    const button = document.createElement("button");
    button.id = "native-click-probe";
    button.textContent = "Website button";
    button.style.cssText = "position:fixed;top:28px;right:8px;z-index:1";
    window.nativeClicks = 0;
    button.addEventListener("click", event => { if (event.isTrusted) window.nativeClicks++; });
    document.body.append(button);
  });
  let clicks = 0;
  const clickAndScroll = async label => {
    await source.waitForFunction(({width, height}) => innerWidth === width && innerHeight === height, bounds);
    const rect = await source.locator("#native-click-probe").boundingBox();
    const x = bounds.x + rect.x + rect.width / 2;
    const y = bounds.y + rect.y + rect.height / 2;
    const scroll = await source.evaluate(() => scrollY);
    await pointer(x, y, "click");
    await pointer(x, y, "scroll");
    try {
      await source.waitForFunction(count => window.nativeClicks === count, ++clicks, {timeout: 3000});
      await source.waitForFunction(start => scrollY > start, scroll, {timeout: 3000});
    } catch (error) {
      const describe = () => ({events: window.nativePointerInput, screenX, screenY, devicePixelRatio, scrollY, clickCount: window.nativeClicks});
      console.log(JSON.stringify({label, expected: {x, y, rect}, main: await main.evaluate(describe), source: await source.evaluate(describe)}));
      throw error;
    }
    console.log(`PASS Windows input click and scroll ${label}`);
  };
  await resize(true);
  await clickAndScroll("after opening");
  await resize(false);
  await main.evaluate(() => { const dialog = document.createElement("dialog"); dialog.id = "native-test-dialog"; document.body.append(dialog); dialog.showModal(); });
  await main.evaluate(() => { document.querySelector("#native-test-dialog").close(); document.querySelector("#native-test-dialog").remove(); });
  await resize(true);
  await clickAndScroll("after closing a dialog");
  bounds = {...bounds, width: 460};
  await resize(true);
  await clickAndScroll("after changing the width");

  const clickTab = async side => {
    const left = side === "left" ? bounds.x : bounds.x + bounds.width - 18;
    const top = bounds.y + 200;
    await main.evaluate(({left, top}) => {
      const button = document.createElement("button");
      button.id = "native-tab-probe";
      button.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:18px;height:80px`;
      window.nativeTabClicked = false;
      button.addEventListener("click", event => { if (event.isTrusted) window.nativeTabClicked = true; });
      document.body.append(button);
    }, {left, top});
    await pointer(left + 9, top + 40, "click");
    await main.waitForFunction(() => window.nativeTabClicked, undefined, {timeout: 3000});
    console.log(`PASS Windows input reaches the main WebView through the ${side} panel handle cutout`);
    await main.evaluate(() => document.querySelector("#native-tab-probe").remove());
  };
  await clickTab("right");

  // Exercise the viewport changes a project switch can cause while keeping the same child view.
  side = "left";
  bounds = {...bounds, x: 600, y: 75, height: 600};
  await resize(true);
  await clickTab("left");
  await source.locator("#native-click-probe").evaluate(button => {
    Object.assign(button.style, {left: "3px", right: "auto", width: "14px", height: "20px", padding: "0", overflow: "hidden"});
  });
  await clickAndScroll("above the left cutout after repositioning the viewport");
  await source.locator("#native-click-probe").evaluate(button => { button.style.top = "292px"; });
  await clickAndScroll("below the left cutout");
  await source.locator("#image").scrollIntoViewIfNeeded();
  const image = await source.locator("#image").boundingBox();
  const drag = await startBrowserDrag(source, image.x + 30, image.y + 30);
  try {
    assert.ok(drag.data.items.some(item => item.mimeType === "application/x-bowerbird-explorer"));
  } finally {
    await drag.session.send("Input.dispatchDragEvent", {type: "dragCancel", x: 0, y: 0, data: drag.data});
    await drag.session.send("Input.dispatchMouseEvent", {type: "mouseReleased", x: 0, y: 0, button: "left", buttons: 0});
    await drag.session.detach();
  }
  await clickAndScroll("after browser image drag");

  await source.evaluate(() => {
    document.querySelector("#native-click-probe").remove();
    document.body.style.removeProperty("min-height");
    scrollTo(0, 0);
  });
  bounds = { x: 300, y: 100, width: 750, height: 600 };
  await resize(true, false);
}

async function visualGeometry(page) {
  const card = page.locator('[data-explorer-drag-visual] .card[data-ready]');
  await card.waitFor();
  await page.waitForTimeout(220);
  const geometry = await card.evaluate(element => {
    const style = getComputedStyle(element), paper = getComputedStyle(element.querySelector('.paper'));
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, x: rect.x, y: rect.y,
      padding: style.padding, radius: style.borderRadius, background: style.backgroundColor, paperBackground: paper.backgroundColor };
  });
  assert.ok(Math.abs(geometry.width - 96) < .1 && Math.abs(geometry.height - 48) < .1, 'native preview keeps the 2:1 image aspect');
  assert.equal(geometry.padding, '0px'); assert.equal(geometry.radius, '0px');
  assert.equal(geometry.background, 'rgba(0, 0, 0, 0)'); assert.equal(geometry.paperBackground, 'rgba(0, 0, 0, 0)');
  return geometry;
}
async function verifyNativeVisual(main, source) {
  await main.evaluate(() => window.__TAURI_INTERNALS__.invoke('navigate_source_browser', { url: 'http://127.0.0.1:1558/visual-fixture' }));
  const image = source.locator('#visual-image'); await image.waitFor();
  await image.evaluate(element => element.decode());
  const rect = await image.boundingBox();
  const drag = await startBrowserDrag(source, rect.x + 80, rect.y + 60);
  try {
    const sourceGeometry = await visualGeometry(source);
    // Main uses the exact production factory loaded by the local fixture. This
    // validates native rendering/public methods, not the React hook lifecycle.
    await main.evaluate(url => {
      window.fixtureVisual = window.createBowerbirdDragVisual(document.body);
      window.fixtureVisual.pick({ id: 'native-visual', imageUrl: url }, 100, 250);
    }, 'data:image/svg+xml,' + encodeURIComponent(visualImage));
    const mainGeometry = await visualGeometry(main);
    assert.equal(mainGeometry.width, sourceGeometry.width); assert.equal(mainGeometry.height, sourceGeometry.height);
    await main.evaluate(() => window.fixtureVisual.land(100, 200));
    const landing = await visualGeometry(main);
    assert.ok(Math.abs(landing.x + landing.width / 2 - 100) < .1 && Math.abs(landing.y + landing.height / 2 - 200) < .1, 'landing centers the actual image at the frozen point');
    await main.evaluate(() => window.fixtureVisual.settle(document.querySelector('#drop')));
    await main.locator('[data-explorer-drag-visual]').waitFor({ state: 'detached' });
    const executable = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'src-tauri/target-local-classification/debug/examples/explorer_smoke.exe');
    const binary = await readFile(executable);
    assert.ok(binary.includes(Buffer.from(visualScript)), 'native executable embeds the current shared visual script');
    await writeFile(path.join(directory, 'visual-result.json'), JSON.stringify({ sourceGeometry, mainGeometry, landing,
      sourceProductionInitialization: true, mainProductionFactory: true, mainReactLifecycle: false,
      visualSha256: createHash('sha256').update(visualScript).digest('hex'), binarySha256: createHash('sha256').update(binary).digest('hex') }, null, 2));
  } finally {
    await drag.session.send('Input.dispatchDragEvent', { type: 'dragCancel', x: 0, y: 0, data: drag.data });
    await drag.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 0, y: 0, button: 'left', buttons: 0 });
    await drag.session.detach();
  }
  await source.locator('[data-explorer-drag-visual]').waitFor({ state: 'detached' });
  await main.evaluate(() => window.__TAURI_INTERNALS__.invoke('navigate_source_browser', { url: 'http://127.0.0.1:1558/fixture' }));
  await source.locator('#video').waitFor();
}
try {
  let { main, source } = await start();
  assert.equal(await source.locator("h1").textContent(), "logged out");
  await assert.rejects(main.evaluate(() => window.__TAURI_INTERNALS__.invoke("smoke_capture", { url: "http://127.0.0.1:1559/protected.png" })), /401/);
  await verifyLocationVisibility(main, source);
  await verifyNativeHistory(main, source);
  await source.getByText("Login", { exact: true }).click(); await source.getByText("logged in", { exact: true }).waitFor();
  if (useNativePointer) await verifyNativePointer(main, source);
  // Source-generated data crosses into the second isolated WebView through CDP.
  // This exercises each browser's real drag handling, not Windows' OS drag loop.
  await main.evaluate(() => {
    document.querySelector("#drop").addEventListener("dragover", event => event.preventDefault());
    document.querySelector("#drop").addEventListener("drop", event => {
      event.preventDefault();
      window.droppedText = event.dataTransfer.getData("text/plain");
    });
  });
  await main.evaluate(async () => {
    window.nativeDragEvents = [];
    const handler = window.__TAURI_INTERNALS__.transformCallback(event => window.nativeDragEvents.push(event.payload));
    await window.__TAURI_INTERNALS__.invoke("plugin:event|listen", { event: "source-browser://drag", target: { kind: "Any" }, handler });
  });
  const { session: sourceSession, data: dragData } = await startBrowserDrag(source,
    ...(await source.locator("#image").boundingBox().then(rect => [rect.x + 30, rect.y + 30])));
  assert.ok(dragData.items.some(item => item.mimeType === "application/x-bowerbird-explorer"));
  await source.locator("[data-explorer-drag-visual] .card").waitFor();
  assert.equal(await source.locator("[data-explorer-drag-visual]").evaluate(el => getComputedStyle(el).pointerEvents), "none");
  await main.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke("smoke_drag_notices")).some(n => n.start));
  const notices = await main.evaluate(() => window.__TAURI_INTERNALS__.invoke("smoke_drag_notices"));
  const dragPayload = JSON.parse(dragData.items.find(item => item.mimeType === "application/x-bowerbird-explorer").data);
  assert.equal(notices.at(-1).id, dragPayload.dragId, "native pre-analysis notification arrives before drop");
  await main.waitForFunction(id => window.nativeDragEvents.some(event => event.phase === "start" && event.id === id), dragPayload.dragId);
  assert.equal(notices.at(-1).imageUrl, "http://127.0.0.1:1559/protected.png");
  assert.ok(source.url().startsWith("http://127.0.0.1:1558/"), "preview notification never navigates the page");
  const mainSession = await main.context().newCDPSession(main);
  // Exercise Windows' standard-text fallback without relying on custom MIME.
  await finishBrowserDrag(mainSession, { items: dragData.items.filter(item => item.mimeType === "text/plain"), dragOperationsMask: 1 }, 100, 200);
  const droppedText = await main.evaluate(() => window.droppedText);
  const dropped = parseExplorerImage({ getData: type => type === "text/plain" ? droppedText : "" });
  assert.equal(dropped?.imageUrl, "http://127.0.0.1:1559/protected.png");
  assert.equal(dropped?.pageUrl, "http://127.0.0.1:1558/pin/123");
  const droppedBytes = await main.evaluate(url => window.__TAURI_INTERNALS__.invoke("smoke_capture", { url }), dropped.imageUrl);
  assert.deepEqual(Buffer.from(droppedBytes, "base64"), png);
  // Keep the source drag alive past the ordinary transient user-activation window.
  await new Promise(resolve => setTimeout(resolve, 5500));
  await sourceSession.send("Input.dispatchDragEvent", { type: "dragCancel", x: 0, y: 0, data: dragData });
  await sourceSession.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 0, y: 0, button: "left", buttons: 0 });
  await sourceSession.detach();
  await source.locator("[data-explorer-drag-visual]").waitFor({ state: "detached" });
  await main.waitForFunction(async id => (await window.__TAURI_INTERNALS__.invoke("smoke_drag_notices")).some(n => !n.start && n.id === id), dropped.dragId);
  await verifyNativeVisual(main, source);
  // A real browser-originated VIDEO drag crosses the same standard-text bridge.
  await source.waitForFunction(() => document.querySelector('#video').readyState >= 2);
  const videoRect = await source.locator('#video').boundingBox();
  const videoDrag = await startBrowserDrag(source, videoRect.x + 60, videoRect.y + 45);
  const videoPayload = JSON.parse(videoDrag.data.items.find(item => item.mimeType === 'application/x-bowerbird-explorer').data);
  assert.equal(videoPayload.mediaKind, 'video');
  assert.equal(videoPayload.imageUrl, 'http://127.0.0.1:1559/video.mp4');
  assert.equal(videoPayload.posterUrl, 'http://127.0.0.1:1559/protected.png');
  await main.waitForFunction(id => window.nativeDragEvents.some(event => event.phase === 'start' && event.id === id && event.mediaKind === 'video'), videoPayload.dragId);
  await main.waitForFunction(async id => (await window.__TAURI_INTERNALS__.invoke('smoke_drag_notices')).some(n => n.start && n.id === id && n.mediaKind === 'video'), videoPayload.dragId);
  await finishBrowserDrag(await main.context().newCDPSession(main), { items: videoDrag.data.items.filter(item => item.mimeType === 'text/plain'), dragOperationsMask: 1 }, 100, 200);
  const videoText = await main.evaluate(() => window.droppedText);
  const parsedVideo = parseExplorerImage({ getData: type => type === 'text/plain' ? videoText : '' });
  assert.ok(parsedVideo);
  assert.equal(parsedVideo.mediaKind, 'video');
  const videoBytes = await main.evaluate(url => window.__TAURI_INTERNALS__.invoke('smoke_capture', { url, mediaKind: 'video' }), parsedVideo.imageUrl);
  assert.deepEqual(Buffer.from(videoBytes, 'base64'), video, 'authenticated cross-origin video bytes are complete, not its poster');
  await assert.rejects(main.evaluate(() => window.__TAURI_INTERNALS__.invoke('smoke_capture', { url: 'http://127.0.0.1:1559/video-partial.mp4', mediaKind: 'video' })), /完整|部分|分段/);
  await videoDrag.session.send('Input.dispatchDragEvent', {type:'dragCancel',x:0,y:0,data:videoDrag.data});
  await videoDrag.session.send('Input.dispatchMouseEvent', {type:'mouseReleased',x:0,y:0,button:'left',buttons:0});
  await videoDrag.session.detach();
  await source.locator('[data-explorer-drag-visual]').waitFor({state:'detached'});
  // Dragging text in a note above the feed must remain native text selection.
  const dragStartsBeforeSelection = await main.evaluate(() => window.nativeDragEvents.filter(event => event.phase === 'start').length);
  await source.evaluate(() => {
    const note = document.createElement('section');
    note.id = 'selection-note'; note.setAttribute('role', 'dialog');
    note.style.cssText = 'position:fixed;inset:0;background:white;z-index:100;padding:100px 20px;font:18px/28px sans-serif';
    note.innerHTML = '<span id="selection-text">Note text should remain selectable above the feed image.</span>';
    document.body.append(note);
  });
  const textRect = await source.locator('#selection-text').boundingBox();
  await source.mouse.move(textRect.x + 2, textRect.y + 10);
  await source.mouse.down();
  assert.equal(await source.locator('#selection-text').getAttribute('draggable'), null);
  await source.mouse.move(textRect.x + 210, textRect.y + 10, {steps:12});
  await source.mouse.up();
  assert.ok((await source.evaluate(() => String(window.getSelection()))).length > 5, 'note text is selectable in native WebView2');
  assert.equal(await main.evaluate(() => window.nativeDragEvents.filter(event => event.phase === 'start').length), dragStartsBeforeSelection, 'text selection never enters native capture');
  await source.evaluate(() => { document.querySelector('#selection-note').remove(); window.getSelection().removeAllRanges(); });
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
  await source.locator('#image').scrollIntoViewIfNeeded();
  const imageRect = await source.locator('#image').boundingBox();
  const resumedDrag = await startBrowserDrag(source, imageRect.x + 30, imageRect.y + 30);
  const payload = JSON.parse(resumedDrag.data.items.find(item => item.mimeType === 'application/x-bowerbird-explorer').data);
  await resumedDrag.session.send('Input.dispatchDragEvent', {type:'dragCancel',x:0,y:0,data:resumedDrag.data});
  await resumedDrag.session.send('Input.dispatchMouseEvent', {type:'mouseReleased',x:0,y:0,button:'left',buttons:0});
  await resumedDrag.session.detach();
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
  console.log(JSON.stringify({ ok: true, nativeWebView2: true, noteTextSelectionWithoutCapture: true, spotlightDimRestoresWithoutReload: true, spotlightSurvivesPageReload: true, browserGeneratedDragTransferredViaCdp: true, crossOriginImageWithoutCors: true, authenticatedVideoDragTransferredWithoutPosterFallback: true, partialVideoRejected: true,
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
