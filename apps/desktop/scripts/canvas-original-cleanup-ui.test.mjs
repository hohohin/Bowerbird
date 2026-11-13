import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ cacheDir: '.tmp/canvas-original-cleanup/vite', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
try {
  for (const missing of [false, true]) {
    await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html`);
    await node('old').waitFor();
    await page.evaluate(() => {
      const snapshot = window.snapshot(), base = snapshot.nodes[0];
      const prompt = (id, turn, createdAt) => ({ ...base, id, kind: 'prompt', assetId: null, role: null, x: 300, y: 100, width: 260, height: 148, createdAt,
        payloadJson: JSON.stringify({ schema_version: 1, job_id: 'job', turn_key: turn, text: turn, provider: 'codex', status: 'done' }) });
      const outputs = ['a','b','c'].map((assetId, i) => ({ ...base, id: `output-${assetId}`, assetId, role: 'output', createdAt: i + 1,
        payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: assetId, width: 190, height: 150 }, execution: { job_id: 'job', turn_key: assetId === 'c' ? 'two' : 'one' } }) }));
      snapshot.nodes = [{ ...base, x: 50, y: 500 }, prompt('first','one',1), prompt('next','two',2), ...outputs,
        { ...base, id: 'copy-a', assetId: 'a', x: 800, y: 100 }];
      snapshot.edges = outputs.map((output, i) => ({ id: `edge-${i}`, projectId: 'p', threadId: 't', fromNodeId: output.assetId === 'c' ? 'next' : 'first', toNodeId: output.id, kind: 'produced', ordinal: i, createdAt: 1 }));
      snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
      sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    });
    await page.reload(); await page.locator('[data-conversation-image="c"]').waitFor();
    await page.evaluate(missing => { window.missingOriginalIds = missing ? ['a','b','c'] : []; }, missing);
    await page.locator('.ProseMirror').fill('保留未发送草稿');
    const beforeView = await page.evaluate(() => window.snapshot().view);
    for (const assetId of ['c','b','a']) {
      await page.locator(`[data-conversation-image="${assetId}"]`).click({ button: 'right' });
      await page.getByRole('menuitem', { name: '删除', exact: true }).click();
      await page.getByRole('menuitem', { name: '删除原文件', exact: true }).click();
      const dialog = page.getByRole('dialog');
      const confirm = dialog.getByRole('button', { name: missing ? '清理失效条目' : '删除原文件', exact: true });
      await confirm.waitFor();
      if (assetId === 'c') {
        await page.evaluate(() => { window.failAssetDelete = true; });
        await confirm.click(); await dialog.waitFor({ state: 'detached' });
        await page.getByRole('button', { name: '查看文件任务', exact: true }).click();
        assert.equal(await page.locator('[data-conversation-image="c"]').count(), 1, 'failed deletion retains the result');
        await page.evaluate(() => { window.failAssetDelete = false; });
        await dialog.getByRole('button', { name: '重试失败项' }).click();
        await page.keyboard.press('Escape');
      } else await confirm.click();
      await dialog.waitFor({ state: 'detached' });
      await page.locator(`[data-conversation-image="${assetId}"]`).waitFor({ state: 'detached' });
      if (assetId === 'c') { await node('next').waitFor({ state: 'detached' }); await node('first').waitFor(); }
      if (assetId === 'b') { await node('first').waitFor(); await page.locator('[data-conversation-image="a"]').waitFor(); }
    }
    await node('first').waitFor({ state: 'detached' }); await node('copy-a').waitFor({ state: 'detached' });
    assert.equal(await node('old').count(), 1);
    assert.match(await page.locator('.ProseMirror').innerText(), /保留未发送草稿/);
    const snapshot = await page.evaluate(() => window.snapshot());
    assert.deepEqual(snapshot.view, beforeView, 'deletion keeps the current camera');
    assert.equal(snapshot.edges.length, 3, 'generation history remains');
    assert.equal(snapshot.nodes.filter(n => n.assetId && n.assetId !== 'existing').length, 4, 'asset identities remain');
    await page.evaluate(() => { window.emitAssetsChanged(); window.save(); }); await page.reload(); await node('old').waitFor();
    assert.equal(await node('first').count(), 0); assert.equal(await node('next').count(), 0); assert.equal(await node('copy-a').count(), 0);
    await page.evaluate(() => sessionStorage.clear());
  }
  assert.deepEqual(errors, []);
  console.log('PASS original recycling and missing cleanup: actual menu/confirmation, failure/retry, remaining gallery outputs, last-output card, duplicate instance, history/draft/camera, repeated refresh and reload');
} catch (error) { console.error(error); throw error; } finally { await browser.close(); await server.close(); }
