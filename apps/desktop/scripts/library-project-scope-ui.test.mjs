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
const errors = [];
await page.addInitScript(() => { window.distinctProjects = true; });
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const nav = () => page.getByRole('tablist', { name: '素材视图切换条', exact: true });
const scope = () => page.getByRole('tablist', { name: '标签素材范围', exact: true });
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
  await tab('项目素材').click(); await picker().waitFor();
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
  await tab('全部素材').click(); await tab('项目素材').click(); await filter('all', 'p');
  assert.equal(await picker().count(), 0, 'returning to project tab restores A');
  assert.equal(await page.getByRole('tablist', { name: '当前项目', exact: true }).getByRole('tab').innerText(), '项目A');
  await page.screenshot({ path: `${output}/current-project.png` });
  await tab('项目素材').click(); await page.getByRole('tablist', { name: '当前项目', exact: true }).getByRole('tab').click(); await chooseProject('项目B'); await filter('all', 'q');
  await page.reload(); await tab('项目素材').click(); await filter('all', 'q');
  assert.equal(await picker().count(), 0, 'home selection survives reload');
  await tab('标签分类').click(); await filter('tags', 'q');
  await scope().getByRole('tab', { name: '项目素材' }).click(); await picker().waitFor();
  await chooseProject('项目A'); await filter('tags', 'p');
  assert.equal(await tab('标签分类').getAttribute('aria-selected'), 'true');
  await tab('全部素材').click(); await tab('项目素材').click(); await filter('all', 'p');
  await tab('标签分类').click();
  const tagBox = await tab('标签分类').boundingBox(), menuBox = await page.locator('.library-tag-scope').boundingBox();
  assert.ok(Math.abs(tagBox.x + tagBox.width - menuBox.x - menuBox.width) <= 4, 'scope joins the right edge of its parent tab');
  assert.ok(Math.abs(tagBox.y + tagBox.height - menuBox.y) <= 4, 'scope touches its parent tab');
  assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= 320);
  await page.screenshot({ path: `${output}/joined-tags.png` });
  await page.clock.install();
  await tab('标签分类').click();
  await page.clock.fastForward(2000);
  await scope().getByRole('tab', { name: '全部素材' }).hover();
  await page.clock.fastForward(2000);
  assert.equal(await tab('标签分类').getAttribute('aria-expanded'), 'true', 'activity restarts idle timer');
  await page.clock.fastForward(1100);
  assert.equal(await tab('标签分类').getAttribute('aria-expanded'), 'false');
  await tab('标签分类').click(); await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('.library-tag-scope')), true);
  await page.keyboard.press('Escape');
  assert.equal(await tab('标签分类').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '标签分类');
  await tab('标签分类').click();
  await scope().getByRole('tab', { name: '全部素材', exact: true }).click(); await filter('tags', null);
  await scope().getByRole('tab', { name: '项目素材', exact: true }).click(); await filter('tags', 'p');
  await page.evaluate(() => window.store.setState({ projects: window.store.getState().projects.filter(p => p.id !== 'p') }));
  await picker().waitFor();
  await chooseProject('项目B'); await filter('tags', 'q');
  await page.goto(`${fixture}&home`); await tab('项目素材').click();
  await tab('项目素材').click(); await page.getByRole('tablist', { name: '当前项目', exact: true }).getByRole('tab').click(); await chooseProject('项目A'); await filter('all', 'p');

  await page.goto(fixture); // New project context defaults to itself, independently from home.
  await tab('项目素材').click(); await filter('all', 'p');
  await tab('项目素材').click(); await page.getByRole('tablist', { name: '当前项目', exact: true }).getByRole('tab').click(); await chooseProject('项目B'); await filter('all', 'q');
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), 'p');
  assert.equal(await page.locator('.categorized-library').getAttribute('data-file-import-project-id'), 'q');
  await tab('标签分类').click(); await filter('tags', 'q');
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.command === 'catalog_overview').at(-1).args.contextProject), 'q');
  assert.equal(await page.evaluate(() => window.requests.some(r => r.command === 'set_active_project')), false);
  await page.reload(); await tab('项目素材').click(); await filter('all', 'q');
  await page.goto(`${fixture}&home`); await tab('项目素材').click(); await filter('all', 'p');
  assert.deepEqual(errors, []);
  console.log('PASS project picker, minimum size, remembered scope, deletion, context isolation, joined dropdown, idle and keyboard');
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  console.error(errors); throw error;
} finally { await browser.close(); await server.close(); }
