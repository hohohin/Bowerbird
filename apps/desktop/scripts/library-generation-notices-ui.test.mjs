import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/library-generation-notices-vite', optimizeDeps: { entries: [], include: ['react', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 1588, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.setDefaultTimeout(3000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.route('**/library-notice-test', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' }));
  await page.goto(`${server.resolvedUrls.local[0]}library-notice-test`);
  await page.evaluate(async () => {
    const [{ default: React }, { default: { createRoot } }, { ToastViewport }, notices, { useStore }, { NotificationBell }] = await Promise.all([
      import('/.tmp/library-generation-notices-vite/deps/react.js'), import('/.tmp/library-generation-notices-vite/deps/react-dom_client.js'),
      import('/src/components/ToastViewport.tsx'), import('/src/lib/generationNotifications.ts'), import('/src/store.ts'), import('/src/components/NotificationBell.tsx'),
    ]);
    await import('/src/styles.css');
    await import('/src/components/IndustrialTheme.css');
    document.documentElement.dataset.theme = 'dark';
    window.notices = notices; window.store = useStore; window.opened = [];
    window.preferences = { generation_completion_popup: true, generation_completion_sound: false };
    window.root = createRoot(document.getElementById('root'));
    window.root.render(React.createElement(React.Fragment, null, React.createElement(ToastViewport), React.createElement(NotificationBell)));
  });
  await page.waitForTimeout(80);
  await page.evaluate(() => window.notices.notifyGenerationComplete('new:1', '图片生成完成', window.preferences, {
    projectName: '快速生成', onOpen: () => window.opened.push('project-a/thread-a/node-a'),
  }));
  await page.getByRole('button', { name: '快速生成 · 图片生成完成，查看画板' }).click();
  assert.deepEqual(await page.evaluate(() => window.opened), ['project-a/thread-a/node-a']);
  assert.equal(await page.getByRole('status').count(), 0, 'opening the task dismisses its notice');
  await page.evaluate(() => window.notices.notifyGenerationComplete('new:1', '图片生成完成', window.preferences));
  assert.equal(await page.getByRole('status').count(), 0, 'duplicate completion does not alert again');
  await page.evaluate(() => window.notices.notifyGenerationComplete('new:2', '视频生成完成', window.preferences, {
    projectName: '品牌', onOpen: () => window.opened.push('project-b/thread-b/node-b'),
  }));
  await page.getByRole('button', { name: '品牌 · 视频生成完成，查看画板' }).focus();
  await page.waitForTimeout(4500);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.opened), ['project-a/thread-a/node-a', 'project-b/thread-b/node-b'], 'keyboard focused action remains until used');
  await page.evaluate(() => window.notices.notifyGenerationComplete('off', '图片生成完成', { ...window.preferences, generation_completion_popup: false }, {
    projectName: '静默项目', onOpen: () => window.opened.push('wrong'),
  }));
  assert.equal(await page.getByRole('status').count(), 0, 'popup preference is respected');
  await page.evaluate(() => {
    const job = (id, overrides = {}) => ({ id, projectId: 'p', threadId: `thread-${id}`, lastPrompt: '秋日海报', createdAt: 100,
      turns: [{ id: 1, turnKey: `turn-${id}`, prompt: '秋日海报', images: ['out.png'] }], running: false, ...overrides });
    window.store.setState({ projects: [{ id: 'p', name: '快速生成' }, { id: 'q', name: '品牌' }], projectUnreadThreads: {p:['thread-done']},
      genJobs: {done: job('done'), running: job('running', {running:true,createdAt:200}), failed: job('failed', {createdAt:300,turns:[{turnKey:'failed',prompt:'森林',images:[],error:'SECRET/internal/path'}]})}, cloudAgentRuns:{} });
  });
  const bell = page.getByRole('button', { name: /^通知/ });
  await bell.waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'task history stays collapsed by default');
  assert.match(await bell.getAttribute('aria-label'), /有未读消息/);
  await bell.click();
  const history = page.getByRole('dialog', { name: '通知历史' });
  assert.equal(await history.getByText('生成中', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('listitem').count(), 3);
  assert.equal(await page.getByText('SECRET/internal/path').count(), 0, 'recent status never exposes diagnostics');
  await page.getByRole('button', {name:'快速生成 · 秋日海报 · 已完成，查看画板'}).click();
  assert.deepEqual(await page.evaluate(() => window.store.getState().creativeNavigation), {projectId:'p',threadId:'thread-done',nodeId:'gen-prompt:done:turn-done:0'});
  assert.equal(await history.count(), 0, 'task navigation closes the history panel');
  await page.evaluate(() => window.store.setState({ activeProjectId: 'q' }));
  await bell.click();
  await page.getByRole('button', {name:'快速生成 · 森林 · 需处理，查看画板'}).click();
  assert.equal(await page.evaluate(() => window.store.getState().creativeNavigation.projectId), 'p', 'recent row keeps original project after route changes');
  await bell.click();
  await page.evaluate(() => window.store.setState(state => ({ genJobs: {...state.genJobs,running:{...state.genJobs.running,running:false}} })));
  assert.equal(await history.getByText('生成中', { exact: true }).count(), 0);
  await page.waitForTimeout(4500);
  assert.equal(await page.getByRole('listitem').count(), 3, 'completed rows survive popup lifetime');
  assert.deepEqual(errors, []);
  await mkdir('.tmp/library-generation', { recursive: true });
  await page.screenshot({path:'.tmp/library-generation/activity-dark.png'});
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await page.screenshot({path:'.tmp/library-generation/activity-light.png'});
  console.log('PASS clickable completion and recent tasks: frozen task callback, keyboard, duplicate, preference, status, persistent rows and exact navigation');
} finally { await browser.close(); await server.close(); }
