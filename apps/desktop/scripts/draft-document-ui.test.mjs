import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
import { initializeCanvas, readPsd } from "ag-psd";

initializeCanvas(() => { throw new Error("Unexpected native Canvas allocation"); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
const server = await createServer({ configFile: false, cacheDir: ".tmp/draft-document-vite",
  optimizeDeps: { noDiscovery: true, include: ["ag-psd"] },
  server: { host: "127.0.0.1", port: 15994, strictPort: true, hmr: false, watch: null } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:15994/scripts/fixtures/draft-document/preview.html");
  const result = await page.evaluate(async () => {
    const d = await import("/src/lib/draftDocument.ts");
    const { DraftBrushStroke, applyPixelPatches } = await import("/src/lib/draftBrush.ts");
    const { DraftHistory } = await import("/src/lib/draftHistory.ts");
    const { exportLayerPsd } = await import("/src/lib/layerExport.ts");
    const { decodeLayerImage } = await import("/src/lib/layerDocument.ts");
    const expect = (condition, message) => { if (!condition) throw new Error(message); };
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const data = canvas => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const pixel = (canvas, x, y) => [...canvas.getContext("2d").getImageData(x, y, 1, 1).data];
    const samePixels = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const paint = doc => { const canvas = d.draftCanvas(doc.width, doc.height); d.paintDraft(canvas, doc); return canvas; };
    const throws = fn => { try { fn(); } catch { return true; } return false; };
    const checks = [];
    const sized = d.newDraftDocument(64, 48, false), ink = sized.layers[1].canvas.getContext("2d");
    ink.fillStyle = "#ff0000"; ink.fillRect(8, 8, 5, 5);
    const expanded = d.resizeDraftDocument(sized, 96, 72, false);
    expect(equal(pixel(paint(expanded), 9, 9), [255, 0, 0, 255]), "canvas expansion preserves existing pixels without scaling");
    expect(equal(pixel(paint(expanded), 80, 60), [255, 255, 255, 255]), "white background extends to new canvas bounds");
    expect(expanded.layers[1].canvas.width === 96 && expanded.layers[1].canvas.height === 72, "painting buffer expands with the canvas");
    expect(sized.layers[1].canvas.width === 64, "resize cannot mutate the original canvas held by undo history");
    const expansionStroke = new DraftBrushStroke(expanded.layers[1].canvas, { size: 8, hardness: 1, opacity: 1, flow: 1, smoothing: 0, color: "#0000ff", erase: false },
      { x: 80, y: 60, pressure: 1, time: 0 }); expansionStroke.finish();
    expect(equal(pixel(paint(expanded), 80, 60), [0, 0, 255, 255]), "new canvas area accepts real brush pixels");
    const shrunk = d.resizeDraftDocument(expanded, 32, 24, false), restoredSize = d.resizeDraftDocument(shrunk, 96, 72, false);
    expect(equal(pixel(paint(restoredSize), 80, 60), [0, 0, 255, 255]), "shrinking then expanding preserves off-canvas artwork");
    const transparentSize = d.resizeDraftDocument(expanded, 96, 72, true);
    expect(transparentSize.layers.length === 2 && pixel(paint(transparentSize), 70, 50)[3] === 0, "transparent setting hides but retains background layer");
    const reopenedSize = await d.openDraftDocument(d.serializeDraft(transparentSize));
    expect(reopenedSize.backgroundLayerId === transparentSize.backgroundLayerId, "background identity persists across workspace reopen");
    expect(equal(pixel(paint(d.resizeDraftDocument(reopenedSize, 96, 72, false)), 70, 50), [255,255,255,255]), "white background can be restored after reopening");
    const fakeLargeLayer = { ...sized.layers[1], width: 3000, height: 3000, canvas: { width: 3000, height: 3000 } };
    expect(throws(() => d.resizeDraftDocument({ ...sized, width: 3000, height: 3000, layers: [fakeLargeLayer, fakeLargeLayer, fakeLargeLayer, fakeLargeLayer] }, 4096, 4096, true)), "resize rejects total pixel overflow before any buffer allocation");
    checks.push("canvas resizing preserves content, extends paintable bounds, restores hidden background, and checks budgets before allocation");

    const cropBase = d.newDraftDocument(64, 48, false);
    cropBase.layers[0].canvas.getContext("2d").clearRect(2, 3, 1, 1);
    cropBase.layers[1].canvas.getContext("2d").fillStyle = "#ff0000";
    cropBase.layers[1].canvas.getContext("2d").fillRect(8, 8, 5, 5);
    const scaledCropLayer = { ...d.rasterLayer(16, 12, "缩放素材"), x: 25, y: 10, width: 8, height: 6, visible: false };
    const cropText = { content: "保留文字", fontFamily: "Arial", fontSize: 12, color: "#000000", bold: false,
      align: "left", lineHeight: 1, letterSpacing: 0, boxWidth: 8, boxHeight: 4 };
    const cropTextLayer = { ...d.rasterLayer(8, 4, "文字"), kind: "text", text: cropText, x: 1, y: 2, visible: false };
    cropBase.layers.push(scaledCropLayer, cropTextLayer);
    const originalCropPixels = new Uint8ClampedArray(data(paint(cropBase)));
    expect(d.cropDraftDocument(cropBase, { x: 0, y: 0, width: 64, height: 48 }) === cropBase, "unchanged crop preserves the document reference");
    const outward = d.cropDraftDocument(cropBase, { x: -16, y: -8, width: 96, height: 72 });
    expect(equal(pixel(paint(outward), 24, 16), [255, 0, 0, 255]), "left/top expansion translates existing artwork without scaling");
    expect(equal(pixel(paint(outward), 1, 1), [255, 255, 255, 255]), "left/top new background pixels are white");
    expect(pixel(paint(outward), 18, 11)[3] === 0, "background extension preserves previously erased transparency");
    expect(outward.layers[1].canvas.width === 96 && outward.layers[1].canvas.height === 72 && outward.layers[1].x === 0 && outward.layers[1].y === 0,
      "full-canvas drawing buffers extend on all four sides");
    expect(outward.layers[2].canvas === scaledCropLayer.canvas && outward.layers[2].width === 8 && outward.layers[2].x === 41 && outward.layers[2].y === 18,
      "cropping changes scaled asset placement without resampling its source buffer");
    expect(outward.layers[3].canvas === cropTextLayer.canvas && outward.layers[3].text === cropText && outward.layers[3].x === 17 && outward.layers[3].y === 10,
      "text remains editable and uses its original backing buffer");
    expect(cropBase.layers[1].canvas !== outward.layers[1].canvas && samePixels(data(paint(cropBase)), originalCropPixels), "extension leaves all pixels retained by undo unchanged");
    const leftStroke = new DraftBrushStroke(outward.layers[1].canvas, { size: 6, hardness: 1, opacity: 1, flow: 1, smoothing: 0, color: "#0000ff", erase: false },
      { x: 4, y: 4, pressure: 1, time: 0 });
    const leftPatches = leftStroke.finish();
    expect(equal(pixel(paint(outward), 4, 4), [0, 0, 255, 255]), "expanded left/top area accepts an actual brush stroke");
    let cropCurrent = outward; const cropHistory = new DraftHistory();
    cropHistory.push({ undo: () => { cropCurrent = cropBase; }, redo: () => { cropCurrent = outward; }, bytes: 100_000 });
    cropHistory.push({ undo: () => applyPixelPatches(outward.layers[1].canvas, leftPatches, "before"),
      redo: () => applyPixelPatches(outward.layers[1].canvas, leftPatches, "after"), bytes: 10_000 });
    cropHistory.undo(); cropHistory.undo();
    expect(cropCurrent === cropBase && samePixels(data(paint(cropCurrent)), originalCropPixels), "undo stroke then expansion recovers original dimensions and exact pixels");
    cropHistory.redo(); cropHistory.redo();
    expect(equal(pixel(paint(cropCurrent), 4, 4), [0, 0, 255, 255]), "redo expansion then stroke restores new pixels");
    const inward = d.cropDraftDocument(outward, { x: 20, y: 10, width: 32, height: 24 });
    expect(inward.layers[1].canvas === outward.layers[1].canvas && inward.layers[1].x === -20 && inward.layers[1].y === -10,
      "inner crop keeps off-canvas pixels and moves layer origins");
    const restoredCrop = d.cropDraftDocument(inward, { x: -20, y: -10, width: 96, height: 72 });
    expect(samePixels(data(paint(restoredCrop)), data(paint(outward))), "reverse extension recovers cropped-out artwork exactly");
    const reopenedCrop = await d.openDraftDocument(d.serializeDraft(inward));
    expect(samePixels(data(paint(d.cropDraftDocument(reopenedCrop, { x: -20, y: -10, width: 96, height: 72 }))), data(paint(outward))),
      "saved crop retains off-canvas pixels, positions, and background identity after reopening");
    checks.push("non-destructive crop/extension, left/top brush pixels, preserved raster/text transforms, undo/redo and reopen");

    const hiddenBackground = { ...cropBase, layers: cropBase.layers.map(layer => layer.id === cropBase.backgroundLayerId ? { ...layer, visible: false } : layer) };
    const hiddenExtended = d.cropDraftDocument(hiddenBackground, { x: -8, y: -8, width: 80, height: 64 });
    expect(hiddenExtended.backgroundLayerId === cropBase.backgroundLayerId && !hiddenExtended.layers[0].visible && pixel(paint(hiddenExtended), 0, 0)[3] === 0,
      "transparent background setting survives outward crop unchanged");
    const transparentCrop = d.cropDraftDocument(d.newDraftDocument(32, 24, true), { x: -8, y: -8, width: 48, height: 40 });
    expect(transparentCrop.layers.length === 1 && data(paint(transparentCrop)).every(v => v === 0), "transparent documents do not gain a white background during extension");
    const nativeCreateElement = document.createElement.bind(document); let cropAllocations = 0;
    document.createElement = (tag, ...args) => { if (tag === "canvas") cropAllocations++; return nativeCreateElement(tag, ...args); };
    try {
      const largeLayer = { ...cropBase.layers[1], x: 0, y: 0, width: 4096, height: 16, canvas: { width: 4096, height: 16 } };
      expect(throws(() => d.cropDraftDocument({ ...cropBase, width: 4096, height: 16, layers: [largeLayer] }, { x: -1, y: 0, width: 4096, height: 16 })),
        "union with retained pixels must respect the per-layer side limit even when the final canvas fits");
      expect(throws(() => d.cropDraftDocument({ ...cropBase, width: 3000, height: 3000, layers: [fakeLargeLayer, fakeLargeLayer, fakeLargeLayer, fakeLargeLayer] },
        { x: -200, y: -200, width: 4096, height: 4096 })), "outward crop checks total retained pixels before allocation");
      expect(throws(() => d.cropDraftDocument(cropBase, { x: NaN, y: 0, width: 64, height: 48 })), "nonfinite crop position is rejected");
      expect(cropAllocations === 0, "invalid crop sizes and budgets never allocate a Canvas");
    } finally { document.createElement = nativeCreateElement; }
    expect(samePixels(data(paint(cropBase)), originalCropPixels), "rejected crops leave the original document intact");
    checks.push("crop background visibility, intrinsic union limits and total pixel budget checked before buffer allocation");
    const doc = d.newDraftDocument(64, 48, false);
    expect(doc.layers.length === 2 && doc.layers[0].locked, "white document has a locked background and a drawing layer");
    expect(equal(pixel(paint(doc), 0, 0), [255, 255, 255, 255]), "white background is actual pixels");
    const empty = d.newDraftDocument(64, 48, true);
    expect(empty.layers.length === 1 && data(paint(empty)).every(v => v === 0), "transparent document stays transparent");
    const red = doc.layers[1];
    red.canvas.getContext("2d").fillStyle = "#ff0000";
    red.canvas.getContext("2d").fillRect(0, 0, 8, 8);
    Object.assign(red, { x: 8, y: 10, width: 32, height: 24, name: "红色绘画" });
    const blue = d.rasterLayer(10, 10, "半透明蓝色");
    blue.canvas.getContext("2d").fillStyle = "#0000ff";
    blue.canvas.getContext("2d").fillRect(0, 0, 10, 10);
    Object.assign(blue, { x: 10, y: 11, opacity: .5 }); doc.layers.push(blue);
    const composite = paint(doc);
    expect(equal(pixel(composite, 8, 10), [255, 0, 0, 255]), "raster display geometry scales backing pixels");
    expect(equal(pixel(composite, 10, 11), [127, 0, 128, 255]), "visible layers composite bottom-to-top with independent opacity");
    const hidden = { ...doc, layers: doc.layers.map(layer => layer.id === blue.id ? { ...layer, visible: false } : layer) };
    expect(equal(pixel(paint(hidden), 10, 11), [255, 0, 0, 255]), "hidden layer does not affect composite");
    checks.push("white/transparent creation, real RGBA composition, visibility, geometry and opacity");

    const serialized = JSON.parse(JSON.stringify(d.serializeDraft(doc)));
    expect(serialized.layers.every(layer => !Object.hasOwn(layer, "canvas")), "saved document contains no live Canvas handles");
    const reopened = await d.openDraftDocument(serialized);
    expect(samePixels(data(composite), data(paint(reopened))), "save/reopen retains exact composite pixels");
    expect(reopened.layers[1].canvas.width === 64 && reopened.layers[1].width === 32, "save/reopen preserves raster backing and display dimensions separately");
    expect(reopened.documentId === doc.documentId && reopened.layers.map(l => l.id).join() === doc.layers.map(l => l.id).join(), "save/reopen preserves stable IDs");
    const png = await decodeLayerImage(d.draftPng(doc)), pngCanvas = d.draftCanvas(png.naturalWidth, png.naturalHeight);
    pngCanvas.getContext("2d").drawImage(png, 0, 0);
    expect(png.naturalWidth === 64 && png.naturalHeight === 48 && samePixels(data(composite), data(pngCanvas)), "exported PNG has document dimensions and exact composited pixels");
    checks.push("JSON + PNG save/reopen retains pixels, IDs, raster resolution and transforms");

    const text = { content: "AB\n标题", fontFamily: "Arial", fontSize: 16, color: "#009900", bold: true,
      align: "left", lineHeight: 1.2, letterSpacing: 0, boxWidth: 64, boxHeight: 48 };
    const label = { ...d.rasterLayer(64, 48, "文字"), kind: "text", text, x: 0, y: 0 };
    const textDoc = { ...empty, layers: [label] };
    await document.fonts.load('bold 16px "Arial"');
    const originalText = new Uint8ClampedArray(data(paint(textDoc)));
    expect(originalText.some(v => v !== 0), "editable text is rendered as actual pixels");
    const blankTextDoc = { ...textDoc, layers: [{ ...label, text: { ...text, content: "" } }] };
    expect(data(paint(blankTextDoc)).every(v => v === 0), "text cache clears pixels when content becomes empty");
    expect(samePixels(originalText, data(paint(textDoc))), "metadata undo repaints the earlier text even with a shared Canvas");
    const savedText = JSON.parse(JSON.stringify(d.serializeDraft(textDoc)));
    expect(!Object.hasOwn(savedText.layers[0], "dataUrl") && savedText.layers[0].text.content === text.content, "text saves editable metadata without stale raster pixels");
    const openedText = await d.openDraftDocument(savedText);
    expect(samePixels(originalText, data(paint(openedText))), "text save/reopen preserves rendered pixels");
    const copiedText = d.duplicateDraftLayer(label);
    expect(copiedText.canvas !== label.canvas && copiedText.text !== label.text && copiedText.id !== label.id, "duplication owns independent raster and text data");
    copiedText.canvas.getContext("2d").clearRect(0, 0, 64, 48);
    expect(samePixels(originalText, data(label.canvas)), "editing duplicate pixels cannot change its source");
    checks.push("editable text, shared-Canvas metadata undo, empty-text clearing, independent duplication");

    expect(equal(d.draftSelection({ x: 31.6, y: 26.4 }, { x: -4.2, y: 8.7 }, doc),
      { x: 0, y: 8, width: 32, height: 19 }), "selection is document-clamped and outward-rounded");
    expect(d.draftSelection({ x: -12, y: -10 }, { x: -1, y: -1 }, doc) === null, "fully external selection is empty");
    const clipped = d.rasterLayer(32, 32); Object.assign(clipped, { x: 8, y: 8, width: 16, height: 16 });
    const localSelection = d.draftLayerSelection(clipped, { x: 12, y: 12, width: 4, height: 4 });
    expect(equal(localSelection, { x: 8, y: 8, width: 8, height: 8 }), "selection maps through translated/scaled layer coordinates");
    const brush = new DraftBrushStroke(clipped.canvas, { size: 32, hardness: 1, opacity: 1, flow: 1, smoothing: 0,
      color: "#ff0000", erase: false, selection: localSelection }, { x: 12, y: 12, pressure: 1, time: 0 }); brush.finish();
    const clippedCanvas = paint({ ...empty, layers: [clipped] });
    expect(pixel(clippedCanvas, 13, 13)[3] > 0 && pixel(clippedCanvas, 11, 13)[3] === 0 && pixel(clippedCanvas, 16, 13)[3] === 0,
      "selection confines actual brush pixels after layer transforms");
    expect(d.draftHit(doc, 10, 11).id === blue.id && d.draftHit(hidden, 10, 11).id === red.id,
      "hit testing follows visible layer order and pixel alpha");
    checks.push("selection rounding and clipping, layer coordinate mapping, actual brush clipping and hit testing");

    const asset = d.draftCanvas(48, 24); asset.getContext("2d").fillStyle = "#663399"; asset.getContext("2d").fillRect(0, 0, 48, 24);
    const imported = await d.importedDraftLayer(asset.toDataURL("image/png"), "合成素材", d.newDraftDocument(32, 32, true));
    expect(equal([imported.canvas.width, imported.canvas.height, imported.width, imported.height, imported.x, imported.y], [48, 24, 32, 16, 0, 8]),
      "import keeps source resolution and fits display geometry to the document");
    const copy = d.duplicateDraftLayer(imported); copy.canvas.getContext("2d").clearRect(0, 0, 48, 24);
    expect(pixel(imported.canvas, 1, 1)[3] === 255 && pixel(copy.canvas, 1, 1)[3] === 0, "raster duplicates have independent pixels");
    expect(throws(() => d.draftCanvas(4097, 1)) && throws(() => d.draftCanvas(3.5, 1)), "dimension guard rejects oversize and fractional buffers");
    expect(throws(() => d.checkDraftBudget({ ...empty, layers: Array.from({ length: 33 }, () => empty.layers[0]) })), "layer-count budget is enforced");
    // Only budget arithmetic uses fake dimensions: no oversized pixel buffers are allocated.
    const large = { ...empty.layers[0], canvas: { width: 4096, height: 4096 } };
    d.checkDraftBudget({ ...empty, layers: [large, large, large] });
    expect(throws(() => d.checkDraftBudget({ ...empty, layers: [large, large, large, large] })), "decoded-pixel budget is enforced independently of document size");
    checks.push("import fitting and intrinsic resolution, raster duplication, side/layer/pixel budgets");

    let current = d.newDraftDocument(32, 32, true);
    const initial = current, layer = current.layers[0], history = new DraftHistory();
    const beforePixels = new Uint8ClampedArray(data(layer.canvas));
    const stroke = new DraftBrushStroke(layer.canvas, { size: 12, hardness: 1, opacity: .7, flow: 1, smoothing: 0, color: "red", erase: false },
      { x: 12, y: 12, pressure: 1, time: 0 }); const patches = stroke.finish();
    const afterPixels = new Uint8ClampedArray(data(layer.canvas));
    history.push({ undo: () => applyPixelPatches(layer.canvas, patches, "before"), redo: () => applyPixelPatches(layer.canvas, patches, "after"),
      bytes: patches.reduce((sum, p) => sum + p.before.byteLength + p.after.byteLength, 0) });
    const moved = { ...current, layers: [{ ...layer, x: 7 }] }; current = moved;
    history.push({ undo: () => { current = initial; }, redo: () => { current = moved; }, bytes: 128 });
    const removed = { ...current, layers: [] }; current = removed;
    history.push({ undo: () => { current = moved; }, redo: () => { current = removed; }, bytes: 4096 });
    history.undo(); expect(current.layers[0].x === 7 && samePixels(data(current.layers[0].canvas), afterPixels), "undo removal restores moved painted layer");
    history.undo(); expect(current.layers[0].x === 0 && samePixels(data(current.layers[0].canvas), afterPixels), "undo move retains stroke pixels");
    history.undo(); expect(samePixels(data(current.layers[0].canvas), beforePixels), "undo stroke restores pixels inside shared metadata snapshots");
    history.redo(); history.redo(); history.redo(); expect(current.layers.length === 0, "redo reproduces paint/move/remove chain");
    history.undo(); expect(samePixels(data(current.layers[0].canvas), afterPixels), "repeated undo deletion still exposes correct painted Canvas");
    checks.push("interleaved pixel/metadata/deletion history restores shared-Canvas snapshots in both directions");

    const psdDoc = { ...doc, layers: [...doc.layers, { ...label, x: -2, y: 1, width: 32, height: 24 }, { ...imported, id: "hidden-synthetic", visible: false }] };
    const adapted = d.draftAsLayerDocument(psdDoc);
    expect(adapted.layers.every(layer => layer.dataUrl.startsWith("data:image/png;base64,")), "PSD adapter gives every layer a pixel preview");
    const psdBytes = await exportLayerPsd(adapted, { Arial: "ArialMT" });
    let binary = ""; for (let i = 0; i < psdBytes.length; i += 32768) binary += String.fromCharCode(...psdBytes.subarray(i, i + 32768));
    return { checks, psd: btoa(binary), expectedComposite: [...data(paint(psdDoc))] };
  });
  const bytes = Buffer.from(result.psd, "base64"), psd = readPsd(bytes, { useImageData: true });
  assert.equal(psd.width, 64); assert.equal(psd.height, 48);
  assert.deepEqual(psd.children.map(layer => layer.name), ["背景", "红色绘画", "半透明蓝色", "文字", "合成素材"]);
  assert.ok(Math.abs(psd.children[2].opacity - .5) < .005);
  assert.equal(psd.children[4].hidden, true);
  assert.equal(psd.children[3].left, -2); assert.equal(psd.children[3].top, 1);
  assert.equal(psd.children[3].text.text.trim(), "AB\n标题");
  assert.equal(psd.children[3].text.style.font.name, "ArialMT");
  assert.equal(psd.children[3].text.style.fontSize, 16);
  assert.deepEqual(psd.children[3].text.transform, [.5, 0, 0, .5, -2, 1]);
  // The PSD path round-trips layer previews through PNG before scaling; premultiplied
  // Canvas pixels can differ by one 8-bit color value at antialiased text edges.
  assert.ok(psd.imageData.data.every((value, i) => Math.abs(value - result.expectedComposite[i]) <= (i % 4 === 3 ? 0 : 1)),
    "PSD flattened preview matches draft pixels within one RGB rounding value and exact alpha");
  assert.deepEqual(errors, []);
  await mkdir(".tmp/draft-document", { recursive: true });
  await writeFile(".tmp/draft-document/synthetic.psd", bytes);
  await writeFile(".tmp/draft-document/results.json", JSON.stringify({ checks: [...result.checks,
    "PSD decoded dimensions, layer order/opacity/hidden/offset, editable type and merged pixels (RGB ±1, exact alpha)"], scope: "isolated Chromium Canvas + ag-psd; synthetic pixels only; no native file I/O or Photoshop application" }, null, 2));
  console.log(`PASS ${result.checks.length + 1} draft model groups: composition, reopen, text, selection, budget, history and decoded PSD`);
} finally { await browser?.close(); await server.close(); }
