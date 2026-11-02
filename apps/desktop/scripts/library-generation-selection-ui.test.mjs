import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 17958, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/library-composer/preview.html`);
  const editor = page.locator('.ProseMirror');
  await editor.fill('参考这些素材');
  const cards = page.locator('.library-home [data-asset-id]');
  await cards.first().waitFor();
  const id = await cards.first().getAttribute('data-asset-id');
  await cards.first().click();
  await editor.locator(`[data-asset-id="${id}"]`).waitFor();
  assert.equal(await page.getByRole('dialog', { name: /媒体预览/ }).count(), 0, 'creation click attaches without preview');
  assert.equal(await page.evaluate(() => window.started.length), 0, 'attachment never submits');
  const count = await editor.locator('[data-asset-id]').count();
  await cards.nth(1).click({ modifiers: ['Control'] });
  assert.equal(await editor.locator('[data-asset-id]').count(), count, 'multi-selection does not attach');
  await page.locator('.catalog-selection').getByRole('button', { name: /取消/ }).click();
  await page.getByRole('button', { name: '退出创作模式', exact: true }).click();
  await cards.first().click();
  await page.getByRole('dialog', { name: /媒体预览/ }).waitFor();

  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/connected-collections/preview.html`);
  const connected = page.locator('[data-connection-entry="root-0"] .folder-media-card');
  await connected.waitFor();
  await page.evaluate(async () => {
    const { useStore } = await import('/src/store.ts');
    window.referenceStore = useStore;
    useStore.setState({ activeProjectId: null, boardOpen: true, genEditing: null });
    window.picked = [];
    window.addEventListener('bowerbird://board-asset-picked', event => window.picked.push(event.detail));
  });
  await connected.click();
  await page.waitForFunction(() => window.picked.length === 1);
  assert.equal(await page.evaluate(() => window.picked.length), 1, 'home connected collection attaches in creation mode');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.evaluate(() => window.referenceStore.setState({ boardOpen: false }));
  await connected.click();
  await page.getByRole('dialog').waitFor();
  console.log('PASS: catalog and connected collection creation clicks, multi-selection, browsing, and no automatic submission');
} finally { await browser.close(); await server.close(); }
