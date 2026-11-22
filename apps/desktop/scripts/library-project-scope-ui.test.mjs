import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/library-project-scope';
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(7000);
page.setDefaultNavigationTimeout(60000);
const errors = [];
await page.addInitScript(() => { window.distinctProjects = true; });
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const nav = () => page.getByRole('tablist', { name: '素材库来源', exact: true });
const tab = name => nav().getByRole('tab', { name, exact: true });
const picker = () => page.getByRole('region', { name: '选择素材库项目', exact: true });
const chooseProject = name => page.getByRole('button', { name: `查看项目素材 ${name}`, exact: true }).click();
async function filter(kind, id) {
  await page.waitForFunction(({ kind, id }) => {
    const root = [...document.querySelectorAll('.categorized-library')].find(element => element.getAttribute('data-file-import-project-id') === (id ?? ''));
    const section = root?.querySelector(`[data-catalog-section="${kind === 'tags' ? 'first' : 'all'}"]`);
    return section && root.querySelector(`[data-asset-id^="${id ?? 'global'}:"]`)
      && window.requests.some(r => r.command === 'catalog_overview' && r.args.filter.kind === kind && r.args.filter.projectId === id);
  }, { kind, id });
}
async function overlay() {
  const boxes = await page.locator('.categorized-library').evaluate(element => {
    const root = element.getBoundingClientRect(), body = element.querySelector('.catalog-body').getBoundingClientRect();
    return { root: root.y, body: body.y };
  });
  assert.equal(boxes.root, boxes.body, 'picker does not reserve space for navigation');
}
try {
  await mkdir(output, { recursive: true });
  const fixture = `${server.resolvedUrls.local[0]}scripts/fixtures/catalog-paging/preview.html?navigation`;
  await page.goto(`${fixture}&home`);
  await nav().locator('[data-tab-value="project"]').click(); await picker().waitFor();
  assert.equal(await page.getByRole('slider', { name: '项目卡片大小' }).inputValue(), '0');
  assert.equal(await page.locator('.project-manager-create-card').count(), 0);
  await page.getByText('选择要查看素材库的项目', { exact: true }).waitFor();
  for (const width of [1000, 600, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await overlay();
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const button = page.getByRole('button', { name: '查看项目素材 项目A', exact: true });
      const box = await button.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, 'project cards stay within the pane');
      assert.ok(box.width <= 197, 'minimum project thumbnail does not stretch into a large card');
      await page.screenshot({ path: `${output}/picker-${width}-${theme}.png` });
    }
  }
  await chooseProject('项目A'); await filter('all', 'p');
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), null);
  assert.equal(await page.evaluate(() => window.store.getState().projectsThumbnailWidth), 200, 'picker size does not change the project page');
  const project = nav().locator('[data-tab-value="project"]');
  assert.equal(await project.getAttribute('aria-label'), '项目 · 项目A');
  await project.press('ArrowDown');
  const menu = page.getByRole('menu', { name: '选择浏览项目' });
  await menu.getByRole('menuitemradio', { name: '项目A', checked: true }).waitFor();
  // The menu stays open beyond the removed 3-second scope timeout.
  await page.waitForTimeout(3200);
  await menu.getByRole('menuitemradio', { name: '项目B' }).click();
  await filter('all', 'q');
  await project.press('ArrowDown');
  await menu.waitFor();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  assert.equal(await project.evaluate(button => button === document.activeElement), true);
  await page.reload(); await filter('all', 'q');
  await page.getByRole('tab', { name: '标签', exact: true }).click(); await filter('tags', 'q');
  await tab('全部素材').click(); await filter('tags', null);
  await project.click(); await filter('tags', 'q');
  await page.evaluate(() => window.store.setState({ projects: window.store.getState().projects.filter(p => p.id !== 'q') }));
  await picker().waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), null);
  await page.goto(fixture);
  await filter('all', 'p');
  await project.press('ArrowDown');
  await menu.getByRole('menuitemradio', { name: '项目B' }).click();
  await filter('all', 'q');
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), 'p');
  const member = page.locator('[data-asset-id^="q:"]').first();
  const memberId = await member.getAttribute('data-asset-id');
  await member.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除', exact: true }).hover();
  await page.getByRole('menuitem', { name: '移出当前项目', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.requests.findLast(r => r.command === 'remove_assets_from_project')?.args),
    { projectId: 'q', assetIds: [memberId] });
  assert.equal(await page.evaluate(() => window.requests.some(r => r.command === 'set_active_project')), false);
  assert.deepEqual(errors, []);
  console.log('PASS project picker, remembered project, direct menu, Escape focus, lens continuity and deletion');
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally { await browser.close(); await server.close(); }
