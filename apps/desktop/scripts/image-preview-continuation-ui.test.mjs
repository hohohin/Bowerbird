import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/image-preview-continuation';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 17949, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const modal = page.locator('.creation-image-preview');
const reply = modal.getByRole('textbox', { name: '续轮对话', exact: true });
const send = modal.getByRole('button', { name: '发送续轮对话', exact: true });
const mainImage = modal.locator('.creation-image-preview-image img:not(.creation-image-preview-thumbnail)');
async function setup(historical = false) {
  await page.goto(`http://127.0.0.1:17949/scripts/fixtures/creation-image-review/preview.html${historical ? '?deferred' : ''}`);
  if (historical) {
    await page.waitForFunction(() => window.__reviewPending.length === 4);
    await page.evaluate(() => { window.__reviewHold.clear(); window.__reviewPending.forEach(item => item.resolve()); });
  }
  await reply.waitFor();
  await page.evaluate(async historical => {
    const { useStore } = await import('/src/store.ts');
    const { FREE_POLICY } = await import('/src/lib/entitlement.ts');
    window.testStore = useStore;
    const original = { ...useStore.getState().genJobs['review-job'], projectId: 'origin-project', threadId: 'origin-thread',
      conversationId: 'origin-conversation', lastRatio: '3:4',
      turns: useStore.getState().genJobs['review-job'].turns.map((turn, i) => ({ ...turn, id: -i - 1 })) };
    window.testOriginal = original;
    useStore.setState({ genJobs: historical ? {} : { [original.id]: original }, genJobOrder: historical ? [] : [original.id],
      activeJobId: 'other-job', activeProjectId: 'other-project', boardOpen: true, genPanelOpen: false, genEditing: null, activeGenProvider: 'jimeng',
      codexHealth: { ok: true }, cloudEntitlement: { policy: { ...FREE_POLICY, can_use_byo: true, max_parallel_jobs: 3 }, balances: { daily: 100, sub: 0, topup: 0 } } });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.testRequests = []; window.testStops = []; window.testPending = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'list_gen_jobs' || command === 'recent_gen_sessions') return [];
      if (command === 'list_analyses_by_asset') return [{ kind: 'generation_meta', payload: JSON.stringify({ job_id: 'history-job', session_id: original.sessionId,
        thread_id: original.threadId, conversation_id: original.conversationId }) }];
      if (command === 'generation_history') return { session_id: original.sessionId, provider: original.provider, ratio: original.lastRatio, references: [], dimension_assets: [],
        turns: original.turns.map(turn => ({ ...turn, turn_key: turn.turnKey, prompt_raw: turn.promptRaw, references: [], ref_assets: [] })) };
      if (command === 'project_canvas_for_asset') {
        if (window.testHoldLocation) await new Promise(resolve => window.testReleaseLocation = resolve);
        if (window.testLocationFailure) throw new Error('素材关联多个画板节点，请选择具体会话');
        return { projectId: original.projectId, threadId: original.threadId, nodeId: 'origin-output' };
      }
      if (command === 'begin_generation_diagnostic') return 'test-attempt';
      if (command === 'finish_generation_diagnostic') return;
      if (command === 'codex_create_image') { window.testRequests.push(args); return new Promise((resolve, reject) => window.testPending.push({ resolve, reject })); }
      if (command === 'cancel_codex_create') { window.testStops.push(args.jobId); return; }
      return invoke(command, args);
    };
  }, historical);
  await page.waitForTimeout(450);
}
async function requests() { return page.evaluate(() => window.testRequests); }
async function complete() {
  await page.evaluate(() => {
    const request = window.testRequests.at(-1), store = window.testStore;
    const job = store.getState().genJobs[request.jobId];
    store.setState({ genJobs: { ...store.getState().genJobs, [job.id]: { ...job, running: false,
      turns: job.turns.map((turn, index) => index === job.turns.length - 1 ? { ...turn, images: [`${window.testOriginal.turns[0].images[0]}?continued=1`] } : turn) } } });
    window.testPending.shift().resolve('done');
  });
  await page.waitForFunction(() => !document.querySelector('[aria-label="续轮对话"]').disabled);
}
try {
  await setup();
  const before = await mainImage.boundingBox();
  await reply.fill('把背景改为清晨，保留人物');
  await modal.getByRole('button', { name: '收起会话面板', exact: true }).click();
  await modal.getByRole('button', { name: '显示会话', exact: true }).click();
  assert.equal(await reply.inputValue(), '把背景改为清晨，保留人物', 'collapsing keeps the draft');
  await send.click();
  await page.waitForFunction(() => window.testRequests.length === 1);
  await page.evaluate(() => document.querySelector('[aria-label="继续当前会话"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal((await requests()).length, 1, 'double submission does not create a second turn');
  const first = (await requests())[0];
  assert.equal(first.jobId, 'review-job'); assert.equal(first.sessionId, 'review-session');
  assert.equal(first.projectId, 'origin-project'); assert.equal(first.threadId, 'origin-thread');
  assert.equal(first.conversationId, 'origin-conversation'); assert.equal(first.provider, 'codex'); assert.equal(first.ratio, '3:4');
  assert.equal(first.creativeRelation, 'continued'); assert.equal(first.prompt, '把背景改为清晨，保留人物');
  assert.deepEqual(await mainImage.boundingBox(), before, 'sending does not move the image');
  assert.deepEqual(await page.evaluate(() => { const state = window.testStore.getState(); return [state.activeJobId, state.activeProjectId, state.boardOpen, state.genPanelOpen, state.genEditing, state.activeGenProvider]; }),
    ['other-job', 'other-project', true, false, null, 'jimeng'], 'preview sends do not replace global editing or routing state');
  await modal.getByRole('button', { name: '停止当前会话生成', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.testStops), ['review-job'], 'stop targets this preview, not the active background job');
  await complete();
  assert.equal(await modal.locator('img[src*="continued=1"]').count(), 1, 'new output appears in the same conversation');
  await page.waitForFunction(() => {
    const image = document.querySelector('img[src*="continued=1"]');
    const scroller = image?.closest('.overflow-y-auto');
    return image?.naturalWidth > 0 && scroller && Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) < 2;
  });
  await page.screenshot({ path: `${output}/continued-dark.png` });
  await reply.fill('第二次修改'); await reply.press('Control+Enter');
  await page.waitForFunction(() => window.testRequests.length === 2);
  await page.evaluate(() => window.testPending.shift().reject(new Error('参考图片不存在，请重新添加')));
  await send.waitFor();
  assert.match(await modal.innerText(), /参考文件可能已被移动或删除/);
  await page.waitForFunction(() => {
    const scroller = document.querySelector('.creation-image-preview-history .overflow-y-auto');
    return scroller && Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) < 2;
  });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await page.screenshot({ path: `${output}/failed-light.png` });
  await reply.fill('不要丢失这份草稿');
  await page.evaluate(() => window.testStore.setState({ cloudEntitlement: { ...window.testStore.getState().cloudEntitlement, policy: { can_use_byo: false } } }));
  assert.equal(await send.isDisabled(), true, 'live entitlement changes still gate the send');
  assert.equal(await reply.inputValue(), '不要丢失这份草稿');

  await setup(true);
  await reply.fill('历史会话继续修改'); await send.click();
  await page.waitForFunction(() => window.testRequests.length === 1);
  const recovered = (await requests())[0];
  assert.equal(recovered.jobId, 'history-job'); assert.equal(recovered.sessionId, 'review-session');
  assert.equal(recovered.projectId, 'origin-project'); assert.equal(recovered.threadId, 'origin-thread');
  assert.equal(recovered.conversationId, 'origin-conversation');
  await complete();
  assert.match(await modal.innerText(), /历史会话继续修改/);
  assert.equal(await modal.locator('img[src*="continued=1"]').count(), 1);

  await setup(true);
  await page.evaluate(() => window.testLocationFailure = true);
  await reply.fill('归属不明确时保留草稿'); await send.click();
  await modal.getByRole('alert').waitFor();
  assert.deepEqual(await requests(), []); assert.equal(await reply.inputValue(), '归属不明确时保留草稿');

  await setup(true);
  await page.evaluate(() => window.testHoldLocation = true);
  await reply.fill('关闭后不应发送'); await send.click();
  await page.waitForFunction(() => !!window.testReleaseLocation);
  await modal.getByRole('button', { name: '关闭预览', exact: true }).click();
  await modal.waitFor({ state: 'detached' });
  await page.evaluate(() => window.testReleaseLocation());
  await page.waitForTimeout(300);
  assert.deepEqual(await requests(), [], 'late recovery after closing never submits');
  assert.deepEqual(errors, []);
  console.log('PASS live and historical continuation identity, live results/errors, isolated draft/routing, collapse preservation, explicit cancellation, entitlement, duplicate and late-send protection');
} finally { await browser.close(); await server.close(); }
