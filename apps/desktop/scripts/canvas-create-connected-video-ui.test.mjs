import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const entry = 'scripts/fixtures/canvas-reference/preview.html';
const server = await createServer({ cacheDir: '.tmp/canvas-connected-video-vite', optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 17978, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + entry);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), old = snapshot.nodes.find(node => node.id === 'old');
    const turn = (id, time) => ({ ...old, id, kind: 'prompt', role: null, assetId: null, x: 150, y: 370, createdAt: time,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: 'session', turn_key: id, status: 'done', text: '上游', provider: 'codex' }) });
    const output = (id, turnKey) => ({ ...old, id: 'output-' + id, role: 'output', assetId: id,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: id, width: 190, height: 150 },
        execution: { job_id: 'session', turn_key: turnKey } }) });
    snapshot.nodes = [{ ...old, x: 150, y: 90 }, turn('first', 1), output('a', 'first'),
      turn('next', 2), output('b', 'next'), output('c', 'next')];
    snapshot.view = { ...snapshot.view, zoom: 0.8, panX: 60, panY: 40 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 0, document: { schema_version: 1, nodes: [], run: null } }));
  });
  const nodes = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes);
  const wire = page.locator('path[data-auto-connection]');
  const card = page.locator('[data-workflow-card]');
  async function createVideo(sourceId, failure = '') {
    await page.reload();
    const source = page.locator(`[data-canvas-node-id="${sourceId}"]`);
    await source.hover();
    if (failure === 'save') {
      // Leave a real canvas edit in the native write queue while the user connects a card.
      await page.evaluate(() => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (command, args) => {
          if (command === 'project_canvas_node_update' && args.nodeId === 'old') {
            await new Promise(resolve => { window.finishMove = resolve; });
          }
          return invoke(command, args);
        };
      });
      await source.focus();
      await source.press('ArrowRight');
      await page.waitForFunction(() => !!window.finishMove);
    }
    const handle = page.locator(`[data-workflow-material="${sourceId}"] [data-canvas-connect-side="output"]`);
    const from = await handle.boundingBox(), stage = await page.locator('.canvas-stage').boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    const drop = { x: stage.x + stage.width * .62, y: stage.y + stage.height * .24 };
    await page.mouse.move(drop.x, drop.y, { steps: 12 });
    await page.mouse.up();
    const option = page.getByRole('menu', { name: '添加下游', exact: true }).getByRole('menuitem', { name: '视频生成', exact: true });
    await option.waitFor();
    await option.evaluate((button, { sourceId, failure }) => {
      const times = window.videoCreation = { writes: 0 };
      const elapsed = () => Math.round(performance.now() - times.start);
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const typed = sourceId === 'first' ? new Promise(resolve => { window.finishTyping = resolve; }) : Promise.resolve();
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'project_canvas_visible_nodes') {
          await Promise.all([delay(600), typed]);
          times.checked = elapsed();
          if (failure === 'missing') return [];
        }
        if (command === 'canvas_workflow_save' && args.document.nodes.some(node => node.generation?.media === 'video')) {
          times.writes++;
          await delay(200);
          if (failure === 'save' && times.writes === 1) { times.rejected = elapsed(); throw '模拟视频卡片保存失败'; }
          const result = await invoke(command, args);
          times.saved = elapsed();
          return result;
        }
        return invoke(command, args);
      };
      button.addEventListener('click', () => {
        times.start = performance.now();
        if (failure === 'save') setTimeout(() => { times.move = elapsed(); window.finishMove(); }, 500);
        const observe = () => {
          const card = document.querySelector('[data-workflow-card]'), wire = document.querySelector('path[data-auto-connection]');
          const rect = card?.getBoundingClientRect();
          if (rect?.width && rect.height && rect.left < innerWidth && rect.top < innerHeight && times.card == null) {
            times.card = elapsed();
            times.firstId = card.dataset.workflowCard;
            times.position = { x: rect.x, y: rect.y };
          }
          if (wire && wire.getTotalLength() && times.wire == null) {
            times.wire = elapsed();
            times.firstWire = wire.dataset.autoConnection;
          }
          if (times.wire == null || times.card == null) requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
      }, { once: true, capture: true });
    }, { sourceId, failure });
    await option.click();
    if (sourceId === 'first') {
      const editor = card.getByRole('textbox', { name: '卡片指令' });
      await editor.fill('保留镜头运动');
      await editor.press('Tab');
      await page.evaluate(() => window.finishTyping());
    }
    if (failure === 'missing') {
      await page.waitForFunction(() => window.videoCreation.checked != null);
      await card.waitFor({ state: 'detached' });
      await page.locator('.app-toast.is-error').waitFor();
      assert.equal(await wire.count(), 0);
      assert.deepEqual(await nodes(), []);
    } else {
      if (failure === 'save') {
        const retry = page.getByRole('button', { name: '重试保存', exact: true });
        await retry.waitFor();
        assert.deepEqual(await nodes(), []);
        assert.equal(await card.count(), 1);
        assert.equal(await wire.count(), 1);
        await retry.click();
        await retry.waitFor({ state: 'detached' });
      }
      await page.waitForFunction(() => ['card', 'wire', 'saved'].every(key => window.videoCreation[key] != null));
    }
    const { start, ...times } = await page.evaluate(() => window.videoCreation);
    console.log(sourceId, failure || 'success', times);
    assert.ok(times.card < times.checked && times.wire < times.checked, 'card and wire must appear before endpoint verification returns');
    assert.ok(Math.abs(times.position.x - drop.x) < 2 && Math.abs(times.position.y - drop.y) < 2, 'place the card at the original drop point');
    if (failure === 'save') assert.ok(times.card < times.move && times.wire < times.move, 'unrelated canvas writes must not delay appearance');
    if (failure === 'missing') {
      assert.equal(times.writes, 0);
      return;
    }
    assert.equal(times.writes, failure === 'save' ? 2 : 1, 'one combined write per attempt');
    const savedNodes = await nodes();
    assert.equal(savedNodes.length, 1);
    const [saved] = savedNodes;
    assert.equal(saved.generation.media, 'video');
    assert.equal(saved.id, times.firstId, 'the saved card keeps its preview identity');
    assert.equal(saved.inputs.image.length, 1);
    assert.equal(saved.inputs.image[0].autoConnect, times.firstWire, 'the first visible connection keeps its identity');
    assert.equal(await wire.getAttribute('data-auto-connection'), saved.inputs.image[0].autoConnect);
    await card.locator('.workflow-video-controls').waitFor();
    const expectedAssets = sourceId === 'first' ? ['c'] : ['existing'];
    await page.waitForFunction(({ cardId, expected }) => {
      const target = document.querySelector(`[data-workflow-card="${CSS.escape(cardId)}"]`);
      const refs = [...target?.querySelectorAll('[data-workflow-reference-asset]') ?? []];
      return refs.length === expected.length && refs.every((ref, i) => ref.dataset.workflowReferenceAsset === expected[i]);
    }, { cardId: saved.id, expected: expectedAssets });
    return saved;
  }

  const materialVideo = await createVideo('old');
  assert.equal(materialVideo.inputs.image[0].assetNodeId, 'old');
  await page.keyboard.press('Control+z');
  await card.waitFor({ state: 'detached' });
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length === 0);
  await page.reload();
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  assert.equal(await wire.count(), 0);
  assert.equal(await card.count(), 0);
  await createVideo('old', 'missing');
  const sessionVideo = await createVideo('first');
  assert.equal(sessionVideo.inputs.image[0].assetId, 'c', 'the grouped card connects the image currently displayed');
  assert.equal(sessionVideo.inputs.image[0].assetNodeId, 'output-c', 'the wire keeps the exact selected output identity');
  assert.equal(sessionVideo.prompt, '保留镜头运动', 'typing before the check completes must survive the first save');
  await page.reload();
  await page.locator(`[data-workflow-card="${sessionVideo.id}"] .workflow-video-controls`).waitFor();
  await wire.waitFor({ state: 'attached' });
  assert.deepEqual(await nodes(), [sessionVideo]);
  assert.equal(await wire.getAttribute('data-auto-connection'), sessionVideo.inputs.image[0].autoConnect);
  await page.evaluate(() => {
    const state = JSON.parse(sessionStorage.getItem('workflow-p'));
    state.document.nodes = [];
    sessionStorage.setItem('workflow-p', JSON.stringify(state));
  });
  await createVideo('old', 'save');
  assert.deepEqual(errors, []);
  console.log('PASS drag to blank, create connected video, pending endpoint verification, atomic save, rollback, undo and reload');
} finally {
  await browser.close();
  await server.close();
}
