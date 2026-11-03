import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const adapter = await readFile(process.env.BOWERBIRD_PINTEREST_ADAPTER_PATH || "src-tauri/src/commands/source_browser_pinterest.js", "utf8");
const coverageOutput = process.env.BOWERBIRD_PINTEREST_COVERAGE_PATH;
const coverageEntries = [];
const coveredPages = new Set();
const pixels = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Qy4AAAAASUVORK5CYII=";
const script = (requestId = "first", documentAfter = 0, handedOff = false) => adapter
  .replace("__BOWERBIRD_PINTEREST_REQUEST__", JSON.stringify({ requestId, base64: handedOff ? '' : pixels, mime: "image/png", name: "search.png", documentAfter, handedOff }))
  .replace("__BOWERBIRD_PINTEREST_BRIDGE__", "bowerbird-pinterest://fixture")
  + (coverageOutput ? "\n//# sourceURL=bowerbird-pinterest-adapter.js" : "");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const uploadHtml = '<script id="__PWS_DATA__" type="application/json">{"context":{"is_authenticated":true}}</script><div data-test-id="lens-file-upload"><input id="lens-file-upload" data-test-id="lens-file-upload" type="file" accept="image/*"></div><input id="pin-composer" type="file">';
async function collectCoverage(page) {
  if (coveredPages.delete(page)) coverageEntries.push(...await page.coverage.stopJSCoverage());
}
async function pageFor(html, url = "https://www.pinterest.com/") {
  const page = await browser.newPage();
  if (coverageOutput) {
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
    coveredPages.add(page);
    const close = page.close.bind(page);
    page.close = async options => { await collectCoverage(page); return close(options); };
  }
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
  const pending = await pageFor(uploadHtml);
  await pending.evaluate(() => {
    window.changes = 0;
    document.querySelector('#lens-file-upload').addEventListener('change', () => window.changes++);
  });
  await pending.evaluate(script('pending-upload'));
  await pending.clock.runFor(500);
  assert.deepEqual(await pending.evaluate(() => window.notices.map(n => n.status)), ['searching'],
    'dispatching change does not mean Pinterest accepted the image or opened search results');
  await pending.clock.runFor(5_000);
  assert.equal(await pending.evaluate(() => window.changes), 1, 'an upload in flight is never submitted twice');
  await pending.evaluate(() => history.pushState({}, '', '/lens-search/?fixture=1'));
  await pending.clock.runFor(500);
  assert.deepEqual(await pending.evaluate(() => window.notices.map(n => n.status)), ['searching', 'submitted']);
  await pending.close();
  console.log('Pinterest adapter: completion waits for the website search route');

  for (const failure of ['rejected', 'unhandled']) {
    const failed = await pageFor(uploadHtml);
    await failed.evaluate(script(failure));
    if (failure === 'rejected') await failed.evaluate(() => document.querySelector('#lens-file-upload').setAttribute('aria-invalid', 'true'));
    await failed.clock.runFor(failure === 'rejected' ? 500 : 121_000);
    assert.deepEqual(await failed.evaluate(() => window.notices.map(n => n.status)), ['searching', 'error'], failure);
    await failed.close();
  }
  const resumed = await pageFor(uploadHtml, 'https://www.pinterest.com/lens-search/');
  await watchUploads(resumed);
  await resumed.evaluate(script('already-handed-off', 0, true));
  assert.equal(await resumed.evaluate(() => window.uploads.length), 0, 'full navigation after upload must not resend pixels');
  assert.deepEqual(await resumed.evaluate(() => window.notices.map(n => n.status)), ['submitted']);
  await resumed.close();
  console.log('Pinterest adapter: upload failures and result-document continuation passed');

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
      setTimeout(() => {
        document.body.insertAdjacentHTML("beforeend", '<input id="lens-file-upload" data-test-id="lens-file-upload" type="file">');
        document.querySelector('#lens-file-upload').onchange = () => history.pushState({}, '', '/lens-search/');
      }, 500);
    };
    document.body.append(button);
  });
  await delayed.clock.runFor(1500);
  // The input was inserted and consumed while the initial auth JSON stayed stale.
  assert.deepEqual(await delayed.evaluate(() => ({ clicks: window.lensClicks, statuses: window.notices.map(n => n.status) })),
    { clicks: 1, statuses: ["waiting-login", "searching", "submitted"] });
  await delayed.close();
  console.log("Pinterest adapter: SPA login, Lens click and delayed uploader passed");

  const hydration = await pageFor('<button aria-label="Lens">Lens</button>');
  await hydration.evaluate(script('hydration'));
  await hydration.clock.runFor(500);
  await hydration.evaluate(() => {
    window.lensClicks = 0;
    document.querySelector('button').onclick = () => {
      window.lensClicks++;
      document.body.insertAdjacentHTML('beforeend', '<input id="lens-file-upload" data-test-id="lens-file-upload" type="file">');
      document.querySelector('input').onchange = () => history.pushState({}, '', '/lens-search/');
    };
  });
  await hydration.clock.runFor(1500);
  assert.deepEqual(await hydration.evaluate(() => ({ clicks: window.lensClicks, statuses: window.notices.map(n => n.status) })),
    { clicks: 1, statuses: ['searching', 'submitted'] }, 'server-rendered Lens becomes actionable after React hydration');
  await hydration.close();

  const slowPopover = await pageFor('<button aria-label="Lens">Lens</button>');
  await slowPopover.evaluate(() => {
    window.lensClicks = 0;
    document.querySelector('button').onclick = () => {
      window.lensClicks++;
      const popover = document.querySelector('[aria-label="Lens popover"]');
      if (popover) return popover.remove();
      document.body.insertAdjacentHTML('beforeend', '<div aria-label="Lens popover"></div>');
      setTimeout(() => {
        const target = document.querySelector('[aria-label="Lens popover"]');
        if (!target) return;
        target.innerHTML = '<input id="lens-file-upload" data-test-id="lens-file-upload" type="file">';
        target.querySelector('input').onchange = () => history.pushState({}, '', '/lens-search/');
      }, 2000);
    };
  });
  await slowPopover.evaluate(script('slow-popover'));
  await slowPopover.clock.runFor(3000);
  assert.deepEqual(await slowPopover.evaluate(() => ({ clicks: window.lensClicks, statuses: window.notices.map(n => n.status) })),
    { clicks: 1, statuses: ['searching', 'submitted'] }, 'waiting for the file input must not toggle the Lens popover closed');
  await slowPopover.close();
  console.log('Pinterest adapter: hydration and delayed open popover passed');

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
  try {
    for (const page of coveredPages) await collectCoverage(page);
    if (coverageOutput) await writeFile(coverageOutput, JSON.stringify(coverageEntries));
  } finally {
    await browser.close();
  }
}
