import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ configFile: false, cacheDir: ".tmp/draft-brush-vite", optimizeDeps: { noDiscovery: true },
  server: { host: "127.0.0.1", port: 15992, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const errors = []; page.on("pageerror", error => errors.push(error.message));
try {
  const address = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/draft-brush/preview.html`);
  const report = await page.evaluate(async () => {
    const { DraftBrushStroke, applyPixelPatches } = await import("/src/lib/draftBrush.ts");
    const { DraftHistory } = await import("/src/lib/draftHistory.ts");
    const checks = [];
    const expect = (ok, description) => { if (!ok) throw new Error(description); };
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const make = (width = 160, height = 120, fill) => {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (fill) { context.fillStyle = fill; context.fillRect(0, 0, width, height); }
      return canvas;
    };
    const p = (x, y, time = 0, pressure = 1) => ({ x, y, time, pressure });
    const opts = patch => ({ size: 20, hardness: 1, opacity: 1, flow: 1, smoothing: 0, color: "#ff0000", erase: false, ...patch });
    const data = canvas => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const pixel = (canvas, x, y) => [...canvas.getContext("2d").getImageData(x, y, 1, 1).data];
    const stroke = (canvas, points, options = {}, batch = points.length) => {
      const brush = new DraftBrushStroke(canvas, opts(options), points[0]);
      for (let i = 1; i < points.length; i += batch) brush.append(points.slice(i, i + batch));
      return brush.finish();
    };

    {
      const canvas = make(), brush = new DraftBrushStroke(canvas, opts(), p(30.5, 30.5));
      expect(pixel(canvas, 30, 30)[3] === 255, "press must paint a real dot immediately");
      const dirty = brush.takeDirtyBounds();
      expect(dirty && dirty.x <= 30 && dirty.x + dirty.width > 30, "first dot must report dirty bounds");
      expect(brush.takeDirtyBounds() === null, "taking dirty bounds drains them");
      const live = data(canvas), patches = brush.finish();
      expect(same(live, data(canvas)), "single-click finish must not add a second dab");
      expect(patches.length > 0 && pixel(canvas, 60, 30)[3] === 0, "dot is a local patch");
      expect(brush.finish().length === 0, "finishing twice must not create duplicate history");
      checks.push("single-click dot, immediate pixels, dirty bounds, idempotent finish");
    }
    {
      const canvas = make(), points = [p(20.5, 30.5), p(100.5, 30.5, 16), p(20.5, 30.5, 32), p(100.5, 30.5, 48)];
      stroke(canvas, points, { opacity: 0.5 });
      expect(pixel(canvas, 60, 30)[3] === 128, "crossing within one stroke must stay at the opacity ceiling");
      stroke(canvas, [p(60.5, 30.5)], { opacity: 0.5 });
      expect(Math.abs(pixel(canvas, 60, 30)[3] - 192) <= 1, "a second stroke may accumulate over the first");
      const lowFlow = make();
      stroke(lowFlow, [p(60.5, 30.5)], { opacity: 0.5, flow: 0.1 });
      const initial = pixel(lowFlow, 60, 30)[3];
      const built = make(); stroke(built, points, { opacity: 0.5, flow: 0.1 });
      expect(initial >= 12 && initial <= 13, "flow controls the single dab amount");
      expect(pixel(built, 60, 30)[3] > initial && pixel(built, 60, 30)[3] <= 128, "flow builds towards, not past, opacity");
      checks.push("single-stroke opacity cap, flow buildup, separate-stroke compositing");
    }
    {
      const canvas = make(160, 120, "#336699"), before = data(canvas);
      const brush = new DraftBrushStroke(canvas, opts({ erase: true, opacity: 0.5 }), p(40.5, 40.5));
      brush.append([p(100.5, 40.5, 16), p(40.5, 40.5, 32)]);
      expect(pixel(canvas, 60, 40)[3] === 128, "eraser must remove alpha with a per-stroke ceiling");
      expect(pixel(canvas, 60, 40)[2] > 145, "eraser must not paint its foreground colour");
      brush.takeDirtyBounds(); brush.cancel();
      expect(same(before, data(canvas)), "cancel must restore all original pixels");
      expect(brush.takeDirtyBounds() !== null, "cancel must invalidate the restored region");
      expect(brush.finish().length === 0, "cancelled strokes must not enter history");
      stroke(canvas, [p(40.5, 40.5)], { erase: true, color: "transparent" });
      expect(pixel(canvas, 40, 40)[3] === 0 && pixel(canvas, 5, 5)[3] === 255, "full eraser affects only its local pixels");
      checks.push("real alpha eraser, cancellation, full-erase transparency");
    }
    {
      const hard = make(), soft = make(), light = make();
      stroke(hard, [p(40.5, 40.5)]);
      stroke(soft, [p(40.5, 40.5)], { hardness: 0 });
      stroke(light, [p(40.5, 40.5, 0, 0.25)]);
      expect(pixel(hard, 48, 40)[3] === 255 && pixel(soft, 48, 40)[3] < 80, "hardness must change the tip edge falloff");
      expect(pixel(light, 40, 40)[3] > 0 && pixel(light, 45, 40)[3] === 0, "pressure must change diameter");
      checks.push("hard/soft tip falloff and pressure diameter");
    }
    {
      const samples = Array.from({ length: 40 }, (_, i) => p(10.5 + i * 3, 60.5 + Math.sin(i / 4) * 20, i * 4, 0.3 + i / 60));
      const together = make(), separate = make();
      stroke(together, samples, { size: 9, hardness: 0.4, flow: 0.3, opacity: 0.7, smoothing: 0.4 }, samples.length);
      stroke(separate, samples, { size: 9, hardness: 0.4, flow: 0.3, opacity: 0.7, smoothing: 0.4 }, 1);
      expect(same(data(together), data(separate)), "event batching must not change the painted pixels");
      const sparse = make(), dense = make();
      stroke(sparse, [p(5.5, 60.5), p(154.5, 60.5, 100)], { size: 3, opacity: 0.6, flow: 0.2 });
      stroke(dense, Array.from({ length: 150 }, (_, i) => p(5.5 + i, 60.5, i)), { size: 3, opacity: 0.6, flow: 0.2 });
      const sa = data(sparse), da = data(dense);
      expect(sa.every((v, i) => Math.abs(v - da[i]) <= 1), "spacing must carry remainder across input segments");
      for (let x = 6; x < 154; x++) expect(pixel(sparse, x, 60)[3] > 0, "a fast small brush must leave no gaps");
      checks.push("batched/unbatched exact pixels, distance spacing and fast small-brush continuity");
    }
    {
      const canvas = make();
      stroke(canvas, [p(5.5, 45.5), p(140.5, 45.5, 16)], { size: 40, selection: { x: 50, y: 40, width: 20, height: 10 } });
      const all = data(canvas);
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        if (x < 50 || x >= 70 || y < 40 || y >= 50) expect(all[(y * canvas.width + x) * 4 + 3] === 0, "selection must clip every painted pixel");
      }
      expect(pixel(canvas, 60, 45)[3] > 0, "selection interior must still paint");
      const outside = make();
      expect(stroke(outside, [p(-25, 5), p(-25, 110, 16)], { size: 8 }).length === 0, "outside points must not clamp onto the canvas edge");
      const empty = make();
      expect(stroke(empty, [p(30, 30)], { opacity: 0 }).length === 0, "zero opacity must have no history");
      expect(stroke(empty, [p(30, 30, 0, 0)]).length === 0, "zero pressure must paint nothing");
      checks.push("rectangular selection, off-canvas points, no-op strokes");
    }
    {
      const canvas = make(1024, 1024, "#789abc"), before = data(canvas), context = canvas.getContext("2d");
      const reads = [], original = context.getImageData.bind(context);
      context.getImageData = (...args) => { reads.push(args); return original(...args); };
      const samples = Array.from({ length: 80 }, (_, i) => p(100.5 + i * 2, 128.5, i * 4));
      const patches = stroke(canvas, samples, { size: 18, opacity: 0.7 });
      expect(reads.length < samples.length / 4 && reads.every(args => args[2] <= 128 && args[3] <= 128), "capture each touched tile once, never read the full canvas per event");
      context.getImageData = original;
      const after = data(canvas), history = new DraftHistory();
      const bytes = patches.reduce((sum, patch) => sum + patch.before.byteLength + patch.after.byteLength, 0);
      expect(bytes < canvas.width * canvas.height, "local patches should not retain whole-canvas snapshots");
      history.push({ undo: () => applyPixelPatches(canvas, patches, "before"), redo: () => applyPixelPatches(canvas, patches, "after"), bytes });
      history.undo(); expect(same(before, data(canvas)), "pixel-patch undo restores exact canvas pixels");
      history.redo(); expect(same(after, data(canvas)), "pixel-patch redo restores exact canvas pixels");
      checks.push("local tile readback, bounded patches, real-canvas undo/redo");
    }
    {
      const canvas = make(), brush = new DraftBrushStroke(canvas, opts({ size: 6, smoothing: 0.9 }), p(10.5, 30.5));
      brush.append([p(20.5, 30.5, 2)]);
      brush.finish(p(140.5, 30.5, 4));
      expect(pixel(canvas, 140, 30)[3] === 255, "finish must consume the terminal point and catch up the smoothed tail");
      checks.push("terminal sample and smoothing tail completion");
    }

    // Timing observations only: real Chromium Canvas on synthetic inputs, not native pen latency.
    const performanceRuns = [];
    for (const size of [256, 2048, 4096]) {
      const canvas = make(size, size), samples = Array.from({ length: 241 }, (_, i) =>
        p(24 + (size - 48) * i / 240, size / 2 + Math.sin(i / 13) * size / 5, i * 4));
      const begin = performance.now();
      const brush = new DraftBrushStroke(canvas, opts({ size: 32, hardness: 0.4, opacity: 0.8, flow: 0.3, smoothing: 0.15 }), samples[0]);
      const pressMs = performance.now() - begin, frames = [];
      for (let i = 1; i < samples.length; i += 4) {
        const start = performance.now(); brush.append(samples.slice(i, i + 4)); brush.takeDirtyBounds();
        frames.push(performance.now() - start);
      }
      const finish = performance.now(), patches = brush.finish(), finishMs = performance.now() - finish;
      frames.sort((a, b) => a - b);
      const bytes = patches.reduce((sum, patch) => sum + patch.before.byteLength + patch.after.byteLength, 0);
      if (size > 256) performanceRuns.push({ canvas: `${size}x${size}`, sampleCount: samples.length, samplesPerBatch: 4,
        brushSize: 32, pressMs, batchP50Ms: frames[Math.floor(frames.length * .5)], batchP95Ms: frames[Math.floor(frames.length * .95)],
        batchMaxMs: frames.at(-1), finishMs, patchCount: patches.length, historyBytes: bytes });
    }
    return { checks, performanceRuns, userAgent: navigator.userAgent, scope: "isolated Chromium Canvas; synthetic samples; no native stylus, UI compositor or file I/O" };
  });
  assert.deepEqual(errors, []);
  await mkdir(".tmp/draft-brush", { recursive: true });
  await writeFile(".tmp/draft-brush/performance.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PASS ${report.checks.length} real Canvas brush groups`);
  for (const check of report.checks) console.log(`  ${check}`);
  console.log(JSON.stringify(report.performanceRuns, null, 2));
} finally {
  await browser.close();
  await server.close();
}
