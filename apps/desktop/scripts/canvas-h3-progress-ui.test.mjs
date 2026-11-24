import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const entry = "scripts/fixtures/canvas-reference/preview.html";
const server = await createServer({
  cacheDir: ".tmp/canvas-h3-progress/vite",
  optimizeDeps: { entries: [entry] },
  plugins: [{
    name: "observe-workspace-projections",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("/CanvasWorkspace.tsx")) return;
      const marker = "  const generationMedia = useMemo(";
      assert.ok(code.includes(marker));
      return code.replace(marker, "  window.observeCanvasProjection?.(genJobs, conversationCards);\n" + marker);
    },
  }],
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.observeCanvasProjection = (jobs, cards) => {
      window.latestProjection = { jobs, cards };
      window.observedProjections?.push(window.latestProjection);
    };
  });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + entry);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import("/src/lib/canvasWorkflow.ts");
    const { canvasWorkflowController } = await import("/src/lib/canvasWorkflowRuntime.ts");
    const controller = canvasWorkflowController("p");
    await controller.edit([{ ...newWorkflowNode("comfy-video", 100, 150, ""), id: "h3" }]);
    const run = { id: "h3-run", startId: "h3", status: "running", order: ["h3"], steps: {
      h3: { status: "running", jobId: "local-video" },
    } };
    controller.document = { ...controller.document, run, runs: [run] };
    window.reportH3 = value => controller.progress(run.id, "h3", "采样中", { label: "采样中", value, max: 100 });
    window.reportH3(1);
  });
  const progress = page.getByRole("progressbar", { name: "本地视频当前阶段进度" });
  await progress.waitFor();
  await page.evaluate(() => {
    window.observedProjections = [window.latestProjection];
  });
  for (const value of [20, 40, 60, 80]) {
    await page.evaluate(value => window.reportH3(value), value);
    await page.waitForFunction(value => document.querySelector('.comfy-progress-bar')?.getAttribute("aria-valuenow") === String(value), value);
  }
  const counts = await page.evaluate(() => {
    const renders = window.observedProjections;
    return [new Set(renders.map(r => r.jobs)).size, new Set(renders.map(r => r.cards)).size];
  });
  assert.deepEqual(counts, [1, 1], "local progress preserves the project jobs and conversation layout");
  assert.deepEqual(errors, []);
  console.log("PASS: H3 controller progress updates its live card while preserving the board's task and conversation projections");
} finally {
  await browser.close();
  server.httpServer?.closeAllConnections();
  await server.close();
}
