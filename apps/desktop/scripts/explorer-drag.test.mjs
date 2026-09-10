import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
import { startBrowserDrag, finishBrowserDrag } from "./fixtures/explorer/native-drag.mjs";

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const kind of ["image", "link-overlay", "card-overlay", "css-disabled", "site-cancel"]) {
    const page = await browser.newPage();
    await page.addInitScript(await readFile("../extension/candidate-utils.js", "utf8"));
    await page.addInitScript(await readFile("src-tauri/src/commands/source_browser_drag.js", "utf8"));
    await page.route("https://fixture.example/**", route => route.request().resourceType() === "image"
      ? route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="blue"/></svg>' })
      : route.fulfill({ contentType: "text/html", body: `<style>
        #card {position:relative;width:200px;height:200px} img {width:200px;height:200px}
        #overlay {position:absolute;inset:0} #drop {position:absolute;left:350px;top:0;width:300px;height:300px}
        ${kind === "css-disabled" ? "img {-webkit-user-drag:none}" : ""}
        </style><div id="card"><img draggable="false" src="/small.png" srcset="/small.png 1x, /large.png 2x">
        ${kind === "link-overlay" ? '<a id="overlay" href="/pin/1"></a>' : kind === "card-overlay" ? '<div id="overlay"></div>' : ""}
        </div><div id="drop">Drop</div>${kind === "site-cancel" ? '<script>window.addEventListener("dragstart", event => event.preventDefault(), true)</script>' : ""}` }));
    await page.goto("https://fixture.example/");
    await page.evaluate(() => {
      window.events = [];
      document.addEventListener("dragstart", e => window.events.push({ type: e.type, target: e.target.tagName }), true);
      const drop = document.querySelector("#drop");
      drop.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
      drop.addEventListener("drop", e => {
        e.preventDefault();
        window.dropped = { types: [...e.dataTransfer.types], payload: e.dataTransfer.getData("application/x-bowerbird-explorer"), text: e.dataTransfer.getData("text/plain") };
      });
    });
    // Browser-generated pointer/drag events: no synthetic DragEvent or hand-written payload.
    const { session, data } = await startBrowserDrag(page, 100, 100);
    await finishBrowserDrag(session, data, 450, 100);
    const result = await page.evaluate(() => ({ dropped: window.dropped, events: window.events }));
    assert.ok(result.dropped?.payload, `${kind}: ${JSON.stringify(result)}`);
    const payload = JSON.parse(result.dropped.payload);
    assert.equal(payload.imageUrl, "https://fixture.example/large.png");
    assert.equal(payload.pageUrl, kind === "link-overlay" ? "https://fixture.example/pin/1" : "https://fixture.example/");
    console.log(`${kind}: passed`);
    await page.close();
  }
} finally { await browser.close(); }
