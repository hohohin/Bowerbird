import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const out = '.tmp/loop-card-design';
await mkdir(out, { recursive: true });
const server = await createServer({ cacheDir: '.tmp/loop-design-vite', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 920 }, deviceScaleFactor: 1.5, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const card = page.locator('[data-workflow-card="shot-loop"]');
  const choice = card.getByRole('button', { name: '循环起始项' });
  const mode = card.getByRole('combobox', { name: '循环方式' });
  const checkFrame = index => page.waitForFunction(i => {
    const frame = document.querySelector('.workflow-loop-frame');
    const cell = document.querySelector(`[data-canvas-cell="shots-${i}"]`);
    const wire = document.querySelector('[data-workflow-target="shot-loop"]');
    if (!frame || !cell || !wire) return false;
    const box = frame.getBoundingClientRect(), row = cell.getBoundingClientRect();
    const socket = wire.getPointAtLength(0).matrixTransform(wire.getScreenCTM());
    return Math.abs(box.top - row.top) < 1 && Math.abs(box.bottom - row.bottom) < 1 &&
      Math.abs(socket.x - box.right) < 1 && Math.abs(socket.y - (box.top + box.height / 2)) < 1 &&
      frame.textContent === `${String(i + 1).padStart(2, '0')} / 04`;
  }, index);
  const screenshot = async (name) => {
    await page.mouse.move(5, 5);
    const box = await card.boundingBox();
    await page.screenshot({ path: `${out}/${name}.png`, clip: { x: box.x - 14, y: box.y - 34, width: box.width + 40, height: box.height + 60 } });
  };
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/workflow-loop/preview.html`);
  await choice.click();
  await page.getByRole('option', { name: /第 2 项.*手部特写/ }).click();
  await page.reload();
  await choice.waitFor();
  assert.match(await choice.innerText(), /手部特写/);
  await checkFrame(1);
  const sourceBox = await page.locator('[data-canvas-node-id="shots"]').boundingBox();
  const loopBox = await card.boundingBox();
  await page.screenshot({ path: `${out}/b2-canvas.png`, clip: { x: sourceBox.x - 8, y: sourceBox.y - 30,
    width: loopBox.x + loopBox.width - sourceBox.x + 16, height: Math.max(sourceBox.height, loopBox.height) + 44 } });
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  const handle = await page.locator('[data-canvas-node-id="shots"] .canvas-text-handle').boundingBox();
  await page.mouse.move(handle.x + 12, handle.y + 7);
  await page.mouse.down();
  await page.mouse.move(handle.x + 35, handle.y + 39, { steps: 6 });
  await page.mouse.up();
  await checkFrame(1);
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await screenshot('ready');
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const get = api.projectCanvasGet;
    api.projectCanvasGet = async (...args) => {
      // Pause an isolated read before the next delivery. No provider or real library is involved.
      const run = canvasWorkflowController('p').document.run;
      if (run?.status === 'running' && run.loop?.index === 2 && !window.loopGate) {
        await new Promise(resolve => { window.loopGate = resolve; });
      }
      return get(...args);
    };
  });
  await card.getByRole('button', { name: '开始循环', exact: true }).click();
  await page.waitForFunction(() => typeof window.loopGate === 'function');
  await checkFrame(2);
  assert.equal(await choice.isDisabled(), true);
  assert.equal(await mode.isDisabled(), true);
  assert.equal(await card.locator('progress').getAttribute('value'), '1');
  assert.equal(await card.locator('progress').getAttribute('max'), '3');
  // Exercise layout using an unbroken file name in each variable-length field.
  const overflow = await card.evaluate(el => {
    const originalWidth = el.style.width;
    const fields = ['.workflow-loop-item-text', '.loop-progress > small', '.workflow-bindings button']
      .map(selector => el.querySelector(selector).firstChild);
    const values = fields.map(field => field.textContent);
    try {
      el.style.width = '250px';
      for (const field of fields) field.textContent = 'shot_sequence_'.repeat(45);
      const body = el.querySelector('.workflow-card-body');
      return body.scrollWidth - body.clientWidth;
    } finally {
      fields.forEach((field, i) => { field.textContent = values[i]; });
      el.style.width = originalWidth;
    }
  });
  assert.ok(overflow <= 1, `long loop content exceeded card body by ${overflow}px`);
  await screenshot('running');
  await card.getByRole('button', { name: '停止工作流' }).click();
  await page.evaluate(() => window.loopGate());
  const resume = card.getByRole('button', { name: '从第 3 项继续' });
  await resume.waitFor();
  await page.evaluate(() => window.save());
  await page.reload();
  await resume.waitFor();
  await screenshot('stopped');
  const checkpoint = await page.evaluate(() => ({ workflow: JSON.parse(sessionStorage.getItem('workflow-p')), canvas: window.snapshot() }));
  await resume.click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');
  const results = () => page.evaluate(() => JSON.parse(window.snapshot().nodes.find(node => node.id === 'result').payloadJson).cells.flat().map(cell => cell.text));
  assert.deepEqual(await results(), ['手部特写，倒入燕麦奶', '俯拍，杯面泛起涟漪', '拉远，人物端杯离开']);
  await page.locator('.workflow-loop-frame').waitFor({ state: 'detached' });
  await choice.click();
  await page.getByRole('option', { name: /第 4 项/ }).click();
  await card.getByRole('button', { name: '开始新循环' }).click();
  await page.waitForFunction(() => {
    const doc = JSON.parse(sessionStorage.getItem('workflow-p')).document;
    return doc.runs?.length === 2 && doc.run.status === 'done';
  });
  assert.equal((await results()).length, 4);
  await card.locator('.workflow-loop-results > summary').click();
  await card.getByRole('combobox', { name: '选择循环记录' }).click();
  await page.getByRole('option', { name: /第 1 次.*3 项/ }).click();
  const item = card.locator('.workflow-loop-results details').first();
  await item.locator('summary').click();
  assert.match(await item.locator('.loop-result-output').innerText(), /手部特写/);
  assert.doesNotMatch(await item.innerText(), /bowerbird-table/);
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await page.waitForTimeout(350); // Finish the app's theme transition before capturing contrast.
  await screenshot('history-light');
  await mode.click();
  await page.getByRole('option', { name: '重复执行' }).click();
  const count = card.getByRole('spinbutton', { name: '循环次数' });
  await count.fill('8');
  await count.press('Tab');
  await page.reload();
  assert.equal(await count.inputValue(), '8');
  await choice.press('ArrowDown');
  assert.equal(await page.getByRole('option').count(), 8);
  await page.keyboard.press('Escape');
  assert.equal(await choice.evaluate(el => document.activeElement === el), true);
  await mode.click();
  await page.getByRole('option', { name: '逐张处理图片' }).click();
  assert.equal(await choice.isDisabled(), true);
  assert.match(await card.innerText(), /拖入图片/);
  assert.equal(await card.locator('[role="switch"],input[type="checkbox"]').count(), 0);
  for (const failed of [false, true]) {
    const recovery = await browser.newPage({ viewport: { width: 1500, height: 920 } });
    recovery.on('pageerror', error => errors.push(error.message));
    await recovery.addInitScript(({ checkpoint, failed }) => {
      const snapshot = checkpoint.workflow;
      const run = snapshot.document.run;
      run.status = 'waiting';
      run.steps['shot-writer'] = failed ? { status: 'failed', retrySafe: true } : { status: 'pending' };
      snapshot.document.runs = [run];
      sessionStorage.setItem('workflow-p', JSON.stringify(snapshot));
      sessionStorage.setItem('reference-fixture', JSON.stringify(checkpoint.canvas));
    }, { checkpoint, failed });
    await recovery.goto(page.url());
    const loop = recovery.locator('[data-workflow-card="shot-loop"]');
    await loop.getByRole('button', { name: failed ? '重试失败步骤' : '继续循环', exact: true }).click();
    await recovery.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');
    const finished = await recovery.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run);
    assert.equal(finished.id, checkpoint.workflow.document.run.id);
    assert.equal(finished.loop.completed.length, 3);
    assert.deepEqual(finished.loop.completed[0], checkpoint.workflow.document.run.loop.completed[0]);
    if (!failed) {
      await recovery.evaluate(async () => {
        const { api } = await import('/src/lib/api.ts');
        const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
        const c = canvasWorkflowController('p'), run = structuredClone(c.document.run);
        await api.projectCanvasNodeCreate({ ...window.snapshot().nodes[0], id: 'saved-generation', kind: 'prompt',
          payloadJson: JSON.stringify({ text: '已保存的分镜生成会话', job_id: 'saved-job', status: 'done' }) });
        run.loop.completed[0].outputs['shot-writer'] = { image: { type: 'image', nodeIds: ['saved-generation'] } };
        await c.save({ ...c.document, run, runs: [run] });
        window.emitChange();
      });
      await loop.locator('.workflow-loop-results > summary').click();
      await loop.locator('.workflow-loop-results details > summary').first().click();
      await loop.getByRole('button', { name: '查看生成会话' }).click();
      await recovery.waitForFunction(() => window.store.getState().genPanelOpen === true);
    }
    await recovery.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: edit persistence, run/stop, restart, waiting recovery, retry, fresh run, table results, per-run history and keyboard selection.');
} finally {
  await browser.close();
  await server.close();
}
