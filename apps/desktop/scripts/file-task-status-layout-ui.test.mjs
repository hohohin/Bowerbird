import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/file-task-layout/vite', server: { host: '127.0.0.1', port: 17976, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/connected-collections/preview.html?file-tasks');
  await page.waitForFunction(() => !!window.store);
  const before = await page.locator('.library-home').boundingBox();
  await page.evaluate(() => {
    const backend = window.__TAURI_INTERNALS__;
    const previous = backend.invoke.bind(backend);
    window.layoutTasks = [{ id: 'layout-task', title: '回收原文件', phase: 'running', total: 10, completed: 2,
      succeeded: 2, skipped: 0, recycled: 2, cleaned: 0, failures: [], retryId: null }];
    backend.invoke = async (command, args) => command === 'list_file_tasks' ? window.layoutTasks : previous(command, args);
    window.dispatchEvent(new Event('file-tasks://changed'));
  });
  const trigger = page.getByRole('button', { name: '查看文件任务', exact: true });
  await trigger.waitFor();
  for (const theme of ['dark', 'light']) {
    for (const width of [1280, 720]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const box = await trigger.boundingBox();
      assert.ok(box && Math.abs(box.x + box.width - (width - 12)) < 2, theme + ' right anchor');
      assert.ok(Math.abs(box.y + box.height - 888) < 2, theme + ' bottom anchor');
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: '文件任务', exact: true });
      await dialog.getByText('已处理 2 / 10 项', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: '后台继续', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal((await page.locator('.library-home').boundingBox()).y, before.y, 'task must not shift workspace');
  await page.evaluate(() => {
    window.layoutTasks = [];
    window.dispatchEvent(new Event('file-tasks://changed'));
  });
  await trigger.waitFor({ state: 'detached' });
  console.log('PASS file task bottom-right position, dark/light, narrow window, panel access and workspace layout');
} finally {
  await browser.close();
  await server.close();
}
