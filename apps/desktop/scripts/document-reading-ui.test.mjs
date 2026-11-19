import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ cacheDir: ".tmp/document-reading-vite", server: { host: "127.0.0.1", port: 17994, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1550, height: 980 } });
  await page.addInitScript(() => {
    window.cardReads = 0;
    window.cardReadReplies = 0;
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (request, ...args) {
      if (request?.format === "card") {
        window.cardReads++;
        this.addEventListener("message", event => {
          if (typeof event.data?.result === "string") window.cardReadReplies++;
        }, { once: true });
      }
      return send.call(this, request, ...args);
    };
  });
  const url = server.resolvedUrls.local[0] + "scripts/fixtures/canvas-reference/preview.html";
  await page.goto(url);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const graph = window.snapshot();
    const text = "# 阅读标题\n\n- 项目 **强调**\n\n| 列甲 | 列乙 |\n| --- | --- |\n| 第一格 | 第二格 |\n\n"
      + Array.from({ length: 480 }, (_, n) => `第 ${n} 段 <span style="color:black;font-family:system-ui;font-size:16px">完整阅读文字</span>`).join("\n\n")
      + "\n\n<img src='https://example.invalid/private.png' onerror='window.previewExecuted=true'>\n\n末尾文字";
    graph.nodes = Array.from({ length: 36 }, (_, n) => ({ ...graph.nodes[0], id: "reading-" + n, kind: "note", role: null, assetId: null,
      x: n < 2 ? 280 + 380 * n : 5000 + n * 400, y: 100, width: 275, height: 367, payloadJson: JSON.stringify({ note_type: "document", title: "阅读卡", text }) }));
    graph.edges = []; graph.groups = []; graph.groupItems = [];
    graph.view = { ...graph.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(graph));
    localStorage.setItem("bowerbird.canvasSnapEnabled", "false");
  });
  await page.reload();
  const card = page.locator('[data-canvas-node-id="reading-0"]');
  const reading = card.locator(".canvas-document-reading");
  await reading.getByRole("heading", { name: "阅读标题" }).waitFor();
  await page.waitForFunction(() => window.cardReads >= 2);
  assert.equal(await page.locator(".is-document-card").count(), 36);
  assert.equal(await reading.locator("li strong").innerText(), "强调");
  assert.equal(await reading.locator("table th").count(), 2);
  assert.match(await reading.innerText(), /末尾文字/);
  assert.equal(await reading.locator("img, [style], script, iframe, [onerror]").count(), 0);
  const body = card.getByRole("region");
  await body.focus(); await page.keyboard.press("End");
  await page.waitForFunction(() => document.querySelector('[data-canvas-node-id="reading-0"] .text-file-excerpt').scrollTop > 100);
  await page.keyboard.press("Home");
  const reads = await page.evaluate(() => window.cardReads);
  assert.equal(reads, 2, "offscreen cards must not enqueue document parsing");
  await page.waitForFunction(() => window.cardReadReplies === window.cardReads);
  const title = card.locator(".text-file-title"), box = await title.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  const start = Date.now();
  await page.mouse.move(x + 90, y + 40, { steps: 12 }); await page.mouse.up();
  await page.waitForFunction(() => window.snapshot().nodes.find(node => node.id === "reading-0").x !== 280);
  assert.equal(await page.evaluate(() => window.cardReads), reads);
  console.log(`36 documents, 480 paragraphs each, ${reads} background card projections, drag persisted in ${Date.now() - start} ms with zero extra projections`);
  const result = await page.evaluate(async () => {
    const { documentPasteData } = await import("/src/lib/documentPaste.ts");
    const data = new DataTransfer();
    data.setData("text/plain", "正文");
    data.setData("text/html", '<p style="font-family:system-ui;font-size:16px;color:black"><b>正文</b><span style="color:red">强调</span></p>');
    const cleaned = documentPasteData(data);
    data.setData("application/x-slate-fragment", "internal");
    return { html: cleaned.getData("text/html"), text: cleaned.getData("text/plain"), internal: !documentPasteData(data) };
  });
  assert.doesNotMatch(result.html, /font-family|font-size/);
  assert.match(result.html, /red/); assert.match(result.html, /<b>正文<\/b>/);
  assert.equal(result.text, "正文"); assert.ok(result.internal);
} finally { await browser.close(); await server.close(); }
