import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: '.tmp/generation-session-errors-vite',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  window.copied = [];
  window.notices = [];
  window.clipboardWrites = 0;
  const checkClipboard = () => {
    if (window.clipboardFails || (window.requireEarlyClipboard && window.diagnosticsResolved)) throw new Error('denied');
    window.clipboardWrites++;
  };
  Object.defineProperty(navigator, 'clipboard', { value: {
    writeText: async text => { checkClipboard(); window.copied.push(text); },
    write: async items => {
      checkClipboard();
      window.copied.push(await (await items[0].getType('text/plain')).text());
    },
  } });
  window.addEventListener('bowerbird://notify', event => window.notices.push(event.detail));
});
const surface = page.locator('[aria-label="生成会话详情"]');
const menu = page.getByRole('menu', { name: '生成会话操作' });
const copy = menu.getByRole('menuitem', { name: '复制本次会话 ID', exact: true });
const open = () => surface.click({ button: 'right', position: { x: 3, y: 3 } });
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/canvas-reference/preview.html`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const job = { id: 'failed-before-provider-session', projectId: 'p', threadId: 't', provider: 'jimeng',
      sessionId: null, running: false, streaming: '', createdAt: 1, lastPrompt: '失败任务', lastRefs: [], refAssets: [],
      turns: [{ id: 1, prompt: '失败任务', images: [], error: 'synthetic startup failure' }] };
    window.store.setState({ genJobs: { [job.id]: job }, genJobOrder: [job.id], activeJobId: job.id,
      activeSessionKind: 'generation', genPanelOpen: true, boardOpen: false, genEditing: null });
  });
  await surface.getByText('本次生成未完成，请稍后重试。', { exact: true }).waitFor();
  assert.doesNotMatch(await surface.innerText(), /synthetic startup failure/);
  await open();
  await copy.click();
  assert.deepEqual(await page.evaluate(() => window.copied), ['failed-before-provider-session']);
  assert.equal(await page.locator('[data-project-inspector="generation"]').count(), 1);
  assert.equal(await page.evaluate(() => window.notices.at(-1).tone), 'success');
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    window.requireEarlyClipboard = true;
    api.generationDiagnostics = async jobId => {
      await new Promise(resolve => { window.resolveDiagnostics = resolve; });
      window.diagnosticsResolved = true;
      return { schemaVersion: 1, jobId,
        attempts: [{ phase: 'preflight', status: 'failed', error: 'synthetic startup failure' }], task: null };
    };
  });
  await open();
  await menu.getByRole('menuitem', { name: '复制本次会话诊断信息', exact: true }).click();
  assert.equal(await page.evaluate(() => window.clipboardWrites), 2, 'clipboard write must begin during the click, before diagnostic IPC completes');
  assert.equal(await page.evaluate(() => window.copied.length), 1, 'report content is not ready yet');
  await page.evaluate(() => {
    window.originalGenState = window.store.getState();
    const next = { ...window.originalGenState.genJobs[window.originalGenState.activeJobId], id: 'switched-while-reading' };
    window.store.setState({ genJobs: { [next.id]: next }, genJobOrder: [next.id], activeJobId: next.id });
    window.resolveDiagnostics();
  });
  await page.waitForFunction(() => window.copied.length === 2);
  const diagnostic = JSON.parse(await page.evaluate(() => window.copied.pop()));
  assert.equal(diagnostic.jobId, 'failed-before-provider-session');
  assert.equal(diagnostic.attempts[0].phase, 'preflight');
  assert.equal(diagnostic.memorySnapshot.id, 'failed-before-provider-session', 'pending copy keeps the requested session');
  assert.equal(diagnostic.memorySnapshot.turns[0].error, 'synthetic startup failure');
  await page.evaluate(() => { window.requireEarlyClipboard = false; window.store.setState(window.originalGenState); });

  // A failed report lookup or clipboard denial must not announce success or copy partial data.
  for (const [clipboardFails, lookupFails] of [[false, true], [true, false], [true, true]]) {
    await page.evaluate(async ({ clipboardFails, lookupFails }) => {
      const { api } = await import('/src/lib/api.ts');
      window.notices = [];
      window.clipboardFails = clipboardFails;
      api.generationDiagnostics = async jobId => {
        if (lookupFails) { await new Promise(resolve => setTimeout(resolve, 30)); throw new Error('synthetic database failure'); }
        return { schemaVersion: 1, jobId, attempts: [], task: null };
      };
    }, { clipboardFails, lookupFails });
    await open();
    await menu.getByRole('menuitem', { name: '复制本次会话诊断信息', exact: true }).click();
    await page.waitForFunction(() => window.notices.at(-1)?.tone === 'error');
    assert.equal(await page.evaluate(() => window.copied.length), 1);
    assert.equal(await page.evaluate(() => window.notices.some(n => n.tone === 'success')), false);
  }
  await page.evaluate(() => { window.clipboardFails = false; });

  // Persist raw diagnostics, but never expose paths, stack traces or CLI output by default.
  await page.evaluate(() => {
    const state = window.store.getState(), job = state.genJobs[state.activeJobId];
    const raw = '读取任务失败：TypeError: provider_token_missing at C:\\private\\worker.ts:42';
    window.rawGenerationFailure = raw;
    window.store.setState({ genJobs: { [job.id]: { ...job, turns: [{ ...job.turns[0], error: raw }] } } });
  });
  await surface.getByText('本次生成未完成，请稍后重试。', { exact: true }).waitFor();
  assert.doesNotMatch(await surface.innerText(), /TypeError|provider_token_missing|private/);
  assert.equal(await page.evaluate(() => window.store.getState().genJobs[window.store.getState().activeJobId].turns[0].error), await page.evaluate(() => window.rawGenerationFailure));
  await page.evaluate(() => {
    const state = window.store.getState(), job = state.genJobs[state.activeJobId];
    window.store.setState({ genJobs: { [job.id]: { ...job, running: true, streaming: window.rawGenerationFailure,
      turns: [{ ...job.turns[0], error: undefined }] } } });
  });
  await surface.getByText('生成仍在进行，请稍候。详细运行记录可从会话菜单复制。', { exact: true }).waitFor();
  assert.doesNotMatch(await surface.innerText(), /TypeError|provider_token_missing|private/);
  await page.evaluate(() => {
    const state = window.store.getState(), job = state.genJobs[state.activeJobId];
    window.store.setState({ genJobs: { [job.id]: { ...job, running: false, streaming: '',
      turns: [{ ...job.turns[0], error: window.rawGenerationFailure }] } } });
  });

  // Error text, prompts and existing action buttons keep their own native/menu behavior.
  for (const target of [surface.locator('pre'), surface.getByRole('button', { name: '展开全文' }), surface.locator('button').first()]) {
    await target.dispatchEvent('contextmenu', { bubbles: true, cancelable: true });
    assert.equal(await menu.count(), 0);
  }
  await surface.locator('pre').evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  await surface.dispatchEvent('contextmenu', { bubbles: true, cancelable: true });
  assert.equal(await menu.count(), 0, 'selected error text remains copyable');
  await page.evaluate(() => getSelection().removeAllRanges());

  await surface.focus();
  await page.keyboard.press('Shift+F10');
  await copy.waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent?.includes('复制本次会话 ID'));
  assert.equal(await copy.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('ArrowDown');
  assert.equal(await menu.getByRole('menuitem', { name: '复制本次会话诊断信息', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('ArrowUp');
  assert.equal(await copy.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  assert.equal(await surface.evaluate(el => el === document.activeElement), true);
  await open();
  await surface.click({ position: { x: 3, y: 200 } });
  await menu.waitFor({ state: 'detached' });

  await surface.evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, clientX: 1599, clientY: 999 })));
  const bounds = await menu.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1600 && bounds.y + bounds.height <= 1000, JSON.stringify(bounds));
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.clipboardFails = true; });
  await open(); await copy.click();
  await page.waitForFunction(() => window.notices.at(-1)?.tone === 'error');
  assert.equal(await page.evaluate(() => window.copied.length), 1);
  await page.evaluate(() => { window.clipboardFails = false; });

  // Changing task while the menu is open must discard its old ID, for video and image alike.
  for (const [id, media, running] of [['running-video', 'video', true], ['completed-image', 'image', false]]) {
    await open();
    await page.evaluate(({ id, media, running }) => {
      const state = window.store.getState(), previous = state.genJobs[state.activeJobId];
      const job = { ...previous, id, media, running, sessionId: 'different-provider-id',
        turns: [{ ...previous.turns[0], media, error: undefined }] };
      window.store.setState({ genJobs: { [id]: job }, genJobOrder: [id], activeJobId: id });
    }, { id, media, running });
    await menu.waitFor({ state: 'detached' });
    await open(); await copy.click();
    assert.equal(await page.evaluate(() => window.copied.at(-1)), id);
  }

  await surface.getByRole('button', { name: /^继续对话/ }).click();
  await surface.locator('.ProseMirror').dispatchEvent('contextmenu', { bubbles: true, cancelable: true });
  assert.equal(await menu.count(), 0, 'editor context menu stays native');

  // Reloaded canvas history carries the original job ID, never the synthetic canvas-snapshot ID.
  await page.evaluate(() => {
    const s = window.snapshot(), base = s.nodes[0];
    s.nodes = [{ ...base, id: 'history', kind: 'prompt', assetId: null, role: null, x: 200, y: 100,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: 'original-history-job', turn_key: 'one', text: '历史会话', status: 'done' }) },
    { ...base, id: 'output', assetId: 'a', role: 'output', x: 500, y: 100,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: 'a', width: 190, height: 150 },
        execution: { job_id: 'original-history-job', turn_key: 'one' } }) }];
    s.edges = [{ id: 'produced', projectId: 'p', threadId: 't', fromNodeId: 'history', toNodeId: 'output', kind: 'produced', ordinal: 0, createdAt: 1 }];
    s.view = { ...s.view, panX: 50, panY: 60, zoom: 1 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(s));
  });
  await page.reload();
  await page.evaluate(() => window.store.setState({ boardOpen: false }));
  await page.locator('[data-conversation-image="a"]').click();
  await open(); await copy.click();
  assert.deepEqual(await page.evaluate(() => window.copied), ['original-history-job']);
  await surface.locator('img').first().dispatchEvent('contextmenu', { bubbles: true, cancelable: true });
  assert.equal(await menu.count(), 0);
  await page.evaluate(() => {
    const s = JSON.parse(sessionStorage.getItem('reference-fixture'));
    const prompt = s.nodes.find(n => n.id === 'history'), payload = JSON.parse(prompt.payloadJson);
    delete payload.job_id; prompt.payloadJson = JSON.stringify(payload);
    sessionStorage.setItem('reference-fixture', JSON.stringify(s));
  });
  await page.reload();
  await page.evaluate(() => window.store.setState({ boardOpen: false }));
  await page.locator('[data-canvas-node-id="history"]').click();
  await open();
  for (const item of await menu.getByRole('menuitem').all()) assert.equal(await item.isDisabled(), true);
  assert.match(await menu.innerText(), /未记录任务 ID/);
  assert.deepEqual(await page.evaluate(() => window.copied), []);
  assert.deepEqual(errors, []);
  console.log('PASS: failed/running/image/video IDs, task switch, history, missing ID, clipboard errors, native menus, keyboard and bounds');
} finally {
  await browser.close();
  await server.close();
}
