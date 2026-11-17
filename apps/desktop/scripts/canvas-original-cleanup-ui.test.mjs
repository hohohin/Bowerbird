import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ cacheDir: '.tmp/canvas-original-cleanup/vite', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
page.setDefaultTimeout(10000);
page.setDefaultNavigationTimeout(90000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
try {
  for (const missing of [false, true]) {
    await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html`, {waitUntil:'domcontentloaded'});
    await node('old').waitFor({timeout:90000});
    await page.evaluate(() => {
      const snapshot = window.snapshot(), base = snapshot.nodes[0];
      const prompt = (id, turn, createdAt) => ({ ...base, id, kind: 'prompt', assetId: null, role: null, x: 300, y: 100, width: 260, height: 148, createdAt,
        payloadJson: JSON.stringify({ schema_version: 1, job_id: 'job', turn_key: turn, text: turn, provider: 'codex', status: 'done' }) });
      const outputs = ['a','b','c'].map((assetId, i) => ({ ...base, id: `output-${assetId}`, assetId, role: 'output', createdAt: i + 1,
        payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: assetId, width: 190, height: 150 }, execution: { job_id: 'job', turn_key: assetId === 'c' ? 'two' : 'one' } }) }));
      snapshot.nodes = [{ ...base, x: 50, y: 500 }, prompt('first','one',1), prompt('next','two',2), ...outputs,
        { ...base, id: 'copy-a', assetId: 'a', x: 800, y: 100 },
        ...[['only-a','a'], ['also-a','a'], ['survivor','d']].map(([id,assetId]) => ({ ...base, id, assetId }))];
      snapshot.groups = ['all-hidden','partial'].map((id, i) => ({ id, projectId: 'p', name: id, role: null,
        x: 1000, y: 100 + i * 220, width: 204, height: 178, zIndex: 1, createdAt: 1, updatedAt: 1 }));
      snapshot.groupItems = [['all-hidden','only-a'], ['partial','also-a'], ['partial','survivor']].map(([groupId,nodeId],ordinal) => ({ projectId:'p', groupId,nodeId,ordinal }));
      snapshot.edges = outputs.map((output, i) => ({ id: `edge-${i}`, projectId: 'p', threadId: 't', fromNodeId: output.assetId === 'c' ? 'next' : 'first', toNodeId: output.id, kind: 'produced', ordinal: i, createdAt: 1 }));
      snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
      sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    });
    await page.reload(); await page.locator('[data-conversation-image="c"]').waitFor();
    await page.evaluate(missing => { window.missingOriginalIds = missing ? ['a','b','c'] : []; }, missing);
    await page.locator('.ProseMirror').fill('保留未发送草稿');
    const beforeView = await page.evaluate(() => window.snapshot().view);
    const dialog = page.getByRole('dialog');
    const confirm = dialog.getByRole('button', { name: missing ? '清理失效条目' : '删除原文件', exact: true });
    // Hold the first OS operation while stale canvas reads and user cancellation are allowed.
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
      window.holdOriginal = true;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'trash_asset_original' && window.holdOriginal) {
          await new Promise(resolve => { window.releaseOriginal = resolve; });
        }
        if (command === 'project_canvas_get' && window.holdCommittedRead) {
          await new Promise(resolve => { window.releaseCommittedRead = resolve; });
        }
        return invoke(command, args);
      };
      window.failAssetDelete = true;
    });
    await page.locator('[data-conversation-image="c"]').click({ button:'right' });
    await page.getByRole('menuitem', { name:'删除当前组', exact:true }).click();
    await page.getByRole('menuitem', { name:'删除原文件…', exact:true }).click();
    const before = await page.evaluate(() => window.snapshot());
    await confirm.click();
    await dialog.waitFor({state:'detached'});
    await page.waitForFunction(() => !!window.releaseOriginal);
    for (const id of ['first','next','copy-a','all-hidden']) await node(id).waitFor({ state:'detached' });
    assert.match(await node('partial').getAttribute('aria-label'), /1 个素材/);
    assert.equal(await node('old').count(), 1);
    await page.evaluate(() => { window.countBeforeRefresh = window.calls.length; window.emitAssetsChanged(); });
    await page.waitForFunction(() => window.calls.slice(window.countBeforeRefresh).some(call => call.command === 'get_assets_by_ids'));
    assert.equal(await node('copy-a').count(),0);
    assert.equal(await node('first').count(),0);
    const waiting = await page.evaluate(() => window.snapshot());
    for (const field of ['nodes','groups','groupItems','edges','view']) assert.deepEqual(waiting[field],before[field], field);
    await page.getByRole('button',{name:'查看文件任务',exact:true}).click();
    await dialog.getByRole('button',{name:'取消剩余项'}).click();
    await page.evaluate(() => { window.holdOriginal = false; window.releaseOriginal(); });
    await dialog.getByRole('button',{name:'收起此结果'}).click();
    await dialog.waitFor({state:'detached'});
    for (const id of ['copy-a','first','all-hidden']) await node(id).waitFor();
    assert.match(await node('partial').getAttribute('aria-label'), /2 个素材/);
    await page.locator('[data-conversation-image="c"]').waitFor();
    for (const assetId of ['c','b','a']) {
      await page.locator(`[data-conversation-image="${assetId}"]`).click({ button: 'right' });
      await page.getByRole('menuitem', { name: '删除当前项', exact: true }).click();
      await page.getByRole('menuitem', { name: '删除原文件…', exact: true }).click();
      await confirm.waitFor();
      if (assetId === 'c') {
        await page.evaluate(() => { window.failAssetDelete = true; });
        await confirm.click(); await dialog.waitFor({ state: 'detached' });
        await page.getByRole('button', { name: '查看文件任务', exact: true }).click();
        await page.locator('[data-conversation-image="c"]').waitFor();
        await page.evaluate(() => { window.failAssetDelete = false; });
        await dialog.getByRole('button', { name: '重试失败项' }).click();
        await page.keyboard.press('Escape');
      } else {
        if (assetId === 'a') await page.evaluate(() => { window.holdCommittedRead = true; });
        await confirm.click();
      }
      await dialog.waitFor({ state: 'detached' });
      await page.locator(`[data-conversation-image="${assetId}"]`).waitFor({ state: 'detached' });
      if (assetId === 'c') { await node('next').waitFor({ state: 'detached' }); await node('first').waitFor(); }
      if (assetId === 'b') { await node('first').waitFor(); await page.locator('[data-conversation-image="a"]').waitFor(); }
      if (assetId === 'a') {
        await page.waitForFunction(async () => !!window.releaseCommittedRead &&
          !(await import('/src/lib/pendingOriginalDeletion.ts')).isPendingOriginal('a'));
        assert.equal(await node('copy-a').count(), 0, 'the committed item stays hidden before a fresh snapshot arrives');
        assert.equal(await node('first').count(), 0);
        await page.evaluate(() => { window.holdCommittedRead = false; window.releaseCommittedRead(); });
      }
    }
    await node('first').waitFor({ state: 'detached' }); await node('copy-a').waitFor({ state: 'detached' });
    assert.equal(await node('old').count(), 1);
    assert.match(await page.locator('.ProseMirror').innerText(), /保留未发送草稿/);
    const snapshot = await page.evaluate(() => window.snapshot());
    assert.deepEqual(snapshot.view, beforeView, 'deletion keeps the current camera');
    assert.equal(snapshot.edges.length, 3, 'generation history remains');
    assert.equal(snapshot.nodes.filter(n => n.assetId && n.assetId !== 'existing').length, 7, 'asset identities remain');
    await page.evaluate(() => { window.emitAssetsChanged(); window.save(); }); await page.reload(); await node('old').waitFor();
    assert.equal(await node('first').count(), 0); assert.equal(await node('next').count(), 0); assert.equal(await node('copy-a').count(), 0);
    await page.evaluate(() => sessionStorage.clear());
  }
  assert.deepEqual(errors, []);
  console.log('PASS original recycling and missing cleanup: actual menu/confirmation, failure/retry, remaining gallery outputs, last-output card, duplicate instance, history/draft/camera, repeated refresh and reload');
} catch (error) { console.error(error); throw error; } finally { await browser.close(); await server.close(); }
