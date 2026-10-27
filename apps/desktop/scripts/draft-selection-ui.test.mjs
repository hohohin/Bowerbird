import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ configFile: false, cacheDir: ".tmp/draft-selection-vite",
  optimizeDeps: { noDiscovery: true }, server: { host: "127.0.0.1", port: 16001, strictPort: true, hmr: false, watch: null } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:16001/scripts/fixtures/draft-document/preview.html");
  const checks = await page.evaluate(async () => {
    const s = await import("/src/lib/draftSelection.ts"), d = await import("/src/lib/draftDocument.ts");
    const { DraftBrushStroke, applyPixelPatches } = await import("/src/lib/draftBrush.ts");
    const expect = (condition, message) => { if (!condition) throw new Error(message); };
    const alpha = (canvas, x, y) => canvas.getContext("2d").getImageData(x, y, 1, 1).data[3];
    const polygon = coordinates => s.createDraftLasso(coordinates.map(([x, y]) => ({ x, y })));
    const lasso = polygon([[1, 1], [9, 1], [9, 4], [4, 4], [4, 9], [1, 9]]), checks = [];
    const layer = d.rasterLayer(12, 12), canvas = layer.canvas, ctx = canvas.getContext("2d");
    ctx.save(); s.clipDraftSelection(ctx, lasso); ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, 12, 12); ctx.restore();
    const mask = s.draftSelectionMask(lasso, { x: 0, y: 0, width: 12, height: 12 });
    for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) expect(alpha(canvas, x, y) === mask[y * 12 + x], `concave fill leaked at ${x},${y}`);
    expect(alpha(canvas, 7, 7) === 0 && alpha(canvas, 2, 7) === 255, "concave indentation remains unpainted");
    checks.push("concave fill agrees with mask and leaves the bounding-box indentation untouched");

    ctx.fillStyle = "#0000ff"; ctx.fillRect(0, 0, 12, 12);
    ctx.save(); s.clipDraftSelection(ctx, lasso); ctx.clearRect(0, 0, 12, 12); ctx.restore();
    expect(alpha(canvas, 2, 7) === 0 && alpha(canvas, 7, 7) === 255 && alpha(canvas, 0, 0) === 255, "clear preserves pixels outside polygon");
    ctx.clearRect(0, 0, 12, 12); ctx.save(); s.clipDraftSelection(ctx, lasso);
    ctx.strokeStyle = "#00ff00"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, 6.5); ctx.lineTo(12, 6.5); ctx.stroke(); ctx.restore();
    expect(alpha(canvas, 2, 6) === 255 && alpha(canvas, 7, 6) === 0 && alpha(canvas, 0, 6) === 0, "shape stroke uses the same polygon clip");
    checks.push("clear and shape clips preserve all pixels outside the actual polygon");

    const bow = polygon([[1, 1], [11, 11], [1, 11], [11, 1]]);
    ctx.clearRect(0, 0, 12, 12); ctx.save(); s.clipDraftSelection(ctx, bow); ctx.fillRect(0, 0, 12, 12); ctx.restore();
    expect(alpha(canvas, 5, 2) === 255 && alpha(canvas, 5, 9) === 255 && alpha(canvas, 1, 6) === 0, "self-crossed path retains both lobes and excludes exterior");
    const twice = polygon([[1, 1], [11, 1], [11, 11], [1, 11], [1, 1], [11, 1], [11, 11], [1, 11]]);
    ctx.clearRect(0, 0, 12, 12); ctx.save(); s.clipDraftSelection(ctx, twice); ctx.fillRect(0, 0, 12, 12); ctx.restore();
    expect(alpha(canvas, 5, 5) === 0, "Canvas clip must use evenodd, not nonzero winding");
    expect(ctx.isPointInPath(s.draftSelectionPath(bow), 5, 2, "evenodd"), "Path2D helper shares evenodd geometry");
    checks.push("self-crossing and repeated contours follow even-odd for both clip and Path2D");

    const translated = { ...layer, x: 10, y: -2, width: 6, height: 3 };
    const documentSelection = polygon([[9, -3], [14, -3], [14, -.5], [11, -.5], [11, 2], [9, 2]]);
    const local = d.draftLayerSelection(translated, documentSelection);
    expect(local.points[0].x === -2 && local.points[0].y === -4, "layer coordinates preserve off-canvas vertices");
    ctx.clearRect(0, 0, 12, 12); ctx.save(); s.clipDraftSelection(ctx, local); ctx.fillRect(0, 0, 12, 12); ctx.restore();
    expect(alpha(canvas, 0, 0) === 255 && alpha(canvas, 0, 10) === 255 && alpha(canvas, 5, 10) === 0 && alpha(canvas, 10, 0) === 0, "translated/scaled selection clips to canvas and actual shape");
    expect(d.draftLayerSelection(layer, null) === null, "no selection remains unrestricted");
    expect(!("points" in d.draftLayerSelection(layer, { x: 1, y: 2, width: 3, height: 4 })), "legacy rectangle output shape is unchanged");
    checks.push("document-to-layer mapping handles translation, unequal scales and out-of-canvas points");
    const rect = (x, y, width, height) => ({ x, y, width, height });
    const bounds = rect(0, 0, 12, 12);
    let combined = s.combineDraftSelection(rect(1, 1, 7, 7), rect(5, 2, 6, 3), "add", bounds);
    combined = s.combineDraftSelection(combined, rect(3, 3, 3, 3), "subtract", bounds);
    combined = s.combineDraftSelection(combined, rect(9, 9, 2, 2), "add", bounds);
    const combinedMask = s.draftSelectionMask(combined, bounds);
    const assertPixels = (inverse = false) => {
      for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) expect(alpha(canvas, x, y) === (inverse ? 255 - combinedMask[y * 12 + x] : combinedMask[y * 12 + x]), `combined clip leaked at ${x},${y}`);
    };
    ctx.clearRect(0, 0, 12, 12); ctx.save(); s.clipDraftSelection(ctx, combined); ctx.fillRect(0, 0, 12, 12); ctx.restore(); assertPixels();
    expect(alpha(canvas, 6, 2) === 255 && alpha(canvas, 4, 4) === 0 && alpha(canvas, 10, 10) === 255, "union overlap, subtraction hole and disconnected island all remain exact");
    ctx.fillRect(0, 0, 12, 12); ctx.save(); s.clipDraftSelection(ctx, combined); ctx.clearRect(0, 0, 12, 12); ctx.restore(); assertPixels(true);
    ctx.clearRect(0, 0, 12, 12); ctx.save(); s.clipDraftSelection(ctx, combined); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, 4.5); ctx.lineTo(12, 4.5); ctx.stroke(); ctx.restore();
    for (let x = 0; x < 12; x++) expect(alpha(canvas, x, 4) === combinedMask[4 * 12 + x], "shape uses the combined selection");
    expect(ctx.isPointInPath(s.draftSelectionPath(combined), 2, 4, "evenodd") && !ctx.isPointInPath(s.draftSelectionPath(combined), 4, 4, "evenodd"), "Path2D has the same hole as clip/mask");
    checks.push("combined union, holes and islands agree across fill, clear, shapes, mask and Path2D");

    const options = (selection, erase = false) => ({ size: 100, hardness: 1, opacity: 1, flow: 1, smoothing: 0, color: "#ff0000", erase, selection });
    const brushPoint = (x, y, time = 0) => ({ x, y, time, pressure: 1 });
    ctx.clearRect(0, 0, 12, 12);
    const mutable = structuredClone(combined), brush = new DraftBrushStroke(canvas, options(mutable), brushPoint(-1000, -1000));
    mutable.region.rows.forEach(row => row.splice(0));
    brush.append([brushPoint(6, 6, 20)]); const patches = brush.finish(); assertPixels();
    applyPixelPatches(canvas, patches, "before"); expect(!ctx.getImageData(0, 0, 12, 12).data.some(Boolean), "combined brush undo restores transparent source");
    applyPixelPatches(canvas, patches, "after"); assertPixels();
    ctx.fillRect(0, 0, 12, 12); new DraftBrushStroke(canvas, options(combined, true), brushPoint(6, 6)).finish(); assertPixels(true);
    const empty = s.combineDraftSelection(combined, bounds, "subtract", bounds);
    ctx.clearRect(0, 0, 12, 12); ctx.save(); s.clipDraftSelection(ctx, empty); ctx.fillRect(0, 0, 12, 12); ctx.restore();
    expect(!ctx.getImageData(0, 0, 12, 12).data.some(Boolean), "empty combination does not remove the clipping restriction");
    expect(new DraftBrushStroke(canvas, options(empty), brushPoint(6, 6)).finish().length === 0, "empty selection paints nothing and adds no brush history");
    checks.push("brush/eraser obey compound mask, freeze gesture geometry, undo exactly and retain empty-selection safety");

    const outer = rect(1, 1, 8, 8), hole = rect(3, 3, 3, 3);
    const holed = s.combineDraftSelection(outer, hole, "subtract", bounds);
    const scaled = { ...layer, x: -2, y: -1, width: 24, height: 20 };
    const compoundLocal = s.draftSelectionToLayer(holed, scaled), outerLocal = s.draftSelectionToLayer(outer, scaled), holeLocal = s.draftSelectionToLayer(hole, scaled);
    ctx.clearRect(0, 0, 12, 12); ctx.save(); s.clipDraftSelection(ctx, compoundLocal); ctx.fillRect(0, 0, 12, 12); ctx.restore();
    const actual = ctx.getImageData(0, 0, 12, 12).data;
    ctx.clearRect(0, 0, 12, 12); ctx.save(); ctx.beginPath();
    for (const r of [outerLocal, holeLocal]) ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip("evenodd"); ctx.fillRect(0, 0, 12, 12); ctx.restore();
    const expected = ctx.getImageData(0, 0, 12, 12).data;
    expect(actual.every((value, index) => Math.abs(value - expected[index]) <= 1), "noninteger layer scaling introduces no seams between adjacent scanlines");
    checks.push("translated/nonuniform fractional layer scaling matches a continuous vector contour without row seams");
    return checks;
  });
  assert.equal(checks.length, 7); assert.deepEqual(errors, []);
  console.log(`PASS ${checks.length} selection Canvas groups: primitive/compound clips, brush/eraser, empty selections and transformed layers`);
} finally {
  await browser?.close(); await server.close();
}
