import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ server: { host: '127.0.0.1', port: 17943, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(8000);
const errors = [], remote = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => {
  if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
  remote.push(route.request().url()); return route.abort();
});
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/library-composer/preview.html`);
  const editor = page.locator('.ProseMirror');
  await editor.fill('绘制一张山野品牌海报');
  assert.equal(await page.evaluate(() => window.prepared.length), 0, 'typing never creates a default project');
  await page.locator('.composer-send button').click();
  await page.waitForFunction(() => window.started.length === 1);
  assert.deepEqual(await page.evaluate(() => window.prepared), ['quick'], 'send lazily prepares default project');
  assert.equal(await page.evaluate(() => window.started[0][9].projectId), 'quick', 'generation belongs to resolved default project');
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), null, 'sending stays on library');
  await editor.fill('第二次独立创作');
  await page.locator('.composer-send button').click();
  await page.waitForFunction(() => window.started.length === 2);
  assert.equal(await page.evaluate(() => window.store.getState().projects.filter(project => project.id === 'quick').length), 1, 'default project is reused');
  assert.notEqual(await page.evaluate(() => window.started[0][9].threadId), await page.evaluate(() => window.started[1][9].threadId), 'independent sends create independent threads');

  async function selectProject(name) {
    await page.getByRole('combobox', { name: '选择项目', exact: true }).click();
    await page.getByRole('option', { name, exact: true }).click();
  }
  await selectProject('山野护肤 · 品牌视觉');
  await editor.fill('选择项目后提交');
  await page.evaluate(() => { window.holdPrepare = true; });
  await page.locator('.composer-send button').click();
  await page.waitForFunction(() => !!window.releasePrepare);
  await selectProject('秋日系列 · 电商海报');
  await page.evaluate(() => { window.holdPrepare = false; window.releasePrepare(); window.releasePrepare = null; });
  await page.waitForFunction(() => window.started.length === 3);
  assert.equal(await page.evaluate(() => window.started[2][9].projectId), 'home-project-0', 'in-flight send retains selected destination');
  assert.equal(await page.evaluate(() => window.threads[2].projectId), 'home-project-0', 'thread and generation share the frozen destination');
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), null);

  await editor.fill('离开首页时取消尚未提交的请求');
  await page.evaluate(() => { window.holdPrepare = true; });
  await page.locator('.composer-send button').click();
  await page.waitForFunction(() => !!window.releasePrepare);
  await page.evaluate(() => { window.store.setState({ activeProjectId: 'home-project-3', projectRouteRevision: 10 }); window.holdPrepare = false; window.releasePrepare(); window.releasePrepare = null; });
  await page.waitForFunction(() => !document.querySelector('.composer-send button').disabled);
  assert.equal(await page.evaluate(() => window.started.length), 3, 'leaving route before prepare finishes does not submit');
  assert.equal(await page.evaluate(() => window.threads.length), 3, 'aborted preparation does not create a dangling thread');
  assert.ok((await editor.innerText()).includes('离开首页'), 'cancelled send keeps the draft');
  await page.evaluate(() => window.store.setState({ activeProjectId: null, projectRouteRevision: 11 }));
  await editor.fill('检查已删除项目');
  await page.evaluate(() => window.store.setState(state => ({ projects: state.projects.filter(project => project.id !== 'home-project-1') })));
  await page.locator('.composer-send button').click();
  await page.getByText('项目已不可用，请重新选择', { exact: true }).last().waitFor();
  assert.equal(await page.evaluate(() => window.started.length), 3, 'missing explicit project never falls back to default');

  await selectProject('选择项目');
  await editor.fill('恢复资料目录后生成');
  await page.evaluate(() => { window.requireRoot = true; });
  await page.locator('.composer-send button').click();
  await page.waitForFunction(() => window.started.length === 4);
  assert.equal(await page.evaluate(() => window.workspacePrepared), 1, 'unwritable root uses existing recovery flow');
  assert.equal(await page.evaluate(() => window.started[3][9].projectId), 'quick', 'root recovery retains frozen destination');

  await selectProject('山野护肤 · 品牌视觉');
  await editor.fill('普通项目创作');
  await page.locator('.composer-send button').click();
  await page.waitForFunction(() => window.started.length === 5);
  await selectProject('选择项目');
  await editor.click();
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.getByRole('button', { name: '打开对话记录', exact: true }).click();
  await page.waitForFunction(() => window.historyProjects.length > 0);
  assert.equal(await page.evaluate(() => window.historyProjects.at(-1)), 'quick', 'clearing explicit target returns history to default');
  await page.getByRole('button', { name: '关闭对话历史', exact: true }).click();

  await editor.fill('发送草稿 A');
  await page.evaluate(() => { window.holdPrepare = true; });
  await page.locator('.composer-send button').click();
  await page.waitForFunction(() => !!window.releasePrepare);
  await editor.fill('等待准备时继续写的草稿 B');
  await page.evaluate(() => { window.holdPrepare = false; window.releasePrepare(); window.releasePrepare = null; });
  await page.waitForFunction(() => window.chats.length === 1 && !document.querySelector('.composer-send button').disabled);
  assert.equal(await page.evaluate(() => window.chats[0].text), '发送草稿 A', 'chat request uses click-time prompt');
  assert.ok((await editor.innerText()).includes('草稿 B'), 'late preparation does not clear newer draft');

  await editor.fill('等待回复的草稿 A');
  await page.evaluate(() => { window.holdChat = true; });
  await page.locator('.composer-send button').click();
  await page.waitForFunction(() => !!window.releaseChat);
  await editor.fill('卸载前草稿 B');
  await page.evaluate(() => window.remountComposer());
  await editor.fill('重新打开后的草稿 C');
  await page.waitForFunction(() => localStorage.getItem('bowerbird.libraryComposer.draft.v1').includes('草稿 C'));
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true);
  await page.evaluate(() => { window.holdChat = false; window.releaseChat(); window.releaseChat = null; });
  await page.waitForTimeout(100);
  assert.ok((await editor.innerText()).includes('草稿 C'), 'old instance acknowledgement leaves remounted editor alone');
  assert.ok(await page.evaluate(() => localStorage.getItem('bowerbird.libraryComposer.draft.v1').includes('草稿 C')), 'old acknowledgement does not overwrite persisted new draft');
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true, 'old acknowledgement leaves new composer creation mode active');
  await mkdir('.tmp/library-generation', { recursive: true });
  await page.screenshot({ path: '.tmp/library-generation/composer-dark.png' });
  await page.getByRole('button', { name: '切换外观' }).click();
  await page.screenshot({ path: '.tmp/library-generation/composer-light.png' });
  assert.deepEqual(errors, [], 'no unhandled UI errors');
  assert.deepEqual(remote, [], 'fixture never accesses external services');
  console.log('PASS: lazy default, independent threads, frozen target, route barrier, deleted target, root recovery, history target and asynchronous chat drafts');
} finally { await browser.close(); await server.close(); }
