import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { isolatedCanvasIpc, openWebView } from './fixtures/canvas-interaction-performance/webview2.mjs';

// Exercise CanvasWorkspace.tsx through the real App project-directory entry.
// Run from apps/desktop. Use --baseline on the pre-change source and
// --webview2 to run the same fixture in the isolated native Windows host.
const baseline = process.argv.includes('--baseline');
const native = process.argv.includes('--webview2');
const ipc = native ? isolatedCanvasIpc() : null;
const fixture = 'scripts/fixtures/canvas-interaction-performance/preview.html';
const entry = size => `${fixture}?overview&detail-route&media-home${size ? `&${size}` : ''}`;
const loadingText = '正在打开项目';
const server = await createServer({
  cacheDir: `.tmp/project-open-performance-vite${native ? '-native' : ''}`,
  plugins: ipc ? [ipc.plugin] : [],
  optimizeDeps: { esbuildOptions: ipc?.esbuildOptions },
  server: { host: '127.0.0.1', port: 17420, strictPort: false, hmr: false, watch: null },
});

await server.listen();
const origin = server.resolvedUrls.local[0];
let host, browser;
try {
  // Start the WebView2 debugging target on local plain text, then install the
  // network guard before opening the real fixture.
  host = native ? await openWebView(origin, 'scripts/fixtures/canvas-interaction-performance/README.md') : null;
  browser = host?.browser ?? await chromium.launch({ channel: 'chrome', headless: true });
  const page = host?.page ?? await browser.newPage();
  await page.setViewportSize({ width: 1800, height: 1200 });
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin
    ? route.continue() : route.abort());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const ready = page.locator('.canvas-workspace[aria-busy="false"]');
  const back = page.getByRole('button', { name: '返回主页', exact: true });
  const loading = page.getByRole('status').filter({ hasText: loadingText });
  const projects = page.getByRole('navigation', { name: '首页' }).getByRole('button', { name: '项目', exact: true });
  const open = page.getByRole('button', { name: '打开项目 引用布局合成验收', exact: true });
  const report = { mode: baseline ? 'before' : 'after', browser: native ? 'WebView2' : 'Chrome', browserVersion: browser.version(), measuredAt: new Date().toISOString(),
    environment: 'Vite development, synthetic IPC', viewport: [1800, 1200], zoom: .2, samples: [] };

  for (const [size, count, runs] of [['small', 24, 1], ['', 300, 1], ['large', 1002, 3]]) {
    await page.goto(origin + entry(size), { waitUntil: 'domcontentloaded' });
    await projects.click({ timeout: 30000 });
    await open.waitFor();
    const savedCanvas = await page.evaluate(() => window.snapshot());
    const savedWorkflowNodes = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes);
    for (let run = 1; run <= runs; run++) {
      await open.evaluate((button, loadingText) => {
        window.projectOpenSample = new Promise(resolve => {
          const frames = [];
          const tasks = [];
          let start, previous, loadingAt, readyAt;
          let loadingFrames = 0;
          let ctmReads = 0;
          const screenMatrix = SVGGraphicsElement.prototype.getScreenCTM;
          SVGGraphicsElement.prototype.getScreenCTM = function() {
            if (start !== undefined) ctmReads++;
            return screenMatrix.call(this);
          };
          button.addEventListener('pointerdown', () => { start = performance.now(); }, { once: true, capture: true });
          const observer = new PerformanceObserver(list => tasks.push(...list.getEntries()));
          if (PerformanceObserver.supportedEntryTypes.includes('longtask')) observer.observe({ type: 'longtask' });
          function sample() {
            const now = performance.now();
            if (start !== undefined) {
              frames.push(now - (previous ?? start));
              if (readyAt === undefined) {
                const status = Array.from(document.querySelectorAll('[role="status"]'))
                  .find(element => element.textContent.includes(loadingText));
                if (status && (loadingAt !== undefined || status.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))) {
                  loadingAt ??= now;
                  loadingFrames++;
                }
                // The first mounted shell is not ready. Sample through the first
                // live workflow card, then include post-entry geometry and paint.
                if (document.querySelector('.canvas-workspace[aria-busy="false"] [data-workflow-card="workflow-0"]')) readyAt = now;
              }
              if ((readyAt && now - readyAt >= 350) || now - start > 15000) {
                SVGGraphicsElement.prototype.getScreenCTM = screenMatrix;
                tasks.push(...observer.takeRecords());
                observer.disconnect();
                resolve({
                  loadingMs: loadingAt === undefined ? null : Math.round(loadingAt - start), loadingFrames,
                  readyMs: readyAt === undefined ? null : Math.round(readyAt - start),
                  maxFrameMs: Math.round(Math.max(...frames)), framesOver100Ms: frames.filter(ms => ms > 100).length,
                  longTasks: tasks.filter(task => task.startTime + task.duration >= start)
                    .map(task => ({ startMs: Math.round(task.startTime - start), durationMs: Math.round(task.duration) })),
                  ctmReads,
                });
                return;
              }
            }
            previous = now;
            requestAnimationFrame(sample);
          }
          requestAnimationFrame(sample);
        });
      }, loadingText);
      await open.click();
      const sample = await page.evaluate(() => window.projectOpenSample);
      report.samples.push({ cards: count, run, ...sample });
      if (sample.readyMs === null) {
        const state = await page.evaluate(() => ({
          projectId: window.store.getState().activeProjectId,
          routePending: window.store.getState().projectRoutePending,
          busy: document.querySelector('.canvas-workspace')?.getAttribute('aria-busy'),
          nodes: document.querySelectorAll('.canvas-workspace [data-canvas-node]').length,
          workflows: document.querySelectorAll('.canvas-workspace [data-workflow-card]').length,
          loadFailure: document.querySelector('.canvas-load-failure')?.textContent,
          reads: window.calls.filter(call => ['project_canvas_get', 'canvas_workflow_get', 'set_active_project'].includes(call.command)),
        }));
        assert.fail(`project ${count}/${run} never became ready\n${JSON.stringify({ state, sample, errors })}`);
      }
      await ready.locator('[data-workflow-card="workflow-0"]').waitFor();
      const camera = await ready.locator('.canvas-plane').evaluate(plane => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(plane).transform);
        return [matrix.e, matrix.f, matrix.a];
      });
      assert.deepEqual(camera, [savedCanvas.view.panX, savedCanvas.view.panY, savedCanvas.view.zoom]);
      const wireError = await ready.evaluate(workspace => {
        const path = workspace.querySelector('[data-workflow-target="workflow-0"].is-text');
        const port = workspace.querySelector('[data-canvas-node-id="content-0"] [data-workflow-cell="cell-0"]');
        const stage = workspace.querySelector('.canvas-stage');
        const plane = workspace.querySelector('.canvas-plane');
        const start = path?.getAttribute('d')?.match(/M\s*([-\d.e]+)[ ,]+([-\d.e]+)/i);
        if (!port || !stage || !plane || !start) return null;
        const portRect = port.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        const matrix = new DOMMatrixReadOnly(getComputedStyle(plane).transform);
        return Math.hypot(
          Number(start[1]) - (portRect.x + portRect.width / 2 - stageRect.x - matrix.e) / matrix.a,
          Number(start[2]) - (portRect.y + portRect.height / 2 - stageRect.y - matrix.f) / matrix.d,
        );
      });
      assert.ok(wireError !== null && wireError < 1, `first-screen wire still meets its cell port (${wireError})`);
      await back.click();
      await open.waitFor();
      const restored = await page.evaluate(() => {
        const { nodes, edges } = window.snapshot();
        const workflowNodes = JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes;
        return { nodes, edges, workflowNodes };
      });
      // Existing default card-name materialization may advance the revision.
      assert.deepEqual(restored, { nodes: savedCanvas.nodes, edges: savedCanvas.edges, workflowNodes: savedWorkflowNodes },
        'opening and exiting preserve saved cards, positions and connections');
    }
  }

  console.log(`${report.browser} ${report.browserVersion} (${report.mode})`);
  console.table(report.samples.map(({ longTasks, ...sample }) => ({
    ...sample, maxLongTaskMs: Math.max(0, ...longTasks.map(task => task.durationMs)),
  })));

  if (!baseline) {
    const large = report.samples.filter(sample => sample.cards === 1002);
    for (const sample of large) {
      assert.ok(sample.loadingFrames >= 2 && sample.loadingMs < sample.readyMs,
        'the loading status is visible across animation frames before the large canvas becomes ready');
      assert.ok(sample.loadingMs <= 250 && sample.readyMs <= 1600 && sample.maxFrameMs <= 250,
        `large project misses the isolated entry responsiveness budget: ${JSON.stringify(sample)}`);
      assert.equal(sample.ctmReads, 0, 'port geometry no longer forces an SVG transform read');
    }

    await open.click();
    await loading.waitFor();
    await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="true"] .canvas-plane [data-canvas-node]'));
    await back.evaluate(button => {
      window.returnDuringMount = new Promise(resolve => button.addEventListener('pointerdown', () => {
        const started = performance.now();
        function sample() {
          if (!document.querySelector('.canvas-workspace')) resolve(Math.round(performance.now() - started));
          else requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      }, { once: true, capture: true }));
    });
    await back.click();
    await open.waitFor();
    report.returnDuringMountMs = await page.evaluate(() => window.returnDuringMount);
    assert.ok(report.returnDuringMountMs <= 500, `Return was delayed by mounting for ${report.returnDuringMountMs}ms`);

    // Hold an old project's snapshot until after a different project is
    // already usable. Use the real Return and project-card click handlers.
    await page.evaluate(async () => {
      const state = window.store.getState();
      const [first] = state.projects;
      window.libraryProject = { ...first, id: 'library-project', name: '空项目', asset_count: 0 };
      await state.reloadProjects();
      window.calls.length = 0;
      const bridge = window.__CANVAS_TEST_IPC__ ?? window.__TAURI_INTERNALS__;
      const invoke = bridge.invoke;
      const delayed = new Promise(resolve => { window.releaseOldSnapshot = resolve; });
      bridge.invoke = async (command, args) => {
        if (command === 'project_canvas_get' && args.projectId === 'p' && window.releaseOldSnapshot) {
          window.oldSnapshotStarted = true;
          await delayed;
          window.oldSnapshotReturned = true;
        }
        return invoke(command, args);
      };
    });
    await open.click();
    await page.waitForFunction(() => window.oldSnapshotStarted === true);
    await loading.waitFor();
    assert.equal(await back.isEnabled(), true, 'Return remains available while reading a large project');
    await back.click({ timeout: 3000 });
    const other = page.getByRole('button', { name: '打开项目 空项目', exact: true });
    await other.click();
    await ready.waitFor();
    assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), 'library-project');
    const scopes = await page.evaluate(() => window.calls.filter(call => call.command === 'set_active_project')
      .map(call => call.args.projectId ?? null));
    assert.deepEqual(scopes, ['p', null, 'library-project'], 'native scope is set and cleared in route order');
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'project_canvas_ensure').length), 0,
      'normal entry relies on the native project scope to ensure the canvas');
    await page.evaluate(() => { window.releaseOldSnapshot(); window.releaseOldSnapshot = null; });
    await page.waitForFunction(() => window.oldSnapshotReturned === true);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), 'library-project');
    assert.equal(await ready.locator('[data-workflow-card="workflow-0"]').count(), 0);
    assert.equal(await page.locator('.canvas-load-failure').count(), 0);
    await back.click();
    await open.click();
    await ready.locator('[data-workflow-card="workflow-0"]').waitFor();
    assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), 'p');
    const distantCard = ready.locator('[data-workflow-card="workflow-333"]');
    assert.equal(await distantCard.count(), 0, 'offscreen cards do not delay entry to the saved viewport');
    await ready.locator('.canvas-stage').dispatchEvent('wheel', { deltaY: 3930, bubbles: true, cancelable: true });
    await distantCard.waitFor();
    assert.equal(await distantCard.evaluate(element => !element.hasAttribute('data-canvas-offscreen')), true,
      'panning to a deferred card mounts it as a real card');
    const readsBeforeRejectedExit = await page.evaluate(async () => {
      const { projectCanvasCallbacks } = await import('/src/lib/projectCanvasCallbacks.ts');
      window.previousCanvasFlush = projectCanvasCallbacks.flush;
      projectCanvasCallbacks.flush = async () => { throw new Error('隔离保存失败'); };
      return window.calls.filter(call => call.command === 'project_canvas_get').length;
    });
    await back.click();
    await page.waitForFunction(() => window.store.getState().activeProjectId === 'p' && !window.store.getState().projectRoutePending);
    assert.equal(await ready.isVisible(), true, 'a failed save leaves the restored workspace usable');
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'project_canvas_get').length), readsBeforeRejectedExit,
      'a failed exit does not replace the live workspace with a new saved snapshot');
    await page.evaluate(async () => { (await import('/src/lib/projectCanvasCallbacks.ts')).projectCanvasCallbacks.flush = window.previousCanvasFlush; });
    await back.click();
    await open.waitFor();
    await page.evaluate(() => {
      const bridge = window.__CANVAS_TEST_IPC__ ?? window.__TAURI_INTERNALS__;
      const invoke = bridge.invoke;
      const delayed = new Promise(resolve => { window.releaseProjectScope = resolve; });
      bridge.invoke = async (command, args) => {
        if (command === 'set_active_project' && args.projectId === 'p') await delayed;
        return invoke(command, args);
      };
    });
    await open.click();
    await page.locator('.project-folder-opening[role="status"]').waitFor();
    assert.equal(await page.locator('.canvas-workspace').count(), 0, 'the project card reports progress while the native scope is pending');
    await page.evaluate(() => window.releaseProjectScope());
    await ready.locator('[data-workflow-card="workflow-0"]').waitFor();
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'project_canvas_touch').length), 0,
      'the native project scope records the open without a second write after hydration');
    console.log(`Project entry: return during mounting in ${report.returnDuringMountMs}ms, stale snapshot isolation, and deferred card reached by panning.`);
  }
  assert.deepEqual(errors, []);
  const out = '.tmp/project-open-performance';
  await mkdir(out, { recursive: true });
  await writeFile(`${out}/${report.mode}-${report.browser.toLowerCase()}.json`, JSON.stringify(report, null, 2) + '\n');
} finally {
  try {
    if (host) await host.close();
    else await browser?.close();
  } finally {
    await server.close();
  }
}
