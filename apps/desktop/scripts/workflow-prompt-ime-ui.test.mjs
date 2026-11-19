import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/workflow-ime/vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, server: { host: '127.0.0.1', port: 17864, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/canvas-reference/preview.html`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    await c.load();
    await c.edit(['agent', 'generation', 'planner', 'instruction'].map((kind, index) => ({
      ...newWorkflowNode(kind, 20 + index * 410, 90, 'codex'), id: kind, prompt: '镜头推进',
    })));
    const { api } = await import('/src/lib/api.ts');
    const save = api.canvasWorkflowSave;
    api.canvasWorkflowSave = async (...args) => {
      await new Promise(done => setTimeout(done, 65));
      return save(...args);
    };
    window.editPromptSuffix = id => c.edit(c.document.nodes.map(node => node.id === id ? { ...node, prompt: node.prompt + '。' } : node));
  });
  const cdp = await page.context().newCDPSession(page);
  for (const id of ['agent', 'generation', 'planner', 'instruction']) {
    const field = page.locator(`[data-workflow-card="${id}"]`).locator('.ProseMirror, textarea');
    await field.focus();
    await field.press('Home');
    await field.press('ArrowRight');
    await field.press('ArrowRight');
    const read = () => field.evaluate(el => ({ text: el.value ?? el.textContent, caret: el.selectionStart ?? getSelection().focusOffset, focused: document.activeElement === el }));
    const check = async (text, caret) => assert.deepEqual(await read(), { text, caret, focused: true }, id);
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await check('镜头zhong推进', 7);
    await page.evaluate(id => window.editPromptSuffix(id), id);
    await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '中文' });
    await field.pressSequentially('!');
    await check('镜头中文!推进。', 5);
    await page.waitForFunction(id => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === id).prompt === '镜头中文!推进。', id);
    await check('镜头中文!推进。', 5);
    // A workflow change (e.g. attaching a reference after the text) can arrive with the editor still focused.
    await page.evaluate(id => window.editPromptSuffix(id), id);
    await check('镜头中文!推进。。', 5);
    await field.pressSequentially('?');
    await check('镜头中文!?推进。。', 6);
    console.log(id + ': Chinese composition, delayed save and external append preserve the middle caret.');
  }
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.every(node => node.prompt === '镜头中文!?推进。。'));
  await page.reload();
  for (const id of ['agent', 'generation', 'planner', 'instruction']) {
    const field = page.locator(`[data-workflow-card="${id}"]`).locator('.ProseMirror, textarea');
    assert.equal(await field.evaluate(el => el.value ?? el.textContent), '镜头中文!?推进。。', id + ' survives reload');
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
