import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const baseline = process.argv.includes('--before');
const root = process.cwd(), frozen = path.join(root, '.tmp/canvas-interaction-performance-before/src'), live = path.join(root, 'src');
const out = '.tmp/canvas-interaction-performance'; await mkdir(out, { recursive: true });
const slash = value => value.replaceAll('\\', '/');
const renderedSourceHashes = {};
const server = await createServer({ configFile: false, root, cacheDir: '.tmp/canvas-interaction-performance-vite', plugins: [{
  name: 'interaction-instrumentation', enforce: 'pre',
  resolveId(source, importer) {
    if (!baseline || !importer || !source.startsWith('.')) return;
    const target = path.resolve(path.dirname(importer.split('?')[0]), source);
    if (target.startsWith(live + path.sep)) return this.resolve(slash(path.join(frozen, path.relative(live, target))), importer, { skipSelf: true });
    if (target.startsWith(path.dirname(frozen) + path.sep) && !target.startsWith(frozen + path.sep)) return this.resolve(slash(path.join(root, path.relative(path.dirname(frozen), target))), importer, { skipSelf: true });
  },
  transform(code, id) {
    const kind = /\/CanvasWorkspace\.tsx$/.test(slash(id)) ? 'workspace' : /\/CanvasWorkflowLayer\.tsx$/.test(slash(id)) ? 'workflow' : null;
    if (!kind) return;
    renderedSourceHashes[kind] = createHash('sha256').update(code).digest('hex');
    const marker = kind === 'workspace' ? '  const assets = useStore((state) => state.assets);' : '  const controller = useMemo(() => canvasWorkflowController(projectId), [projectId]);';
    if (!code.includes(marker)) throw new Error(`Missing ${kind} instrumentation anchor`);
    return code.replace(marker, `  if ((window as any).interactionStats) (window as any).interactionStats.${kind}Renders += 1;\n  useLayoutEffect(() => { if ((window as any).interactionStats) (window as any).interactionStats.${kind}Commits += 1; });\n${marker}`);
  },
}], server: { host: '127.0.0.1', port: 1628, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
page.setDefaultTimeout(15000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const material = page.locator('[data-canvas-node-id="material-0"]');
const content = page.locator('[data-canvas-node-id="content-0"]');
const workflow = page.locator('[data-workflow-card="workflow-0"]');
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const snapshot = () => page.evaluate(() => ({ canvas: window.snapshot(), workflow: JSON.parse(sessionStorage.getItem('workflow-p')).document }));
const samples = [];
async function resetStats() { await frame(); await page.evaluate(() => window.resetInteractionStats()); }
async function collect(label, events) {
  await frame();
  const stats = await page.evaluate(() => { const result = window.interactionStats; window.interactionStats = null; return result; });
  samples.push({ label, inputEvents: events, ...stats });
}
async function burstWheel(ctrlKey, delta, count = 48) {
  await page.evaluate(async ({ ctrlKey, delta, count }) => {
    const stage = document.querySelector('.canvas-stage');
    for (let index = 0; index < count; index++) {
      window.interactionFlush(() => stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey,
        clientX: 900, clientY: 500, deltaX: ctrlKey ? 0 : delta, deltaY: ctrlKey ? delta : 0 })));
      if (index % 12 === 11) await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
  }, { ctrlKey, delta, count });
}
async function dragBurst(locator, dx, dy, cancel = false) {
  const box = await locator.boundingBox(), x = box.x + 30, y = box.y + 25;
  await page.mouse.move(x, y); await page.mouse.down();
  await resetStats();
  await locator.evaluate(async (target, { x, y, dx, dy }) => {
    for (let index = 1; index <= 48; index++) {
      window.interactionFlush(() => target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1,
        clientX: x + dx * index / 48, clientY: y + dy * index / 48 })));
      if (index % 12 === 0) await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
  }, { x, y, dx, dy });
  await collect(cancel ? 'cancel-drag' : 'multi-drag', 48);
  const alignment = await page.evaluate(() => {
    const wire = document.querySelector('[data-workflow-target="workflow-0"].is-text');
    const port = document.querySelector('[data-canvas-node-id="content-0"] [data-workflow-cell="cell-0"]').getBoundingClientRect();
    const stage = document.querySelector('.canvas-stage').getBoundingClientRect();
    const matrix = new DOMMatrix(getComputedStyle(document.querySelector('.canvas-plane')).transform);
    const match = wire.getAttribute('d').match(/M\s*([-\d.e]+)[ ,]+([-\d.e]+)/i);
    return Math.hypot(Number(match[1]) - (port.x + port.width / 2 - stage.x - matrix.e) / matrix.a,
      Number(match[2]) - (port.y + port.height / 2 - stage.y - matrix.f) / matrix.d);
  });
  assert.ok(alignment < .05, `Wire endpoint follows the live content port before pointerup (${alignment})`);
  await locator.dispatchEvent(cancel ? 'pointercancel' : 'pointerup', { pointerId: 1, pointerType: 'mouse', clientX: x + dx, clientY: y + dy });
  await page.mouse.up(); await frame();
}
try {
  await page.goto('http://127.0.0.1:1628/scripts/fixtures/canvas-interaction-performance/preview.html');
  await material.waitFor(); await workflow.waitFor(); await page.waitForTimeout(1200);
  assert.equal(await page.locator('.canvas-plane [data-canvas-node]').count(), 300);
  assert.equal(await page.locator('[data-workflow-target]').count(), 200);
  const initial = await snapshot();
  await resetStats(); await burstWheel(false, 1); await collect('pan', 48);
  await page.waitForFunction(() => Math.abs(window.snapshot().view.panX + 48) < .01);
  await burstWheel(false, -1); await page.waitForFunction(() => Math.abs(window.snapshot().view.panX) < .01);
  const zoomAnchor = await page.locator('.canvas-plane').evaluate(element => {
    const stage = element.closest('.canvas-stage').getBoundingClientRect(), matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: (900 - stage.left - matrix.e) / matrix.a, y: (500 - stage.top - matrix.f) / matrix.d };
  });
  await resetStats(); await burstWheel(true, -1); await collect('zoom', 48);
  const afterAnchor = await page.locator('.canvas-plane').evaluate(element => {
    const stage = element.closest('.canvas-stage').getBoundingClientRect(), matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: (900 - stage.left - matrix.e) / matrix.a, y: (500 - stage.top - matrix.f) / matrix.d };
  });
  assert.ok(Math.abs(zoomAnchor.x - afterAnchor.x) < .02 && Math.abs(zoomAnchor.y - afterAnchor.y) < .02, 'Zoom holds the pointer anchor');
  await burstWheel(true, 1); await page.waitForFunction(() => Math.abs(window.snapshot().view.zoom - 1) < .001);
  // Multi-select three different card types using real modifier clicks.
  await page.keyboard.down('Control');
  for (const locator of [material, content, workflow]) {
    const box = await locator.boundingBox(); await page.mouse.click(box.x + 4, box.y + 12);
  }
  await page.keyboard.up('Control');
  assert.equal(await page.locator('.canvas-plane [data-canvas-node].is-selected').count(), 3);
  const beforeWire = await page.locator('[data-workflow-target="workflow-0"]').first().getAttribute('d');
  await dragBurst(material, 70, 35);
  await page.waitForFunction(() => Math.abs(window.snapshot().nodes.find(node => node.id === 'material-0').x - 310) < .01);
  const moved = await snapshot();
  for (const id of ['material-0', 'content-0']) {
    const before = initial.canvas.nodes.find(node => node.id === id), after = moved.canvas.nodes.find(node => node.id === id);
    assert.ok(Math.abs(after.x - before.x - 70) < .01 && Math.abs(after.y - before.y - 35) < .01);
  }
  const beforeWorkflow = initial.workflow.nodes[0], afterWorkflow = moved.workflow.nodes[0];
  assert.ok(Math.abs(afterWorkflow.x - beforeWorkflow.x - 70) < .01 && Math.abs(afterWorkflow.y - beforeWorkflow.y - 35) < .01);
  assert.notEqual(await page.locator('[data-workflow-target="workflow-0"]').first().getAttribute('d'), beforeWire, 'Wire follows moved cards');
  await dragBurst(material, 41, 19, true);
  assert.deepEqual((await snapshot()).canvas.nodes, moved.canvas.nodes, 'Cancelled drag restores persisted canvas geometry');
  assert.deepEqual((await snapshot()).workflow.nodes, moved.workflow.nodes, 'Cancelled drag restores workflow geometry');
  // Release in the same task as the final move: pending animation-frame work must flush.
  const beforePending = await snapshot(), box = await material.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 25); await page.mouse.down();
  await material.evaluate((target, { x, y }) => {
    target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: x + 13, clientY: y + 7 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: x + 13, clientY: y + 7 }));
  }, { x: box.x + 30, y: box.y + 25 });
  await page.mouse.up();
  await page.waitForFunction(x => Math.abs(window.snapshot().nodes.find(node => node.id === 'material-0').x - x - 13) < .01, beforePending.canvas.nodes[0].x);
  const beforeEscape = await snapshot(), beforeEscapeTransform = await material.evaluate(node => node.style.transform), escapeBox = await material.boundingBox();
  await page.mouse.move(escapeBox.x + 30, escapeBox.y + 25); await page.mouse.down();
  await material.evaluate((target, { x, y }) => {
    target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: x + 21, clientY: y + 12 }));
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
  }, { x: escapeBox.x + 30, y: escapeBox.y + 25 });
  await page.mouse.up(); await page.waitForTimeout(180); await frame();
  assert.equal(await material.evaluate(node => node.style.transform), beforeEscapeTransform, 'Escape discards the queued final move without later drift');
  assert.deepEqual((await snapshot()).canvas.nodes, beforeEscape.canvas.nodes);
  assert.deepEqual((await snapshot()).workflow.nodes, beforeEscape.workflow.nodes);
  const returnBefore = await snapshot(), returnTransform = await material.evaluate(node => node.style.transform), returnBox = await material.boundingBox();
  await page.mouse.move(returnBox.x + 30, returnBox.y + 25); await page.mouse.down();
  await material.evaluate((target, { x, y }) => {
    for (const offset of [20, 0]) target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: x + offset, clientY: y }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y }));
  }, { x: returnBox.x + 30, y: returnBox.y + 25 });
  await page.mouse.up(); await frame();
  assert.equal(await page.getByRole('dialog', { name: /媒体预览/ }).count(), 0, 'Crossing the drag threshold then returning in one frame must not activate the asset');
  assert.equal(await material.evaluate(node => node.style.transform), returnTransform);
  assert.deepEqual((await snapshot()).canvas.nodes, returnBefore.canvas.nodes);
  // Real marquee interaction must select the same three top-row card types.
  const stage = await page.locator('.canvas-stage').boundingBox();
  await page.mouse.move(stage.x + 190, stage.y + 110); await page.mouse.down();
  await page.mouse.move(stage.x + 1480, stage.y + 530, { steps: 12 }); await page.mouse.up();
  assert.equal(await page.locator('.canvas-plane [data-canvas-node].is-selected').count(), 3, 'Marquee includes material, content and workflow');
  await page.mouse.click(stage.x + 190, stage.y + 110);
  await page.getByRole('button', { name: '吸附对齐', exact: true }).click();
  const moving = await material.boundingBox(), target = await page.locator('[data-canvas-node-id="material-1"]').boundingBox();
  await page.mouse.move(moving.x + 30, moving.y + 25); await page.mouse.down();
  await page.mouse.move(target.x + 18 + 30, moving.y + 25, { steps: 8 }); await frame();
  assert.ok(Math.abs((await material.boundingBox()).x - target.x) < .05, 'Alignment snaps to the other material edge');
  assert.ok(await page.locator('.canvas-snap-guide').count() > 0);
  await page.mouse.up();
  // Resize a stationary workflow card after snap anchors were first consulted.
  const startForHeight = await material.boundingBox(), oldWorkflowBox = await workflow.boundingBox();
  await page.mouse.move(startForHeight.x + 30, startForHeight.y + 25); await page.mouse.down();
  await page.mouse.move(oldWorkflowBox.x + 50, oldWorkflowBox.y + oldWorkflowBox.height + 105); await frame();
  await workflow.evaluate((node, height) => { node.style.height = `${height}px`; }, oldWorkflowBox.height + 450);
  await frame();
  const grownWorkflow = await workflow.boundingBox();
  await page.mouse.move(grownWorkflow.x + 50, grownWorkflow.y + grownWorkflow.height + 18 + 25); await frame();
  const afterGrowth = await material.boundingBox();
  // Workflow geometry uses integer offsetHeight; the transformed CSS box can be fractional.
  assert.ok(Math.abs(afterGrowth.y - grownWorkflow.y - grownWorkflow.height) < 1,
    `Snap anchors follow a stationary workflow card growing during the drag: ${JSON.stringify({ afterGrowth, grownWorkflow, guides: await page.locator('.canvas-snap-guide').evaluateAll(nodes => nodes.map(node => node.getAttribute('style'))) })}`);
  await page.mouse.up();
  await workflow.evaluate(node => { node.style.height = ''; }); await frame();
  // Keep a real mouse pointer active, cancel its initial resize, then dispatch
  // wheel + a fresh resize pointerdown/move/up in one task before camera settles.
  if (!baseline) {
  const resizeBefore = (await snapshot()).canvas.nodes.find(node => node.id === 'material-0');
  const handle = material.getByRole('button', { name: '调整素材大小', exact: true });
  await material.hover(); const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2); await page.mouse.down();
  await handle.evaluate((target, { x, y }) => {
    target.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
    document.querySelector('.canvas-stage').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, clientX: x, clientY: y, deltaY: -Math.log(2) / .0015 }));
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y }));
    target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: x + 40, clientY: y }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: x + 40, clientY: y }));
  }, { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 });
  await page.mouse.up();
  await page.waitForFunction(width => Math.abs(window.snapshot().nodes.find(node => node.id === 'material-0').width - width - 20) < .01, resizeBefore.width);
  }
  const routeFlush = await page.evaluate(async () => {
    await window.store.getState().projectCanvasFlush();
    const before = window.snapshot().view;
    document.querySelector('.canvas-stage').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 37, deltaY: 11 }));
    // Route leave invokes this same barrier before any 120ms camera settle.
    await window.store.getState().projectCanvasFlush();
    return { before, after: window.snapshot().view, called: window.calls.some(call => call.command === 'project_canvas_view_flush') };
  });
  assert.equal(routeFlush.called, true);
  assert.ok(Math.abs(routeFlush.after.panX - routeFlush.before.panX + 37) < .01 && Math.abs(routeFlush.after.panY - routeFlush.before.panY + 11) < .01,
    'Route barrier persists the freshest wheel view before camera settling');
  assert.deepEqual(errors, []);
  const report = { mode: baseline ? 'before' : 'after', measuredAt: new Date().toISOString(), environment: 'Chrome headless, Vite development, synthetic IPC, 300 mixed cards and 200 workflow input wires',
    method: '48 synthetic input events in four groups of 12; flushSync wraps each dispatch, then two real animation frames allow scheduled work. React still coalesces some native-event commits. Counts describe a deterministic stress fixture, not native event cadence or FPS.',
    checks: ['300 mounted mixed cards and 200 wires', 'pan delta accumulation', 'zoom pointer anchor', 'mixed multi-selection drag persists final geometry', 'cancel rollback', 'wire follows live moving content ports before pointerup', 'pointerup flushes an unpainted final move', 'Escape cancels an unpainted move without later drift', 'same-frame drag threshold roundtrip does not activate asset', ...(!baseline ? ['wheel then resize in one task uses live zoom'] : []), 'route flush persists latest wheel view before camera settles', 'mixed-card marquee', 'alignment snap', 'stationary workflow resize invalidates drag snap geometry'],
    renderedSourceHashes, samples };
  await writeFile(`${out}/${baseline ? 'before' : 'after'}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); await server.close(); }
