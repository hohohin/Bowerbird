import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1596, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:1596/scripts/fixtures/canvas-reference/preview.html");
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
  const dock = page.locator('.creation-dock');
  await page.waitForFunction(() => {
    const dock = document.querySelector('.creation-dock');
    const rect = dock.getBoundingClientRect();
    return dock.classList.contains('is-collapsed') && Math.abs((innerHeight - rect.top) / rect.height - 0.2) < 0.02;
  });
  await dock.click({ position: { x: 100, y: 5 } });
  const editor = dock.locator('.ProseMirror');
  await editor.fill('保留失焦草稿');
  await dock.getByTitle('选择画面比例', { exact: true }).click();
  await dock.getByRole('option', { name: '1:1', exact: true }).click();
  assert.equal(await dock.evaluate(el => el.classList.contains('is-collapsed')), false);
  await page.locator('[data-canvas-stage]').click({ position: { x: 80, y: 80 } });
  await page.waitForFunction(() => document.querySelector('.creation-dock.is-collapsed'));
  assert.equal(await editor.innerText(), '保留失焦草稿');
  await editor.focus();
  await page.waitForFunction(() => !document.querySelector('.creation-dock.is-collapsed'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.creation-dock.is-collapsed'));

  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    api.localAgentHealth = async () => true;
    window.sent = [];
    const job = { id: 'continue-job', projectId: 'p', threadId: 't', provider: 'jimeng', sessionId: 'session',
      conversationId: 'conversation', running: false, streaming: '', refAssets: [], lastRatio: '1:1', lastPrompt: '原始绘画',
      turns: [{ id: 1, prompt: '原始绘画', promptRaw: '原始绘画', images: [], provider: 'jimeng' }] };
    window.store.setState({ genJobs: { [job.id]: job }, genJobOrder: [job.id], activeJobId: job.id,
      activeSessionKind: 'generation', genPanelOpen: true, boardOpen: false, genEditing: null,
      activeGenProvider: 'codex', dreaminaHealth: { ok: true },
      cloudEntitlement: { plan: 'pro', policy: { can_use_byo: true }, balances: { daily: 100, sub: 0, topup: 0 } },
      settings: { agent_a_mode_enabled: true },
      sendGenRevise: async (...args) => { window.sent.push(args); },
    });
  });
  const inspector = page.locator('[data-project-inspector="generation"]');
  await inspector.getByRole('button', { name: /^继续对话/ }).click();
  const inline = inspector.locator('[data-generation-composer="inline"]');
  await inline.waitFor();
  assert.equal(await inspector.evaluate(el => el.classList.contains('is-editing')), false);
  assert.equal(await page.locator('[data-generation-composer="floating"]').count(), 0);
  assert.equal(await page.locator('.creation-dock').count(), 0);
  assert.equal(await inline.getByTitle('选择出图引擎', { exact: true }).count(), 0);
  await inline.getByRole('switch', { name: 'Agent A', exact: true }).waitFor();
  await inline.locator('.ProseMirror').fill('背景改成白天');
  await page.locator('[data-canvas-stage]').click({ position: { x: 80, y: 80 } });
  assert.equal(await inline.count(), 1, 'picking canvas references must not close the continuation editor');
  await inline.getByTitle('选择画面比例', { exact: true }).click();
  await inline.getByRole('option', { name: '16:9', exact: true }).click();
  await inline.getByRole('button', { name: '发送', exact: true }).click();
  const sent = await page.evaluate(() => window.sent);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'continue-job');
  assert.equal(sent[0][1], '背景改成白天');
  assert.equal(sent[0][2], 'jimeng');
  assert.equal(sent[0][3].ratio, '16:9');
  assert.equal(sent[0][3].creativeRelation, 'continued');
  await inspector.getByRole('button', { name: /^继续对话/ }).waitFor();
  await inspector.getByRole('button', { name: /^继续对话/ }).click();
  await inline.locator('.ProseMirror').fill('未发送的修改');
  await inspector.locator('.project-inspector-header button').click();
  await page.waitForFunction(() => !window.store.getState().genEditing && document.querySelector('.creation-dock'));
  assert.equal(await dock.locator('.ProseMirror').innerText(), '保留失焦草稿');

  // Historical edit stays inline, retains its source model and exact parent refs.
  await page.evaluate(() => {
    const state = window.store.getState();
    const job = state.genJobs['continue-job'];
    window.store.setState({ genPanelOpen: true, genJobs: { [job.id]: { ...job, turns: [
      { ...job.turns[0], images: [state.assets[0].store_path] },
      { id: 2, prompt: '历史修改', promptRaw: '历史修改', images: [], provider: 'jimeng',
        ratio: '4:3', refs: [state.assets[0].store_path], refAssets: [] },
    ] } } });
  });
  await inspector.locator('button[title^="编辑这一轮"]').click();
  await page.waitForFunction(() => document.querySelector('[data-generation-composer="inline"] .ProseMirror')?.textContent === '历史修改');
  await inline.locator('.ProseMirror').fill('历史修改的新版本');
  await inline.getByRole('button', { name: '发送', exact: true }).click();
  const history = await page.evaluate(() => ({ sent: window.sent[1], path: window.store.getState().assets[0].store_path }));
  assert.equal(history.sent[2], 'jimeng');
  assert.equal(history.sent[3].ratio, '4:3');
  assert.deepEqual(history.sent[3].exactReferences, [history.path]);
  assert.equal(history.sent[3].creativeRelation, 'branch');

  // Closing the now-visible header also invalidates pending Agent compilation.
  await inspector.getByRole('button', { name: /^继续对话/ }).click();
  await inline.locator('.ProseMirror').fill('等待整理的修改');
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    api.localAgentCompilePrompt = () => new Promise(resolve => { window.finishCompile = resolve; });
  });
  await inline.getByRole('switch', { name: 'Agent A', exact: true }).click();
  await inline.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => !!window.finishCompile);
  await inspector.locator('.project-inspector-header button').click();
  await page.evaluate(async () => {
    window.finishCompile({ prompt: '整理后的修改' });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(await page.evaluate(() => window.sent.length), 2);
  await page.evaluate(() => window.store.getState().setGenPanelOpen(true));

  await inspector.locator('button[title^="重新编辑："]').click();
  await page.locator('[data-generation-composer="floating"]').waitFor();
  assert.equal(await inspector.evaluate(el => el.classList.contains('is-editing')), true);
  assert.equal(await page.locator('[data-generation-composer="inline"]').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: 20% focus dock, internal controls, draft preservation, inline continuation, fixed model and ratio submission');
} finally {
  await browser.close();
  await server.close();
}
