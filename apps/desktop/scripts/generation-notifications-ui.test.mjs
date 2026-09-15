import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 1568, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.route('**/notification-test', route => route.fulfill({ contentType:'text/html', body:'<html><body></body></html>' }));
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 1 };
  });
  await page.goto('http://127.0.0.1:1568/notification-test');
  await page.evaluate(async () => {
    const [{ useStore }, { api }, notifications, { default: React }, { default: { createRoot } }, { ToastViewport }, { SettingsDialog }] = await Promise.all([
      import('/src/store.ts'), import('/src/lib/api.ts'), import('/src/lib/generationNotifications.ts'),
      import('/node_modules/.vite/deps/react.js'), import('/node_modules/.vite/deps/react-dom_client.js'),
      import('/src/components/ToastViewport.tsx'), import('/src/components/SettingsDialog.tsx'),
    ]);
    await import('/src/styles.css');
    window.store = useStore;
    window.notifications = notifications;
    window.notices = []; window.sounds = 0;
    window.addEventListener('bowerbird://notify', e => window.notices.push(e.detail.message));
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...args) { window.sounds++; return start.apply(this, args); };
    const defaults = { theme:'dark', generation_completion_popup:true, generation_completion_sound:true };
    window.saved = JSON.parse(localStorage.getItem('test-reminders') || 'null') || defaults;
    api.getSettings = async () => ({ ...window.saved });
    api.updateSettings = async settings => { window.saved = settings; localStorage.setItem('test-reminders', JSON.stringify(settings)); };
    api.cloudAgentList = async () => [];
    api.codexHealth = async () => null;
    api.dreaminaHealth = async () => null;
    useStore.setState({ settings:window.saved, genJobs:{}, genJobOrder:[], activeProjectId:'different-project', genPanelOpen:false });
    notifications.prepareGenerationSound();
    document.body.innerHTML = '<div id="notification-test"></div>';
    createRoot(document.getElementById('notification-test')).render(React.createElement(React.Fragment, null,
      React.createElement(ToastViewport), React.createElement(SettingsDialog, {onClose:()=>{}})));
    window.complete = (id, media='image') => {
      const job = { id, media, running:true, turns:[{id:1, prompt:'test', images:[]}], streaming:'', sessionId:null, projectId:'original-project' };
      useStore.setState(s => ({ genJobs:{...s.genJobs,[id]:job},genJobOrder:[...s.genJobOrder,id] }));
      useStore.getState().applyGenChunk({ kind:'done', job_id:id, images:['result.png'], provider:'codex', session_id:'s' });
    };
  });
  await page.getByRole('button', {name:'个性化与记忆',exact:true}).click();
  await page.getByText('生成完成提醒', {exact:true}).waitFor();
  assert.equal(await page.getByRole('switch', {name:'弹窗提示',exact:true}).getAttribute('aria-checked'), 'true');
  await page.evaluate(() => window.complete('image'));
  await page.getByRole('status').filter({hasText:'图片生成完成'}).waitFor();
  assert.equal(await page.evaluate(() => window.sounds), 2);
  await page.evaluate(() => window.store.getState().applyGenChunk({kind:'done',job_id:'image',images:['result.png'],provider:'codex'}));
  assert.equal(await page.evaluate(() => window.notices.length), 1);
  await page.waitForTimeout(1100);
  await page.evaluate(() => {
    window.store.setState(s=>({genJobs:{...s.genJobs,image:{...s.genJobs.image,running:true,turns:[...s.genJobs.image.turns,{id:2,prompt:'revise',images:[]}]}}}));
    window.store.getState().applyGenChunk({kind:'done',job_id:'image',images:['revise.png'],provider:'codex'});
  });
  assert.equal(await page.evaluate(() => window.notices.length), 2);
  assert.equal(await page.evaluate(() => window.sounds), 4);
  await page.getByRole('switch', {name:'提示音',exact:true}).click();
  await page.evaluate(() => window.complete('video','video'));
  await page.getByRole('status').filter({hasText:'视频生成完成'}).waitFor();
  assert.equal(await page.evaluate(() => window.sounds), 4);
  await page.getByRole('switch', {name:'弹窗提示',exact:true}).click();
  await page.evaluate(() => window.complete('silent'));
  assert.equal(await page.evaluate(() => window.notices.length), 3);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('test-reminders')).generation_completion_popup), false);
  await page.evaluate(async () => {
    window.store.setState({settings:null});
    window.complete('early-recovery');
    await new Promise(resolve=>setTimeout(resolve,30));
    window.store.setState({settings:window.saved});
  });
  assert.equal(await page.evaluate(() => window.notices.length), 3);
  await page.getByRole('switch', {name:'提示音',exact:true}).click();
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.complete('sound-only'));
  assert.equal(await page.evaluate(() => window.notices.length), 3);
  assert.equal(await page.evaluate(() => window.sounds), 6);
  await page.evaluate(() => {
    window.store.setState(s => ({genJobs:{...s.genJobs,failed:{id:'failed',running:true,turns:[{id:1,images:[]}]}}}));
    window.store.getState().applyGenChunk({kind:'error',job_id:'failed',message:'cancelled'});
    window.store.setState(s => ({genJobs:{...s.genJobs,empty:{id:'empty',running:true,turns:[{id:1,images:[]}]}}}));
    window.store.getState().applyGenChunk({kind:'done',job_id:'empty',images:[],provider:'codex'});
  });
  // Failed, cancelled and empty-result events do not produce success reminders.
  assert.equal(await page.evaluate(() => window.notices.length), 3);
  await page.getByRole('switch', {name:'弹窗提示',exact:true}).click();
  await page.evaluate(async () => {
    await window.notifications.notifyGenerationComplete('agent:run:final','Agent 生成完成，2 张产物已加入素材库',window.saved);
    await window.notifications.notifyGenerationComplete('agent:run:final','Agent 生成完成，2 张产物已加入素材库',window.saved);
  });
  await page.getByRole('status').filter({hasText:'Agent 生成完成'}).waitFor();
  assert.equal(await page.evaluate(() => window.notices.length), 4);
  await page.waitForTimeout(250);
  await page.screenshot({path:'.tmp/generation-notifications.png'});
  assert.deepEqual(errors, []);
  console.log('PASS: settings, image/video, continuation, duplicate events, background project, silent recovery, sound-only, Agent deduplication');
} finally {
  await browser.close();
  await server.close();
}
