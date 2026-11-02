import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/library-generation/navigation-vite', optimizeDeps: { entries: [], include: ['react', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 17944, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/notice-navigation', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' }));
  await page.addInitScript(() => { window.__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 1 }; });
  await page.goto(`${server.resolvedUrls.local[0]}notice-navigation`);
  await page.evaluate(async () => {
    const [{ useStore }, { default: React }, { default: { createRoot } }, { ToastViewport }, { generationTaskNavigation }] = await Promise.all([
      import('/src/store.ts'), import('/.tmp/library-generation/navigation-vite/deps/react.js'), import('/.tmp/library-generation/navigation-vite/deps/react-dom_client.js'),
      import('/src/components/ToastViewport.tsx'), import('/src/lib/projectActivity.ts'),
    ]);
    window.store = useStore;
    window.React = React;
    window.taskNavigation = generationTaskNavigation;
    createRoot(document.getElementById('root')).render(React.createElement(ToastViewport));
    useStore.setState({ projects: [{ id: 'quick', name: '快速生成' }], activeProjectId: null, projectRouteRevision: 3,
      settings: { generation_completion_popup: true, generation_completion_sound: false }, genJobs: {}, genJobOrder: [] });
  });
  await page.locator('.toast-viewport').waitFor({ state: 'attached' });
  await page.evaluate(() => {
    const job = { id: 'job', projectId: 'quick', threadId: 'thread', running: true, media: 'image', createdAt: 100,
      turns: [{ id: 1, turnKey: 'first', prompt: '海报', images: [] }], streaming: '', sessionId: null };
    window.expected = window.taskNavigation(job);
    window.store.setState({ genJobs: { job }, genJobOrder: ['job'] });
    window.store.getState().applyGenChunk({ kind: 'done', job_id: 'job', images: ['poster.png'], provider: 'codex' });
  });
  const notice = page.getByRole('button', { name: /快速生成.*查看画板/ });
  await notice.waitFor();
  await page.evaluate(() => window.store.setState(state => ({ activeProjectId: 'other', genJobs: {
    ...state.genJobs, job: { ...state.genJobs.job, running: true, turns: [...state.genJobs.job.turns, { id: 2, turnKey: 'second', prompt: '新版', images: [] }] },
  } })));
  await notice.click();
  assert.deepEqual(await page.evaluate(() => window.store.getState().creativeNavigation), await page.evaluate(() => window.expected), 'completion notice keeps its original task locator after later turns');
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), 'other', 'notification requests navigation through existing route coordinator');
  console.log('PASS: completion notification freezes original project/thread/turn and requests coordinated navigation');
} finally { await browser.close(); await server.close(); }
