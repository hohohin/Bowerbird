import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/original-missing';
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = [], errors = [], remote = [];
async function scenario(name, run) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue(); remote.push(route.request().url()); return route.abort(); });
  try {
    await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/original-deletion/preview.html`);
    await page.waitForFunction(() => window.ready);
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await run(page); reports.push({ name, passed: true });
  } catch (error) { reports.push({ name, passed: false, error: error.stack }); }
  finally { await page.close(); }
}
async function open(page, missingIds, kind = 'single') {
  await page.evaluate(({ missingIds, kind }) => { window.missingIds = missingIds; window.openMenu(kind); }, { missingIds, kind });
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page.getByRole('menuitem', { name: '删除原文件', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('[data-delete-asset-id="a1"]').waitFor();
  return dialog;
}
const notices = page => page.evaluate(() => window.notices.filter(item => item.tone === 'success').map(item => item.message));
try {
  await mkdir(output, { recursive: true });
  await scenario('missing originals use a cleanup confirmation and cancellation never mutates', async page => {
    const dialog = await open(page, ['a1']);
    assert.equal(await dialog.getByRole('heading').textContent(), '清理失效条目');
    assert.equal(await dialog.getByRole('button', { name: '清理失效条目', exact: true }).isEnabled(), true);
    await dialog.getByText('原件已不在登记位置，将清理失效条目和画板中的对应素材卡片。标签、分析及生成历史保留。', { exact: true }).waitFor();
    await dialog.locator('[data-delete-asset-id="a1"]').getByText('原件缺失 · 仅清理引用', { exact: true }).waitFor();
    assert.equal(await dialog.getByText(/放入系统回收站/).count(), 0);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${output}/missing-${theme}.png` });
    }
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.trashCalls), []);
  });
  await scenario('cleanup reports cleaned entries and passes the frozen missing target', async page => {
    const dialog = await open(page, ['a1']);
    await dialog.locator('button.is-danger').click();
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(await notices(page), ['已清理 1 个失效条目']);
    assert.deepEqual(await page.evaluate(() => window.trashCalls), [{ asset_id: 'a1', name: 'disk-a1.png', path: 'D:/素材/a1.png', fingerprint: 'version-a1', missing: true }]);
  });
  await scenario('missing originals without a cached thumbnail never request the missing file', async page => {
    await page.evaluate(() => { window.noThumbIds = ['a1']; });
    const dialog = await open(page, ['a1']);
    const item = dialog.locator('[data-delete-asset-id="a1"]');
    assert.equal(await item.locator('img').count(), 0);
    await item.getByLabel('原件缺失', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.convertedPaths.includes('D:/素材/a1.png')), false);
    assert.deepEqual(await page.evaluate(() => window.trashCalls), []);
  });
  await scenario('mixed confirmation distinguishes recycled originals from cleaned entries', async page => {
    const dialog = await open(page, ['a2'], 'multi');
    assert.equal(await dialog.getByRole('heading').textContent(), '确认删除');
    await dialog.getByText('现存原文件将放入系统回收站，失效条目和画板中的对应素材卡片一并清理。标签、分析及生成历史保留。', { exact: true }).waitFor();
    assert.equal(await dialog.locator('[data-delete-asset-id="a1"]').getByText(/原件缺失/).count(), 0);
    await dialog.locator('[data-delete-asset-id="a2"]').getByText('原件缺失 · 仅清理引用', { exact: true }).waitFor();
    await page.screenshot({ path: `${output}/mixed-dark.png` });
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(await notices(page), ['已将 1 个原文件放入回收站，已清理 1 个失效条目']);
  });
  await scenario('partial failure retries only remaining entries and reports total actual outcomes', async page => {
    const dialog = await open(page, ['a2'], 'multi');
    await page.evaluate(() => { window.failId = 'a2'; });
    await dialog.locator('button.is-danger').click();
    await dialog.getByRole('alert').filter({ hasText: '1 项失败' }).waitFor();
    assert.deepEqual(await dialog.locator('[data-delete-asset-id]').evaluateAll(items => items.map(item => item.dataset.deleteAssetId)), ['a2']);
    assert.equal(await dialog.getByRole('heading').textContent(), '清理失效条目');
    await page.evaluate(() => { window.failId = null; });
    await dialog.getByRole('button', { name: '重试失败项', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.trashCalls.map(item => item.asset_id)), ['a1', 'a2', 'a2']);
    assert.deepEqual(await notices(page), ['已将 1 个原文件放入回收站，已清理 1 个失效条目']);
  });
  await writeFile(`${output}/result.json`, JSON.stringify({ reports, errors, remote, boundary: 'Actual confirmation with controlled IPC; no real files or user library accessed.' }, null, 2));
  for (const report of reports) console.log(`${report.passed ? 'PASS' : 'FAIL'} ${report.name}${report.error ? `: ${report.error}` : ''}`);
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  assert.equal(reports.filter(report => !report.passed).length, 0);
} finally { await browser.close(); await server.close(); }
