import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const adapter = await readFile("src-tauri/src/commands/source_browser_pinterest.js", "utf8");
const pixels = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Qy4AAAAASUVORK5CYII=";
const script = (requestId = "first", documentAfter = 0) => adapter
  .replace("__BOWERBIRD_PINTEREST_REQUEST__", JSON.stringify({ requestId, base64: pixels, mime: "image/png", name: "search.png", documentAfter }))
  .replace("__BOWERBIRD_PINTEREST_BRIDGE__", "bowerbird-pinterest://fixture");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const uploadHtml = '<script id="__PWS_DATA__" type="application/json">{"context":{"is_authenticated":true}}</script><div data-test-id="lens-file-upload"><input id="lens-file-upload" data-test-id="lens-file-upload" type="file" accept="image/*"></div><input id="pin-composer" type="file">';
async function pageFor(html, url = "https://www.pinterest.com/") {
  const page = await browser.newPage();
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(url);
  await page.clock.install();
  await page.evaluate(() => {
    window.notices = [];
    window.open = url => { window.notices.push(JSON.parse(new URL(url).searchParams.get("data"))); return null; };
  });
  return page;
}
async function watchUploads(page) {
  await page.evaluate(() => {
    window.uploads = [];
    for (const input of document.querySelectorAll('input[type="file"]')) input.addEventListener("change", async () => {
      const file = input.files[0];
      window.uploads.push({ id: input.id, name: file.name, mime: file.type, bytes: [...new Uint8Array(await file.arrayBuffer())] });
      history.replaceState({}, "", "/lens-search/");
    });
  });
}

