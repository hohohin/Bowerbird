import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
const server = await createServer({ server: { host: "127.0.0.1", port: 1578, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
const errors = []; page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "分层编辑", exact: true });
const confirm = page.getByRole("dialog", { name: "转为可编辑文字", exact: true });
const inline = dialog.getByLabel("画布文字内容");
const cloudRecognitionLabel = "识别文字后编辑（云端）";
const textMessage = "把该图层转变为空白文字对象（沿用框体）。转变后会丢失原图样式及文本内容。可使用本机字体进行替换。";
const imageMessage = textMessage;
try {
  await page.goto("http://127.0.0.1:1578/scripts/fixtures/layers/preview.html");
  assert.equal(await page.getByLabel("有分层工程").count(), 0);
  await page.evaluate(() => sessionStorage.setItem("layer-workspace", JSON.stringify({ document: window.documentFixture, pending: null })));
  await page.reload();
  await page.getByLabel("有分层工程").waitFor();
  await page.evaluate(() => { window.store.setState({ cloudAuth: { logged_in: false, cloud_available: false } }); });
  await page.getByRole("button", { name: "打开分层编辑", exact: true }).click();
  await dialog.getByLabel("图层名称").waitFor();
  await dialog.locator('[data-layer-id="circle"]').dblclick();
  await confirm.getByRole("tab", { name: "创建空白文字对象", exact: true }).click();
  assert.equal(await confirm.locator("p").textContent(), imageMessage);
  await confirm.getByRole("tab", { name: cloudRecognitionLabel, exact: true }).click();
  assert.equal(await confirm.getByRole("button", { name: "确认", exact: true }).isDisabled(), true);
  assert.ok(!(await confirm.textContent()).includes("沿用云端图像理解的计费与次数限制"));
  await page.keyboard.press("ArrowRight");
  assert.equal(await confirm.getByRole("tab", { name: "创建空白文字对象", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await confirm.getByRole("button", { name: "确认", exact: true }).isEnabled(), true);
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === "layer_text_request").length), 0, "switching tabs must not submit recognition");
  await page.screenshot({ path: ".tmp/layer-text-convert-tabs.png" });
  await page.keyboard.press("Escape");
  await confirm.waitFor({ state: "hidden" });
  await dialog.waitFor();
  assert.equal(await dialog.locator('[data-layer-id="circle"] img').count(), 1);
  await dialog.locator('[data-layer-id="title"]').dblclick();
  await confirm.getByRole("tab", { name: "创建空白文字对象", exact: true }).click();
  assert.equal(await confirm.locator("p").textContent(), textMessage);
  await confirm.getByRole("tab", { name: "创建空白文字对象", exact: true }).click();
  await confirm.getByRole("button", { name: "确认", exact: true }).click();
  await inline.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "画布文字内容");
  assert.equal(await inline.inputValue(), "", "conversion must not inherit original text");
  const original = await page.evaluate(() => window.documentFixture.layers[2].dataUrl);
  await page.keyboard.insertText("可编辑文字");
  await page.keyboard.press("Enter");
  await page.keyboard.type("BOWER BIRD");
  assert.equal(await dialog.getByLabel("文字内容", { exact: true }).inputValue(), "可编辑文字\nBOWER BIRD");
  // Composition Enter/Escape must not close the inline editor or parent panel.
  await inline.dispatchEvent("compositionstart", { data: "" });
  await inline.dispatchEvent("keydown", { key: "Escape", code: "Escape", isComposing: true });
  await inline.dispatchEvent("compositionend", { data: "" });
  assert.equal(await inline.count(), 1);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("X");
  assert.equal(await inline.inputValue(), "可编辑文字\nBXOWER BIRD", "caret insertion stays inside the canvas text");
  await inline.fill("可编辑文字\nBOWERBIRD");
  await page.keyboard.press("Control+z");
  assert.equal(await inline.inputValue(), "", "Ctrl+Z undoes inline text without leaking to the project canvas");
  await inline.fill("可编辑文字\nBOWERBIRD");
  await page.screenshot({ path: ".tmp/layer-text-inline.png" });
  await page.keyboard.press("Escape");
  assert.equal(await inline.count(), 0);
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  assert.equal(await dialog.getByLabel("文字内容", { exact: true }).inputValue(), "", "one undo clears the whole inline edit session");
  await dialog.locator('[data-layer-id="title"]').dblclick();
  await inline.fill("可编辑文字\nBOWERBIRD");
  await dialog.getByRole("combobox", { name: "文字字体", exact: true }).click();
  await page.getByRole("option", { name: "SimSun", exact: true }).click();
  await dialog.getByLabel("文字字号").fill("30");
  await dialog.getByLabel("文字字距").fill("3");
  const alignment = dialog.getByRole("combobox", { name: "文字对齐", exact: true });
  await alignment.evaluate(node => node.scrollIntoView({ block: "center", behavior: "instant" }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await alignment.click();
  await page.getByRole("option", { name: "居中", exact: true }).click();
  assert.equal(await alignment.textContent(), "居中");
  await dialog.getByLabel("文字颜色").fill("#ff0000");
  await page.evaluate(() => { window.store.setState({ layerWorkspaceIds: new Set() }); window.failSave = true; });
  await dialog.getByRole("button", { name: "保存图层工程", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "模拟磁盘保存失败" }).waitFor();
  assert.equal(await page.getByLabel("有分层工程").count(), 0, "failed save must not add badge");
  await page.evaluate(() => { window.failSave = false; });
  await dialog.getByRole("button", { name: "保存图层工程", exact: true }).click();
  await page.waitForFunction(() => window.saved().document.layers[2].text?.color === "#ff0000");
  assert.equal(await page.getByLabel("有分层工程").count(), 1, "save refreshes thumbnail badge");
  await dialog.locator('[data-layer-id="title"]').dblclick();
  assert.equal(await confirm.count(), 0);
  await inline.waitFor();
  // Zoomed inline input still edits content without changing layer geometry.
  await inline.hover(); await page.mouse.wheel(0, -120);
  await page.keyboard.press("Control+End"); await page.keyboard.type("!");
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "合成图片入库", exact: true }).click();
  await page.waitForFunction(() => window.exports.length === 1);
  const checks = await page.evaluate(async () => {
    const { renderLayerDocument } = await import("/src/lib/layerDocument.ts");
    const output = window.exports[0]; const layer = output.document.layers[2];
    const image = new Image(); image.src = output.dataUrl; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(140, 85, 700, 100).data; let red = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i+1] < 60 && data[i+2] < 60) red++;
    return { same: await renderLayerDocument(output.document) === output.dataUrl, red, layer, badge: window.store.getState().layerWorkspaceIds.has("exported") };
  });
  assert.ok(checks.same && checks.red > 50 && checks.badge);
  assert.equal(checks.layer.text.fontFamily, "SimSun"); assert.equal(checks.layer.text.content, "可编辑文字\nBOWERBIRD!");
  assert.equal(checks.layer.x, 140); assert.equal(checks.layer.width, 700);
  assert.equal(checks.layer.dataUrl, original);
  await page.screenshot({ path: ".tmp/layer-text-editor.png" });
  await dialog.getByRole("button", { name: "暂时退出", exact: true }).click();
  await page.getByRole("button", { name: "打开分层编辑", exact: true }).click();
  await dialog.getByLabel("文字内容", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("combobox", { name: "文字字体", exact: true }).textContent(), "SimSun");
  assert.equal(await dialog.getByLabel("文字内容", { exact: true }).inputValue(), "可编辑文字\nBOWERBIRD!");
  await dialog.getByRole("button", { name: "恢复原图片层" }).click();
  assert.equal(await dialog.locator('[data-layer-id="title"] img').getAttribute("src"), original);
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  assert.equal(await dialog.getByLabel("文字内容", { exact: true }).inputValue(), "可编辑文字\nBOWERBIRD!");
  await dialog.getByRole("button", { name: "恢复原图片层" }).click();
  await dialog.getByRole("button", { name: "合成图片入库", exact: true }).click();
  await page.waitForFunction(() => window.exports.length === 2);
  assert.ok(await page.evaluate(async () => {
    const { renderLayerDocument } = await import("/src/lib/layerDocument.ts");
    return window.exports[1].dataUrl === await renderLayerDocument(window.documentFixture);
  }), "image mode exports the raster, not the retained text");
  assert.deepEqual(await page.evaluate(() => window.saved().document.layers[2].textBackup), checks.layer.text);
  await dialog.getByRole("button", { name: "暂时退出", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "打开分层编辑", exact: true }).click();
  await dialog.getByRole("button", { name: "切换为文字图层", exact: true }).click();
  await inline.waitFor();
  assert.equal(await confirm.count(), 0, "saved text switches back without conversion confirmation");
  assert.equal(await inline.inputValue(), "可编辑文字\nBOWERBIRD!");
  assert.equal(await dialog.getByRole("combobox", { name: "文字字体", exact: true }).textContent(), "SimSun");
  assert.equal(await dialog.getByLabel("文字颜色").inputValue(), "#ff0000");
  assert.equal(await dialog.getByLabel("文字字距").inputValue(), "3");
  await inline.fill("再次修改");
  await dialog.getByRole("button", { name: "恢复原图片层" }).click();
  await dialog.getByRole("button", { name: "标题文字", exact: true }).dblclick();
  await inline.waitFor();
  assert.equal(await confirm.count(), 0);
  assert.equal(await inline.inputValue(), "再次修改", "repeated switches preserve the latest edits");
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "圆形装饰", exact: true }).dblclick();
  await confirm.getByRole("tab", { name: "创建空白文字对象", exact: true }).click();
  assert.equal(await confirm.locator("p").textContent(), imageMessage);
  await confirm.getByRole("tab", { name: "创建空白文字对象", exact: true }).click();
  await confirm.getByRole("button", { name: "确认", exact: true }).click();
  await inline.fill("装饰文字");
  await page.keyboard.press("Escape");
  const preview = await dialog.getByLabel("图层画布").boundingBox();
  await page.mouse.click(preview.x + 4, preview.y + preview.height - 4);
  assert.equal(await dialog.locator(".layer-object.is-selected").count(), 0);
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === "layer_text_request").length), 0, "all new conversions work offline without OCR");
  await page.evaluate(() => sessionStorage.setItem("layer-workspace", JSON.stringify({ document: window.documentFixture, pending: null, textPending: { idempotencyKey: "legacy-unsent", userId: "user-original", layerId: "title", image: { mime: "image/jpeg", base64: "unused" } } })));
  await page.reload();
  await page.getByRole("button", { name: "打开分层编辑", exact: true }).click();
  await dialog.getByRole("button", { name: "继续取回文字识别" }).click();
  await page.waitForFunction(() => window.saved().textPending === null);
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === "layer_text_request" && c.args.request.action === "create").length), 0, "legacy unsent jobs are cleared without starting OCR");
  assert.equal(await dialog.locator('[data-layer-id="title"] img').count(), 1);
  // Explicit recognition persists its original key, then recovers without a duplicate create.
  await dialog.getByRole("button", { name: "标题文字", exact: true }).dblclick();
  await page.evaluate(() => { window.textDisconnect = true; });
  await confirm.getByRole("tab", { name: cloudRecognitionLabel, exact: true }).click();
  await confirm.getByRole("button", { name: "确认", exact: true }).click();
  await dialog.getByRole("button", { name: "继续取回文字识别" }).waitFor();
  assert.equal(await page.evaluate(() => window.saved().textPending.allowCreate), true);
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === "layer_text_request" && c.args.request.action === "create").length), 1);
  await page.reload();
  await page.getByRole("button", { name: "打开分层编辑", exact: true }).click();
  await dialog.getByRole("button", { name: "继续取回文字识别" }).click();
  await inline.waitFor();
  assert.equal(await inline.inputValue(), "BOWERBIRD");
  await dialog.getByRole("button", { name: "恢复原图片层" }).click();
  await dialog.getByRole("button", { name: "切换为文字图层", exact: true }).click();
  assert.equal(await inline.inputValue(), "BOWERBIRD");
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === "layer_text_request" && c.args.request.action === "create").length), 0);
  // Saving the request must succeed before any new billable recognition starts.
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "圆形装饰", exact: true }).dblclick();
  await page.evaluate(() => { window.failSave = true; });
  await confirm.getByRole("tab", { name: cloudRecognitionLabel, exact: true }).click();
  await confirm.getByRole("button", { name: "确认", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "模拟磁盘保存失败" }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === "layer_text_request" && c.args.request.action === "create").length), 0);
  // No detected text keeps the raster intact and unlocks the blank conversion option.
  await page.evaluate(() => { window.failSave = false; window.noText = true; });
  await dialog.getByRole("button", { name: "圆形装饰", exact: true }).dblclick();
  await confirm.getByRole("tab", { name: cloudRecognitionLabel, exact: true }).click();
  await confirm.getByRole("button", { name: "确认", exact: true }).click();
  await page.waitForFunction(() => window.saved().textPending === null && window.calls.some(c => c.command === "layer_text_request" && c.args.request.action === "create"));
  assert.equal(await dialog.locator('[data-layer-id="circle"] img').count(), 1);
  assert.equal(await dialog.locator('[data-layer-id="circle"] textarea').count(), 0);
  await dialog.getByRole("button", { name: "圆形装饰", exact: true }).dblclick();
  await confirm.getByRole("tab", { name: "创建空白文字对象", exact: true }).click();
  await confirm.getByRole("button", { name: "确认", exact: true }).click();
  assert.equal(await inline.inputValue(), "");

  // Native OCR arrives with the raster in the split result and can be used offline.
  await page.evaluate(() => {
    const document = structuredClone(window.documentFixture);
    document.layers[2].textRecognition = {
      text: "RED BLUE\n第二行",
      lines: [
        { bounding_box: { absolute: [140, 85, 310, 115] }, runs: [
          { text: "RED ", style: { similar_font_family: "arial", foreground_color: "#FF0000", bold: true, italic: true, underline: true } },
          { text: "BLUE", style: { similar_font_family: "Fixture Missing Font", foreground_color: "#0000FF", bold: false, strikethrough: true, shadow: true } },
        ] },
        { bounding_box: { absolute: [140, 124, 250, 154] }, runs: [
          { text: "第二行", style: { similar_font_family: "SimSun", foreground_color: "#FF0000", bold: true } },
        ] },
      ],
    };
    sessionStorage.setItem("layer-workspace", JSON.stringify({ document, pending: null }));
  });
  await page.reload();
  await page.evaluate(() => { window.store.setState({ cloudAuth: { logged_in: false, cloud_available: false } }); });
  await page.getByRole("button", { name: "打开分层编辑", exact: true }).click();
  await dialog.getByRole("button", { name: "转为可编辑文字", exact: true }).click();
  await inline.waitFor();
  assert.equal(await confirm.count(), 0);
  assert.equal(await inline.inputValue(), "RED BLUE\n第二行");
  assert.equal(await dialog.getByLabel("文字字号").inputValue(), "30", "infer font size from line bounds");
  assert.equal(await dialog.getByRole("combobox", { name: "文字字体", exact: true }).textContent(), "Arial");
  assert.equal(await dialog.getByRole("button", { name: "斜体", exact: true }).getAttribute("aria-pressed"), "mixed");
  await dialog.getByText(/Fixture Missing Font/).waitFor();
  await inline.fill("+RED BLUE\n第二行");
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "保存图层工程", exact: true }).click();
  const native = await page.evaluate(async () => {
    const layer = window.saved().document.layers[2];
    const { paintLayerText } = await import("/src/lib/layerDocument.ts");
    const canvas = document.createElement("canvas"); canvas.width = layer.text.boxWidth; canvas.height = layer.text.boxHeight;
    const ctx = canvas.getContext("2d");
    paintLayerText(ctx, layer.text);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0, blue = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 180 && pixels[i + 2] < 60 && pixels[i + 3] > 127) red++;
      if (pixels[i + 2] > 180 && pixels[i] < 60 && pixels[i + 3] > 127) blue++;
    }
    return { text: layer.text, red, blue, recognitionCalls: window.calls.filter(call => call.command === "layer_text_request").length };
  });
  assert.equal(native.recognitionCalls, 0);
  assert.ok(native.red > 50 && native.blue > 50, "Canvas renders the mixed original colors");
  assert.equal(native.text.runs[0].start, 5);
  assert.equal(native.text.runs[0].strikethrough, true);
  assert.equal(native.text.runs[0].shadow, true);
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  await dialog.getByRole("button", { name: "标题文字", exact: true }).dblclick();
  assert.equal(await inline.inputValue(), "RED BLUE\n第二行", "native recognition works from layer double-click after undo");
  assert.deepEqual(errors, []);
  console.log("PASS badges, conversion and inline edits, OCR recovery, native OCR with mixed text styles, font fallback and zero extra Cloud calls");
} finally { await browser.close(); await server.close(); }
