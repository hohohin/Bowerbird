import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ configFile: false, cacheDir: ".tmp/draft-brush-advanced-vite", optimizeDeps: { noDiscovery: true },
  server: { host: "127.0.0.1", port: 16005, strictPort: true, hmr: false, watch: null } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:16005/scripts/fixtures/draft-brush/preview.html");
  const checks = await page.evaluate(async () => {
    const { DraftBrushStroke, applyPixelPatches } = await import("/src/lib/draftBrush.ts");
    const { createDraftLasso, draftSelectionContains, draftSelectionToLayer } = await import("/src/lib/draftSelection.ts");
    const { stepDraftBrushSize } = await import("/src/lib/draftBrushSize.ts");
    const expect = (condition, message) => { if (!condition) throw new Error(message); };
    const make = (fill) => {
      const c = document.createElement("canvas"); c.width = 260; c.height = 180;
      if (fill) { const ctx = c.getContext("2d"); ctx.fillStyle = fill; ctx.fillRect(0, 0, c.width, c.height); }
      return c;
    };
    const data = c => c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const alpha = (c, x, y) => c.getContext("2d").getImageData(x, y, 1, 1).data[3];
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const p = (x, y, time = 0, pressure = 1) => ({ x, y, time, pressure });
    const options = extra => ({ size: 20, hardness: 1, opacity: 1, flow: 1, smoothing: 0, color: "#ff0000", erase: false, ...extra });
    const stroke = (c, points, extra = {}, batch = points.length) => {
      const brush = new DraftBrushStroke(c, options(extra), points[0]);
      for (let i = 1; i < points.length; i += batch) brush.append(points.slice(i, i + batch));
      return brush.finish();
    };
    const checks = [];
    {
      const half = make(), one = make();
      stroke(half, [p(30.5, 30.5)], { size: .5 }); stroke(one, [p(30.5, 30.5)], { size: 1 });
      expect(alpha(half, 30, 30) > 0 && alpha(half, 30, 30) < alpha(one, 30, 30), "a .5px dot must have lower subpixel coverage than a 1px dot");
      const line = make(); stroke(line, [p(5.5, 60.5), p(250.5, 60.5, 100)], { size: .5 });
      for (let x = 6; x < 250; x++) expect(alpha(line, x, 60) > 0 && alpha(line, x, 60) < 255, "half-pixel strokes stay thin and continuous across tile boundaries");
      expect(alpha(line, 100, 59) === 0 && alpha(line, 100, 61) === 0, "fine strokes do not broaden to surrounding pixel rows");
      expect(stepDraftBrushSize(1, -1) === .5 && stepDraftBrushSize(.5, -1) === .5 && stepDraftBrushSize(.5, 1) === 1,
        "bracket shortcuts reach the half-pixel minimum and recover from it");
      expect(stepDraftBrushSize(500, 1) === 500 && stepDraftBrushSize(16, -1) < 16, "shortcuts retain bounds and useful larger-tip steps");
      checks.push("subpixel dot/line coverage, tile continuity and half-pixel shortcuts");
    }
    {
      const full = make(), light = make(), disabled = make();
      stroke(full, [p(40.5, 40.5)]); stroke(light, [p(40.5, 40.5, 0, .25)]);
      stroke(disabled, [p(40.5, 40.5, 0, .25)], { pressure: false });
      expect(alpha(full, 47, 40) === 255 && alpha(light, 47, 40) === 0, "enabled pressure changes diameter");
      expect(same(data(full), data(disabled)), "disabled pressure retains full diameter despite low pen force");
      const terminal = make(), brush = new DraftBrushStroke(terminal, options({ smoothing: .8, inertia: .8 }), p(20.5, 40.5, 0, .6));
      brush.append([p(100.5, 40.5, 16, .6)]); brush.finish(p(150.5, 40.5, 32, 0));
      expect(alpha(terminal, 150, 44) === 255, "zero-pressure pointerup completes the tail using the latest contact width");
      for (let x = 21; x < 150; x++) expect(alpha(terminal, x, 40) > 0, "terminal pressure never leaves an unpainted stabilized tail");
      checks.push("pressure toggle, pen diameter and zero-force release endpoint");
    }
    {
      const direct = make(), delayed = make(), medium = make();
      const a = p(20.5, 60.5), b = p(120.5, 60.5, 1000);
      const regular = new DraftBrushStroke(direct, options({ size: 8 }), a);
      const heavy = new DraftBrushStroke(delayed, options({ size: 8, inertia: 1 }), a);
      const light = new DraftBrushStroke(medium, options({ size: 8, inertia: .5 }), a);
      regular.append([b]); heavy.append([b]); light.append([b]);
      expect(alpha(direct, 90, 60) > 0 && alpha(delayed, 90, 60) === 0 && alpha(delayed, 50, 60) > 0, "inertia creates an actual distance lag with smoothing off");
      expect(alpha(medium, 100, 60) > 0 && alpha(medium, 112, 60) === 0, "lower inertia shortens the trailing distance");
      heavy.append([p(120.5, 60.5, 5000)]);
      expect(alpha(delayed, 90, 60) === 0, "distance stabilizer remains distinct from a time low-pass filter");
      heavy.finish(p(120.5, 60.5, 5010, 0));
      expect(alpha(delayed, 120, 60) === 255, "finish catches up the delayed tip safely");
      const cancel = make("#336699"), before = data(cancel);
      const cancelled = new DraftBrushStroke(cancel, options({ inertia: 1 }), a); cancelled.append([b]); cancelled.cancel();
      expect(same(data(cancel), before) && cancelled.finish().length === 0, "cancel restores all delayed stroke pixels without adding the tail");
      const points = Array.from({ length: 40 }, (_, i) => p(10.5 + i * 5, 90.5 + Math.sin(i / 4) * 35, i * 5, .3 + i / 60));
      const together = make(), separate = make();
      stroke(together, points, { size: 9, smoothing: .4, inertia: .6, flow: .3 }, points.length);
      stroke(separate, points, { size: 9, smoothing: .4, inertia: .6, flow: .3 }, 1);
      expect(same(data(together), data(separate)), "combined smoothing/inertia remains invariant to event batching");
      checks.push("adjustable distance inertia, finish/cancel and smoothed batching invariance");
    }
    {
      const selection = createDraftLasso([{ x: 10, y: 10 }, { x: 220, y: 10 }, { x: 220, y: 60 },
        { x: 140, y: 60 }, { x: 140, y: 150 }, { x: 10, y: 150 }]);
      const original = structuredClone(selection), canvas = make();
      const brush = new DraftBrushStroke(canvas, options({ size: 36, inertia: .4, selection }), p(20.5, 100.5));
      // A gesture snapshots its selection; later caller edits cannot broaden the active mask.
      selection.points[3].x = 250; selection.points[4].x = 250;
      brush.append([p(240.5, 100.5, 100)]); const patches = brush.finish();
      expect(alpha(canvas, 60, 100) > 0 && alpha(canvas, 200, 100) === 0, "the concave hole inside a selection bbox is never painted");
      const pixels = data(canvas);
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++)
        if (!draftSelectionContains(original, x + .5, y + .5)) expect(pixels[(y * canvas.width + x) * 4 + 3] === 0, "all outside polygon pixels stay untouched");
      applyPixelPatches(canvas, patches, "before"); expect(data(canvas).every(v => v === 0), "masked stroke undo restores the exact empty Canvas");
      applyPixelPatches(canvas, patches, "after"); expect(same(data(canvas), pixels), "masked stroke redo restores exact pixels");
      const erased = make("#336699"), before = data(erased);
      const eraser = new DraftBrushStroke(erased, options({ size: 500, erase: true, selection: original }), p(130, 90));
      expect(alpha(erased, 60, 100) === 0 && alpha(erased, 200, 100) === 255, "eraser uses the same true polygon mask");
      eraser.cancel(); expect(same(before, data(erased)), "masked eraser cancellation restores pixels across tiles");
      const transformed = draftSelectionToLayer(original, { x: 5, y: 5, width: 130, height: 90, canvas: { width: 260, height: 180 } });
      const mapped = make(); stroke(mapped, [p(130, 90)], { size: 500, selection: transformed });
      const mappedPixels = data(mapped);
      for (let y = 0; y < mapped.height; y++) for (let x = 0; x < mapped.width; x++)
        if (!draftSelectionContains(transformed, x + .5, y + .5)) expect(mappedPixels[(y * mapped.width + x) * 4 + 3] === 0, "transformed polygon mask clips in layer-pixel coordinates");
      checks.push("true concave polygon masks, immutable gesture selection, transformed mask, eraser and history");
    }
    return checks;
  });
  assert.deepEqual(errors, []);
  console.log(`PASS ${checks.length} advanced brush groups: ${checks.join("; ")}`);
} finally { await browser?.close(); await server.close(); }
