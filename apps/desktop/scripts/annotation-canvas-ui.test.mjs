import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1563, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "图片标注", exact: true });
async function openAndDraw() {
  await page.evaluate(() => window.store.getState().openAnnotator("existing"));
  await dialog.getByAltText("合成参考 existing", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "添加到画板", exact: true }).isDisabled(), true);
  const box = await dialog.locator("svg.cursor-crosshair").boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
}
try {
  await page.goto("http://127.0.0.1:1563/scripts/fixtures/canvas-reference/preview.html?provisional&strict-canvas");
  await page.waitForFunction(async () => (await import('/src/lib/projectCanvasCallbacks.ts')).projectCanvasCallbacks.prepareAnnotation);
  await openAndDraw();
  await dialog.getByRole("button", { name: "文字", exact: true }).click();
  const overlay = dialog.locator("svg.cursor-crosshair");
  const textBox = await overlay.boundingBox();
  await page.mouse.click(textBox.x + textBox.width * 0.2, textBox.y + textBox.height * 0.65);
  const textInput = dialog.getByRole("textbox", { name: "文字内容" });
  await textInput.fill("可恢复的文字");
  await textInput.press("Control+Enter");
  await dialog.getByRole("button", { name: "添加到画板", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const saved = await page.evaluate(() => ({ calls: window.calls, snapshot: window.snapshot() }));
  const ingest = saved.calls.find(call => call.command === "save_annotated_image");
  assert.equal(ingest.args.projectId, "p");
  assert.equal(ingest.args.fileName, "合成参考 existing-标注");
  const meta = JSON.parse(ingest.args.annotationJson);
  assert.equal(meta.source_asset_id, "existing");
  assert.match(meta.source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(meta.editable.base.kind, "asset");
  assert.deepEqual(meta.shapes.map(shape => shape.type), ["rect", "text"]);
  assert.match(meta.shapes[0].token, /<bbox>/);
  assert.ok(saved.calls.findIndex(call => call.command === "project_canvas_materialize") < saved.calls.indexOf(ingest));
  assert.equal(saved.calls.some(call => call.command === "save_annotation_temp"), false);
  const node = saved.snapshot.nodes.find(node => node.assetId?.startsWith("draft-"));
  assert.ok(node);
  assert.equal(node.projectId, "p");
  const card = page.locator(`[data-canvas-node-id="${node.id}"]`);
  await card.waitFor();
  const box = await card.boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x < 1800 && box.y < 1000);

  await page.evaluate(id => window.store.getState().openAnnotator(id), node.assetId);
  const saveRevision = dialog.getByRole("button", { name: "保存修改", exact: true });
  await overlay.locator("[data-annotation-text]").waitFor();
  assert.equal(await saveRevision.isDisabled(), true, "restored shapes do not make a revision dirty");
  await dialog.getByRole("button", { name: "清空", exact: true }).click();
  assert.equal(await saveRevision.isEnabled(), true, "clearing all restored shapes is a saveable change");
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  assert.equal(await saveRevision.isDisabled(), true, "undo back to the restored state disables save");
  await dialog.getByRole("button", { name: "垂直镜像", exact: true }).click();
  await saveRevision.click();
  await dialog.waitFor({ state: "hidden" });
  const revision = await page.evaluate(() => window.calls.filter(call => call.command === "save_annotated_image").at(-1).args);
  const revisionMeta = JSON.parse(revision.annotationJson);
  assert.equal(revision.overwrite.assetId, node.assetId);
  assert.equal(revisionMeta.source_sha256, meta.source_sha256);
  assert.deepEqual(revisionMeta.transform, [{ kind: "flip", axis: "vertical" }]);
  assert.equal(revisionMeta.editable.shapes[0].y1, 1 - meta.editable.shapes[0].y1);

  for (const field of ["textSource", "textWidthRatio", "fontFamily", "fontWeight", "points", "shortPoints"]) {
    await page.evaluate(({ id, field }) => {
      const ipc = window.__TAURI_INTERNALS__;
      const invoke = ipc.invoke;
      ipc.invoke = async (command, args) => {
        const records = await invoke(command, args);
        if (command !== "list_analyses_by_asset" || args.assetId !== id) return records;
        ipc.invoke = invoke;
        const record = JSON.parse(records[0].payload);
        const text = record.editable.shapes.find(shape => shape.type === "text");
        if (field === "shortPoints") text.points = text.points.slice(0, 2);
        else delete text[field];
        return [{ ...records[0], payload: JSON.stringify(record) }];
      };
      window.store.getState().openAnnotator(id);
    }, { id: node.assetId, field });
    await dialog.getByRole("status").filter({ hasText: "无法恢复标注编辑文档，将以当前扁平图继续标注" }).waitFor();
    assert.equal(await saveRevision.isDisabled(), true, `invalid text ${field} falls back to an unchanged flat revision`);
    assert.equal(await overlay.locator("[data-annotation-text]").count(), 0);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  }

  await page.evaluate(id => {
    const image = document.createElement("canvas");
    image.width = 190; image.height = 150;
    window.templateImageData = image.toDataURL();
    window.store.getState().openAnnotator(id);
  }, node.assetId);
  await dialog.getByRole("status").filter({ hasText: "原图已变更或不可用" }).waitFor();
  await dialog.getByRole("button", { name: "画框", exact: true }).click();
  const fallback = await dialog.locator("svg.cursor-crosshair").boundingBox();
  await page.mouse.move(fallback.x + fallback.width * 0.3, fallback.y + fallback.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(fallback.x + fallback.width * 0.6, fallback.y + fallback.height * 0.6);
  await page.mouse.up();
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const flattened = await page.evaluate(() => window.calls.filter(call => call.command === "save_annotated_image").at(-1).args);
  assert.equal(flattened.overwrite.assetId, node.assetId);
  assert.equal(JSON.parse(flattened.annotationJson).editable, undefined);
  assert.equal(await page.evaluate(() => window.snapshot().nodes.filter(item => item.assetId?.startsWith("draft-")).length), 1);

  await page.evaluate(() => window.save());
  await page.reload();
  await card.waitFor();

  // Retry a failed node write without ingesting a second copy of the image.
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.failAnnotationNode = true;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "project_canvas_node_create" && window.failAnnotationNode) throw "模拟标注卡片保存失败";
      return invoke(command, args);
    };
  });
  await openAndDraw();
  await dialog.getByRole("button", { name: "添加到画板", exact: true }).click();
  await page.getByText("模拟标注卡片保存失败", { exact: false }).first().waitFor();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId?.startsWith("draft-")).length), 1);
  await page.evaluate(() => { window.failAnnotationNode = false; });
  await dialog.getByRole("button", { name: "添加到画板", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "save_annotated_image").length), 1);
  assert.equal(await page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId?.startsWith("draft-")).length), 2);

  await page.evaluate(async () => {
    const { projectCanvasCallbacks } = await import('/src/lib/projectCanvasCallbacks.ts');
    projectCanvasCallbacks.prepareAnnotation = null;
    window.store.getState().openAnnotator("existing");
  });
  assert.equal(await dialog.getByRole("button", { name: "添加到画板", exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log("PASS annotation canvas: provisional project, metadata, dirty revision, invalid text fallback, reload and retry without duplicate ingestion");
} finally { await browser.close(); await server.close(); }