try {
  const login = await pageFor('<script id="__PWS_DATA__" type="application/json">{"context":{"is_authenticated":false}}</script><input type="password">');
  await login.evaluate(script());
  assert.equal(await login.evaluate(() => window.notices[0]?.status), "waiting-login", "the pending image waits for Pinterest login");
  await login.clock.fastForward(60_000);
  assert.equal(await login.evaluate(() => window.notices.length), 1, "login notice is not repeated or mistaken for a missing uploader");
  await login.close();
  console.log("Pinterest adapter: login wait passed");

  const upload = await pageFor(uploadHtml);
  await watchUploads(upload);
  await upload.evaluate(script());
  await upload.waitForFunction(() => window.uploads.length === 1);
  const uploaded = await upload.evaluate(() => window.uploads[0]);
  assert.equal(uploaded.id, "lens-file-upload", "only the observed Lens uploader receives a file");
  assert.equal(uploaded.name, "search.png");
  assert.equal(uploaded.mime, "image/png");
  assert.deepEqual(Buffer.from(uploaded.bytes), Buffer.from(pixels, "base64"));
  assert.ok(upload.url().endsWith("/lens-search/"), "the website's change handler controls the results route");
  await upload.evaluate(script());
  await upload.clock.fastForward(5_000);
  assert.equal(await upload.evaluate(() => window.uploads.length), 1, "reinjection never submits twice");
  assert.deepEqual(await upload.evaluate(() => window.notices.map(notice => notice.status)), ["searching", "submitted"]);
  await upload.close();
  console.log("Pinterest adapter: actual File/change handoff and deduplication passed");

  const delayed = await pageFor('<script id="__PWS_DATA__" type="application/json">{"context":{"is_authenticated":false}}</script><input type="password">');
  await delayed.evaluate(script());
  await delayed.evaluate(() => {
    document.querySelector('input[type="password"]').remove();
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Lens"); button.textContent = "Lens";
    window.lensClicks = 0;
    button.onclick = () => {
      window.lensClicks++;
      setTimeout(() => document.body.insertAdjacentHTML("beforeend", '<input id="lens-file-upload" data-test-id="lens-file-upload" type="file">'), 500);
    };
    document.body.append(button);
  });
  await delayed.clock.runFor(1000);
  // The input was inserted and consumed while the initial auth JSON stayed stale.
  assert.deepEqual(await delayed.evaluate(() => ({ clicks: window.lensClicks, statuses: window.notices.map(n => n.status) })),
    { clicks: 1, statuses: ["waiting-login", "searching", "submitted"] });
  await delayed.close();
  console.log("Pinterest adapter: SPA login, Lens click and delayed uploader passed");

  const cancelled = await pageFor('<script id="__PWS_DATA__" type="application/json">{"context":{"is_authenticated":true}}</script>');
  await cancelled.evaluate(script("cancelled"));
  await cancelled.evaluate(() => window.__bowerbirdPinterestSearch.cancel("cancelled"));
  await cancelled.evaluate(html => document.body.insertAdjacentHTML("beforeend", html), uploadHtml);
  await watchUploads(cancelled);
  await cancelled.clock.runFor(500);
  assert.equal(await cancelled.evaluate(() => window.uploads.length), 0, "cancel before uploader appears never sends the image");
  await cancelled.close();

  const replaced = await pageFor('<script id="__PWS_DATA__" type="application/json">{"context":{"is_authenticated":true}}</script>');
  await replaced.evaluate(script("old"));
  await replaced.evaluate(script("new"));
  await replaced.evaluate(() => window.__bowerbirdPinterestSearch.cancel("old"));
  await replaced.evaluate(html => document.body.insertAdjacentHTML("beforeend", html), uploadHtml);
  await watchUploads(replaced);
  await replaced.clock.runFor(500);
  assert.equal(await replaced.evaluate(() => window.uploads.length), 1);
  assert.deepEqual(await replaced.evaluate(() => [...new Set(window.notices.map(n => n.requestId))]), ["new"]);
  await replaced.close();
  console.log("Pinterest adapter: cancellation and replacement passed");

  const busy = await pageFor(uploadHtml);
  await busy.evaluate(() => {
    window.ignoredChanges = 0;
    document.querySelector("#lens-file-upload").onchange = () => { window.ignoredChanges++; };
  });
  const nextDocument = await busy.evaluate(() => performance.timeOrigin + 1);
  await busy.evaluate(script("new-document-only", nextDocument));
  await busy.clock.fastForward(500);
  assert.equal(await busy.evaluate(() => window.ignoredChanges + window.notices.length), 0,
    "a late old-document callback cannot submit into Pinterest's busy, non-disabled uploader");
  await busy.close();
  console.log("Pinterest adapter: stale busy document rejected");

  for (const url of ["https://pinterest.com.evil.test/", "http://www.pinterest.com/", "https://www.pinterest.com:8443/", "https://example.com/"]) {
    const denied = await pageFor(uploadHtml, url);
    await watchUploads(denied);
    await denied.evaluate(() => { Array.prototype.includes = () => true; });
    await denied.evaluate(script());
    await denied.clock.fastForward(31_000);
    assert.equal(await denied.evaluate(() => window.uploads.length + window.notices.length), 0, url);
    await denied.close();
  }
  const framePage = await pageFor('<iframe srcdoc="<p>child frame</p>"></iframe>');
  const child = framePage.frames().find(frame => frame !== framePage.mainFrame());
  assert.ok(child);
  await child.evaluate(script());
  assert.equal(await child.evaluate(() => window.__bowerbirdPinterestSearch), undefined, "subframes cannot run the handoff");
  await framePage.close();

  const missing = await pageFor('<script id="__PWS_DATA__" type="application/json">{"context":{"is_authenticated":true}}</script><input id="pin-composer" type="file">');
  await watchUploads(missing);
  await missing.evaluate(script());
  await missing.clock.fastForward(31_000);
  assert.equal(await missing.evaluate(() => window.notices.at(-1)?.status), "error");
  assert.equal(await missing.evaluate(() => window.uploads.length), 0, "a Pin creation input must never receive the image");
  await missing.close();
  console.log("Pinterest adapter: exact origin, top frame and unsupported page passed");
} finally {
  await browser.close();
}
