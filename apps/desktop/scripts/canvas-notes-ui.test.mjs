import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1568, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1800, height: 1200 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const stage = page.locator(".canvas-stage");
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
async function drag(x1, y1, x2, y2) {
  const box = await stage.boundingBox();
  await page.mouse.move(box.x + x1, box.y + y1);
  await page.mouse.down();
  await page.mouse.move(box.x + x2, box.y + y2, { steps: 12 });
  await page.mouse.up();
}
async function saved() { await page.waitForFunction(() => !document.querySelector('.canvas-save-state.is-visible')); }
try {
  await page.goto("http://127.0.0.1:1568/scripts/fixtures/canvas-reference/preview.html");
  await node("old").waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    const base = snapshot.nodes[0];
    snapshot.nodes = [
      { ...base, x: 140, y: 120 },
      { ...base, id: "prompt", kind: "prompt", role: null, assetId: null, x: 390, y: 120, width: 260, height: 180,
        payloadJson: JSON.stringify({ schema_version: 1, text: "会话卡片", status: "succeeded" }) },
      { ...base, id: "outside", x: 900, y: 180 },
    ];
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload();
  await node("old").waitFor();

  // Draw in reverse, include material + prompt, leave a partially/outside card out.
  await page.getByRole("button", { name: "分区工具", exact: true }).click();
  await drag(750, 380, 100, 80);
  const section = page.locator(".canvas-note.is-section");
  await section.waitFor();
  const sectionId = await section.getAttribute("data-canvas-node-id");
  await saved();
  let snapshot = await page.evaluate(() => window.snapshot());
  assert.deepEqual(JSON.parse(snapshot.nodes.find(n => n.id === sectionId).payloadJson).member_ids.sort(), ["old", "prompt"]);
  await page.getByRole("textbox", { name: "分区名称", exact: true }).fill("方案 A");
  await page.getByRole("textbox", { name: "分区名称", exact: true }).blur();
  const before = await page.evaluate(() => window.snapshot());
  const handle = await section.locator(".canvas-section-heading svg").boundingBox();
  await page.mouse.move(handle.x + 5, handle.y + 5);
  await page.mouse.down();
  await page.mouse.move(handle.x + 85, handle.y + 65, { steps: 12 });
  await page.mouse.up();
  await saved();
  const after = await page.evaluate(() => window.snapshot());
  const delta = id => { const a = after.nodes.find(n => n.id === id), b = before.nodes.find(n => n.id === id); return [a.x - b.x, a.y - b.y]; };
  assert.deepEqual(delta("old"), delta(sectionId));
  assert.deepEqual(delta("prompt"), delta(sectionId));
  assert.ok(delta(sectionId)[0] > 60);
  assert.deepEqual(delta("outside"), [0, 0]);
  // Resize an existing section: keep cards still and refresh membership on release.
  async function resizeSection(dx, dy, cancel = false) {
    await section.locator(".canvas-section-heading svg").click();
    const knob = await section.getByRole("button", { name: "调整分区大小（右下角）", exact: true }).boundingBox();
    await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
    await page.mouse.down();
    await page.mouse.move(knob.x + knob.width / 2 + dx, knob.y + knob.height / 2 + dy, { steps: 8 });
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
    await saved();
  }
  await resizeSection(300, 0);
  let resizedSection = (await page.evaluate(() => window.snapshot())).nodes.find(n => n.id === sectionId);
  assert.deepEqual(JSON.parse(resizedSection.payloadJson).member_ids.sort(), ["old", "outside", "prompt"]);
  for (const id of ["old", "outside", "prompt"]) {
    const current = (await page.evaluate(() => window.snapshot())).nodes.find(n => n.id === id);
    const original = after.nodes.find(n => n.id === id);
    assert.deepEqual([current.x, current.y, current.width, current.height], [original.x, original.y, original.width, original.height]);
  }
  await page.evaluate(() => window.save());
  await page.reload();
  await node(sectionId).waitFor();
  assert.equal((await page.evaluate(() => window.snapshot())).nodes.find(n => n.id === sectionId).width, resizedSection.width);
  await resizeSection(-300, 0, true);
  assert.equal((await page.evaluate(() => window.snapshot())).nodes.find(n => n.id === sectionId).width, resizedSection.width);
  await resizeSection(-300, 0);
  resizedSection = (await page.evaluate(() => window.snapshot())).nodes.find(n => n.id === sectionId);
  assert.deepEqual(JSON.parse(resizedSection.payloadJson).member_ids.sort(), ["old", "prompt"]);
  assert.equal(resizedSection.width, after.nodes.find(n => n.id === sectionId).width);
  await drag(195, 155, 755, 400);
  assert.equal(await section.evaluate(element => element.classList.contains("is-selected")), false, "marquee inside a section does not select its frame");
  assert.equal(await node("old").evaluate(element => element.classList.contains("is-selected")), true);
  await stage.click({ position: { x: 1200, y: 450 } });

  await page.getByRole("button", { name: "文本卡片工具", exact: true }).click();
  await stage.click({ position: { x: 160, y: 520 } });
  const text = page.locator(".canvas-note.is-text");
  await text.waitFor();
  const textId = await text.getAttribute("data-canvas-node-id");
  const cell = page.getByRole("textbox", { name: "第 1 行第 1 列", exact: true });
  assert.equal(await text.locator(".canvas-text-handle").innerText(), "");
  assert.equal(await text.locator(".canvas-text-handle svg").count(), 2);
  assert.ok(Math.abs((await text.boundingBox()).height - 104 * 0.8) < 0.1);
  assert.equal(await cell.evaluate(e => getComputedStyle(e).fontSize),
    await node("prompt").locator(".ProseMirror").evaluate(e => getComputedStyle(e).fontSize));
  await cell.fill("中文方案\n保留换行");
  await cell.press("End");
  await cell.press("Space");
  await cell.press("Delete");
  assert.equal(await text.count(), 1, "Delete while editing must not remove the card");
  await page.getByRole("button", { name: "加粗", exact: true }).click();
  await page.getByRole("button", { name: "斜体", exact: true }).click();
  await page.getByRole("button", { name: "居中对齐", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: /^添加[行列]$/ }).count(), 0);
  async function insert(axis, position) {
    const control = page.getByRole("button", { name: `在第 ${position} ${axis}位置插入`, exact: true });
    await page.mouse.move(10, 10);
    await page.waitForFunction(label => getComputedStyle(document.querySelector(`[aria-label="${label}"]`)).opacity === "0", `在第 ${position} ${axis}位置插入`);
    assert.equal(await control.evaluate(e => getComputedStyle(e).opacity), "0");
    await control.hover({ position: axis === "行" ? { x: 20, y: 6 } : { x: 6, y: 20 } });
    await page.waitForFunction(label => getComputedStyle(document.querySelector(`[aria-label="${label}"]`)).opacity === "1", `在第 ${position} ${axis}位置插入`);
    assert.equal(await control.evaluate(e => getComputedStyle(e).opacity), "1");
    assert.notEqual(await control.evaluate(e => getComputedStyle(e, "::before").backgroundColor), "rgba(0, 0, 0, 0)");
    await control.locator("svg").click();
  }
  await insert("列", 2);
  await insert("行", 2);
  await page.getByRole("textbox", { name: "第 2 行第 2 列", exact: true }).fill("复制这一格");
  const spacingBounds = await text.boundingBox();
  const spacing = text.getByRole("group", { name: "文字行距", exact: true });
  assert.equal(await spacing.getByRole("button").count(), 2);
  const spacingBox = await spacing.boundingBox();
  assert.ok(spacingBox.x > spacingBounds.x + spacingBounds.width / 2 && spacingBox.y < spacingBounds.y + 30);
  await spacing.getByRole("button", { name: "增大行距", exact: true }).click();
  assert.ok(Math.abs(await cell.evaluate(e => parseFloat(getComputedStyle(e).lineHeight)) - 21) < 0.01);
  await spacing.getByRole("button", { name: "减小行距", exact: true }).click();
  await spacing.getByRole("button", { name: "减小行距", exact: true }).click();
  assert.ok((await text.getByRole("textbox").evaluateAll(elements => elements.map(e => parseFloat(getComputedStyle(e).lineHeight)))).every(height => Math.abs(height - 18.6) < 0.01));
  assert.deepEqual(await text.boundingBox(), spacingBounds, "line spacing does not move or resize the card");
  await page.getByRole("button", { name: "复制第 2 行第 2 列", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "复制这一格");
  // Insertion in the middle preserves existing cells and their formatting.
  await insert("行", 2);
  assert.equal(await page.getByRole("textbox", { name: "第 3 行第 2 列", exact: true }).inputValue(), "复制这一格");
  await insert("列", 2);
  assert.equal(await page.getByRole("textbox", { name: "第 3 行第 3 列", exact: true }).inputValue(), "复制这一格");
  async function remove(axis, position) {
    const control = page.getByRole("button", { name: `删除第 ${position} ${axis}`, exact: true });
    await page.mouse.move(10, 10);
    await page.waitForFunction(label => getComputedStyle(document.querySelector(`[aria-label="${label}"]`)).opacity === "0", `删除第 ${position} ${axis}`);
    await control.hover();
    await page.waitForFunction(label => getComputedStyle(document.querySelector(`[aria-label="${label}"]`)).opacity === "1", `删除第 ${position} ${axis}`);
    const highlights = await text.locator(".canvas-text-cell.is-removing").count();
    assert.equal(highlights, axis === "行" ? await text.getByRole("row").first().getByRole("cell").count() : await text.getByRole("row").count());
    await control.click();
  }
  const beforeDeletion = await text.boundingBox();
  await page.getByRole("textbox", { name: "第 2 行第 2 列", exact: true }).fill("待删除的内容");
  await page.getByRole("textbox", { name: "第 3 行第 3 列", exact: true }).focus();
  await remove("行", 2);
  assert.equal(await text.getByRole("row").count(), 2);
  assert.equal(await page.getByRole("textbox", { name: "第 2 行第 3 列", exact: true }).inputValue(), "复制这一格");
  await page.getByRole("button", { name: "撤销删除行列", exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: "第 2 行第 2 列", exact: true }).inputValue(), "待删除的内容");
  await remove("行", 2);
  await remove("列", 2);
  assert.equal(await text.getByRole("textbox").count(), 4);
  assert.equal(await page.getByRole("textbox", { name: "第 2 行第 2 列", exact: true }).inputValue(), "复制这一格");
  await page.getByRole("button", { name: "右对齐", exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: "第 2 行第 2 列", exact: true }).evaluate(e => getComputedStyle(e).textAlign), "right", "active cell follows its content after deletion");
  assert.deepEqual(await cell.evaluate(e => [getComputedStyle(e).fontWeight, getComputedStyle(e).fontStyle, getComputedStyle(e).textAlign]), ["700", "italic", "center"]);
  assert.deepEqual(await text.boundingBox(), beforeDeletion, "deletion preserves custom card dimensions");
  assert.equal(await page.getByRole("button", { name: "撤销删除行列", exact: true }).count(), 0, "editing clears a stale deletion snapshot");
  await insert("行", 2);
  await insert("列", 2);
  const beforeResize = await text.boundingBox();
  const resize = text.getByRole("button", { name: "调整文本卡片大小" });
  const resizeHandle = await resize.boundingBox();
  await page.mouse.move(resizeHandle.x + 7, resizeHandle.y + 7);
  await page.mouse.down();
  await page.mouse.move(resizeHandle.x + 107, resizeHandle.y + 67, { steps: 10 });
  await page.mouse.up();
  const afterResize = await text.boundingBox();
  assert.ok(Math.abs(afterResize.width - beforeResize.width - 100) < 1);
  assert.ok(Math.abs(afterResize.height - beforeResize.height - 60) < 1);
  assert.equal(afterResize.x, beforeResize.x);
  assert.equal(afterResize.y, beforeResize.y);
  // Shrinking respects readable cell minima; Escape restores the starting dimensions.
  const shrinkHandle = await resize.boundingBox();
  await page.mouse.move(shrinkHandle.x + 7, shrinkHandle.y + 7);
  await page.mouse.down();
  await page.mouse.move(shrinkHandle.x - 600, shrinkHandle.y - 500, { steps: 6 });
  const minimumSize = await text.boundingBox();
  assert.ok(minimumSize.width >= 376 && Math.abs(minimumSize.height - 232 * 0.8) < 0.1);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.deepEqual(await text.boundingBox(), afterResize);
  await cell.fill("中文方案\n保留换行");
  assert.deepEqual(await text.boundingBox(), afterResize, "editing retains custom dimensions");
  await saved();
  await page.evaluate(() => window.save());
  await page.reload();
  await node(textId).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "分区名称", exact: true }).inputValue(), "方案 A");
  assert.equal(await page.getByRole("textbox", { name: "第 3 行第 3 列", exact: true }).inputValue(), "复制这一格");
  assert.deepEqual(await text.boundingBox(), afterResize, "resized geometry survives reload");
  assert.ok(Math.abs(await cell.evaluate(e => parseFloat(getComputedStyle(e).lineHeight)) - 18.6) < 0.01, "line spacing survives reload");
  assert.deepEqual(await cell.evaluate(e => [getComputedStyle(e).fontWeight, getComputedStyle(e).fontStyle, getComputedStyle(e).textAlign]), ["700", "italic", "center"]);
  assert.equal(await page.getByRole("toolbar", { name: "文本样式（当前单元格）" }).count(), 0);
  await cell.click();
  await page.getByRole("toolbar", { name: "文本样式（当前单元格）" }).waitFor();
  // Pointer deltas are converted from screen pixels at the current canvas zoom.
  await page.getByRole("button", { name: "缩小", exact: true }).click();
  await page.getByRole("button", { name: "缩小", exact: true }).click();
  await page.waitForFunction(() => Math.abs(window.snapshot().view.zoom - 0.7) < 0.001);
  await saved();
  const zoomed = await page.evaluate(() => window.snapshot());
  const zoomedNode = zoomed.nodes.find(n => n.id === textId);
  const zoomedHandle = await resize.boundingBox();
  await page.mouse.move(zoomedHandle.x + zoomedHandle.width / 2, zoomedHandle.y + zoomedHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(zoomedHandle.x + zoomedHandle.width / 2 + 28, zoomedHandle.y + zoomedHandle.height / 2 + 14, { steps: 6 });
  await page.mouse.up();
  await saved();
  const zoomedResult = (await page.evaluate(() => window.snapshot())).nodes.find(n => n.id === textId);
  assert.ok(Math.abs(zoomedResult.width - zoomedNode.width - 28 / zoomed.view.zoom) < 1);
  assert.ok(Math.abs(zoomedResult.height - zoomedNode.height - 14 / zoomed.view.zoom) < 1);
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.getByRole("button", { name: "放大", exact: true }).click();
  // Failed writes retain the latest edits, then the normal route flush retries them in order.
  await page.evaluate(() => window.failNoteSave = true);
  await page.getByRole("textbox", { name: "第 2 行第 1 列", exact: true }).fill("失败时保留的内容");
  await page.locator(".canvas-save-error").waitFor();
  await page.getByRole("textbox", { name: "第 2 行第 1 列", exact: true }).fill("继续编辑后的内容");
  await page.evaluate(async () => { window.failNoteSave = false; await window.store.getState().projectCanvasFlush(); });
  assert.equal(JSON.parse((await page.evaluate(() => window.snapshot())).nodes.find(n => n.id === textId).payloadJson).cells[1][0].text, "继续编辑后的内容");
  await mkdir(".tmp/canvas-notes", { recursive: true });
  await page.screenshot({ path: ".tmp/canvas-notes/preview.png" });
  await page.getByRole("button", { name: "在第 2 行位置插入", exact: true }).hover({ position: { x: 20, y: 6 } });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[aria-label="在第 2 行位置插入"]')).opacity === "1");
  await page.screenshot({ path: ".tmp/canvas-notes/insert-preview.png" });

  // Drawing can be cancelled without adding a region.
  await page.getByRole("button", { name: "分区工具", exact: true }).click();
  const box = await stage.boundingBox();
  await page.mouse.move(box.x + 800, box.y + 500);
  await page.mouse.down();
  await page.mouse.move(box.x + 1000, box.y + 750);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await section.count(), 1);
  assert.equal(await page.locator(".canvas-section-preview").count(), 0);

  // A section containing the text card moves it and survives remove/undo without deleting members.
  await page.getByRole("button", { name: "分区工具", exact: true }).click();
  const textBounds = await text.boundingBox();
  const stageBounds = await stage.boundingBox();
  await drag(textBounds.x - stageBounds.x - 30, textBounds.y - stageBounds.y - 30,
    textBounds.x - stageBounds.x + textBounds.width + 30, textBounds.y - stageBounds.y + textBounds.height + 30);
  const textSection = page.locator(".canvas-note.is-section").last();
  const textSectionId = await textSection.getAttribute("data-canvas-node-id");
  await saved();
  assert.deepEqual(JSON.parse((await page.evaluate(() => window.snapshot())).nodes.find(n => n.id === textSectionId).payloadJson).member_ids, [textId]);
  const textBefore = await node(textId).boundingBox();
  const textHandle = await textSection.locator(".canvas-section-heading svg").boundingBox();
  await page.mouse.move(textHandle.x + 5, textHandle.y + 5);
  await page.mouse.down();
  await page.mouse.move(textHandle.x + 35, textHandle.y + 25, { steps: 8 });
  await page.mouse.up();
  await saved();
  assert.ok((await node(textId).boundingBox()).x > textBefore.x + 20);
  await textSection.locator(".canvas-section-heading svg").click({ button: "right" });
  await page.getByRole("menuitem", { name: /从画布移出/ }).click();
  assert.equal(await node(textId).count(), 1);
  assert.equal(await node(textSectionId).count(), 0);
  await stage.click({ position: { x: 1200, y: 450 } });
  await page.keyboard.press("Control+z");
  await node(textSectionId).waitFor();

  // Right-clicking the blank area inside a section removes the section frame,
  // keeps members and stays undoable — the section body itself ignores pointers.
  const blankSection = await textSection.boundingBox();
  const memberBounds = await node(textId).boundingBox();
  const insideX = blankSection.x + blankSection.width - 8;
  const insideY = blankSection.y + blankSection.height - 8;
  assert.ok(insideX > memberBounds.x + memberBounds.width || insideY > memberBounds.y + memberBounds.height,
    "右键落点在分区内且避开成员卡片");
  await page.mouse.click(insideX, insideY, { button: "right" });
  await page.getByRole("menuitem", { name: /移除分区/ }).click();
  assert.equal(await node(textId).count(), 1);
  assert.equal(await node(textSectionId).count(), 0);
  await stage.click({ position: { x: 1200, y: 450 } });
  await page.keyboard.press("Control+z");
  await node(textSectionId).waitFor();
  await saved();

  // Arrangement treats a region as one unit, preserving its internal layout too.
  const beforeArrange = await page.evaluate(() => window.snapshot());
  await node(sectionId).locator(".canvas-section-heading svg").click({ button: "right" });
  await page.getByRole("menuitem", { name: "整理", exact: true }).click();
  await saved();
  const afterArrange = await page.evaluate(() => window.snapshot());
  for (const id of ["old", "prompt"]) {
    const relative = snapshot => { const n = snapshot.nodes.find(n => n.id === id), s = snapshot.nodes.find(n => n.id === sectionId); return [n.x - s.x, n.y - s.y]; };
    assert.deepEqual(relative(afterArrange), relative(beforeArrange));
  }

  // Deletion persists and never removes the last row or column.
  await cell.focus();
  await remove("行", 3);
  await remove("行", 2);
  await remove("列", 3);
  await remove("列", 2);
  assert.equal(await text.getByRole("textbox").count(), 1);
  assert.equal(await text.locator(".canvas-text-remove").count(), 0);
  await saved();
  const reduced = JSON.parse((await page.evaluate(() => window.snapshot())).nodes.find(n => n.id === textId).payloadJson);
  assert.deepEqual(reduced.cells.map(row => row.length), [1]);
  assert.equal(reduced.text, await cell.inputValue());

  // Zoom buttons and persisted view both reach 10%.
  for (let i = 0; i < 8; i++) await page.getByRole("button", { name: "缩小", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.canvas-zoom-controls')?.textContent.includes('10%'));
  await page.waitForFunction(() => window.snapshot().view.zoom === 0.1);
  await saved();
  await page.evaluate(() => window.save());
  await page.reload();
  await node(textId).waitFor();
  assert.equal(await text.getByRole("textbox").count(), 1);
  assert.equal(await text.locator(".canvas-text-remove").count(), 0);
  assert.match(await page.locator(".canvas-zoom-controls").innerText(), /10%/);
  assert.equal((await page.evaluate(() => window.snapshot())).view.zoom, 0.1);
  assert.deepEqual(errors, []);
  console.log("Canvas notes UI passed: section membership/movement, rename, text grid/styles/copy, reload, keyboard isolation, cancel and 10% zoom.");
} finally {
  await browser.close();
  await server.close();
}
