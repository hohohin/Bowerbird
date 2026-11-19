import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, cacheDir: '.tmp/comfy-video-prompt/vite', server: { host: '127.0.0.1', port: 1682, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const failures = [];
const original = '镜头平稳推进，主体自然转动';

async function setup(delay) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:1682/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async ({ original, delay }) => {
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'tester' }, cloudEntitlement: { user_id: 'tester', tier: 'pro', offline_state: 'fresh', is_test_account: false, balances: { daily: 0, sub: 0, topup: 0 }, policy: { can_use_cloud: true, can_use_byo: true }, generation_services: [] } });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.promptTest = { delay: 0, pending: 0, generations: 0, authorizations: 0, writes: 0, events: [] };
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'comfy_video') { window.promptTest.generations++; throw new Error('Prompt editing must not generate'); }
      if (command === 'comfy_video_environment') return { phase: 'ready', message: '合成环境已就绪', endpoint: args.endpoint, directory: '', canInstall: false, installed: true, downloadBytes: 0, requiredBytes: 0, completedBytes: 0, totalBytes: 0 };
      if (command === 'canvas_workflow_authorize' || command === 'canvas_workflow_save') {
        window.promptTest.pending++;
        try {
          if (window.promptTest.delay) await new Promise(resolve => setTimeout(resolve, window.promptTest.delay));
          if (command === 'canvas_workflow_authorize') {
            window.promptTest.authorizations++;
            if (window.promptTest.denyAuthorize) throw new Error('模拟工作流权限已失效');
          }
          const result = await invoke(command, args);
          if (command === 'canvas_workflow_save') window.promptTest.writes++;
          return result;
        } finally { window.promptTest.pending--; }
      }
      return invoke(command, args);
    };
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller = canvasWorkflowController('p');
    await controller.load();
    await controller.edit([{ ...newWorkflowNode('comfy-video', 400, 60, 'codex'), id: 'h3-prompt', prompt: original }]);
    window.promptTest.delay = delay;
    window.promptTest.authorizations = 0; window.promptTest.writes = 0;
  }, { original, delay });
  const prompt = page.locator('[data-workflow-card="h3-prompt"] .comfy-video-prompt');
  try { await prompt.waitFor(); } catch (error) { console.error(errors); throw error; }
  await prompt.evaluate(element => {
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input']) element.addEventListener(type, event => {
      window.promptTest.events.push({ type: event.type, data: event.data, isComposing: event.isComposing, value: element.value });
    });
    element.focus(); element.setSelectionRange(2, 4);
  });
  return { page, prompt, errors };
}

async function selection(prompt, value, caret, label) {
  assert.deepEqual(await prompt.evaluate(element => ({ value: element.value, start: element.selectionStart, end: element.selectionEnd, focused: document.activeElement === element })),
    { value, start: caret, end: caret, focused: true }, label);
}

async function persisted(page, prompt, expected, caret, errors) {
  await page.waitForFunction(expected => window.promptTest.pending === 0 && JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'h3-prompt').prompt === expected, expected);
  await selection(prompt, expected, caret, 'save acknowledgements preserve the active caret');
  assert.equal(await page.evaluate(() => window.promptTest.generations), 0);
  assert.deepEqual(errors, []);
  await page.reload();
  await prompt.waitFor();
  assert.equal(await prompt.inputValue(), expected, 'saved prompt survives reload');
}

try {
  for (const delay of [0, 120]) {
    for (const kind of ['typing', 'ime']) {
      const { page, prompt, errors } = await setup(delay);
      const label = `${kind}, IPC delay ${delay} ms`;
      try {
        if (kind === 'typing') {
          let typed = '';
          for (const letter of 'XYZ') {
            await page.keyboard.type(letter);
            typed += letter;
            await selection(prompt, `镜头${typed}推进，主体自然转动`, 2 + typed.length, `${label}: middle insertion preserves the caret`);
          }
          await persisted(page, prompt, '镜头XYZ推进，主体自然转动', 5, errors);
        } else {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
          await selection(prompt, '镜头zhong推进，主体自然转动', 7, `${label}: composing text stays at the selected range`);
          await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
          await selection(prompt, '镜头中文推进，主体自然转动', 4, `${label}: candidates replace the same composition`);
          await cdp.send('Input.insertText', { text: '中文' });
          await selection(prompt, '镜头中文推进，主体自然转动', 4, `${label}: IME commit keeps the caret`);
          await page.keyboard.type('!');
          await selection(prompt, '镜头中文!推进，主体自然转动', 5, `${label}: typing after composition continues in place`);
          const events = await page.evaluate(() => window.promptTest.events);
          assert.ok(events.some(event => event.type === 'compositionstart'));
          assert.ok(events.some(event => event.type === 'input' && event.isComposing));
          assert.ok(events.some(event => event.type === 'compositionend' && event.data === '中文'));
          await persisted(page, prompt, '镜头中文!推进，主体自然转动', 5, errors);
          await cdp.detach();
        }
        console.log(`H3 prompt ${label}: passed`);
      } catch (error) {
        failures.push({ label, error });
        console.error(`H3 prompt ${label}: ${error.stack}`);
      } finally { await page.close(); }
    }
  }
  const { page, errors } = await setup(120);
  try {
    const result = await page.evaluate(async () => {
      const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
      const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
      const controller = canvasWorkflowController('p');
      const current = () => controller.document.nodes.find(node => node.id === 'h3-prompt').prompt;
      const edit = prompt => controller.edit(controller.document.nodes.map(node => node.id === 'h3-prompt' ? { ...node, prompt } : node));
      const first = edit(`${current()}甲`), firstImmediate = current();
      const second = edit(`${current()}乙`), secondImmediate = current();
      await Promise.all([first, second]);
      await controller.edit([...controller.document.nodes, { ...newWorkflowNode('trigger', 950, 60, ''), id: 'h3-trigger', triggerCount: 1 }]);
      const saved = JSON.parse(sessionStorage.getItem('workflow-p')).document;
      const writesBefore = window.promptTest.writes;
      window.promptTest.denyAuthorize = true;
      let editError = '', startError = '', retryError = '';
      // triggerCount is runtime state in native save, so edit authorization must survive a failed-write retry.
      try { await controller.edit(controller.document.nodes.map(node => node.id === 'h3-trigger' ? { ...node, triggerCount: 2 } : node)); } catch (error) { editError = String(error); }
      try { await controller.start('h3-prompt', true); } catch (error) { startError = String(error); }
      try { await controller.retrySave(); } catch (error) { retryError = String(error); }
      const controllerError = controller.error;
      const writesAfterDenial = window.promptTest.writes - writesBefore;
      const persistedUnchanged = JSON.stringify(saved) === JSON.stringify(JSON.parse(sessionStorage.getItem('workflow-p')).document);
      window.promptTest.denyAuthorize = false;
      await controller.retrySave();
      const recoveredCount = JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'h3-trigger').triggerCount;
      const authorizationsBeforeSave = window.promptTest.authorizations;
      await controller.save();
      return { firstImmediate, secondImmediate, savedPrompt: saved.nodes.find(node => node.id === 'h3-prompt').prompt,
        editError, startError, retryError, controllerError, writesAfterDenial, generations: window.promptTest.generations,
        persistedUnchanged, recoveredCount, runtimeSaveAuthorizations: window.promptTest.authorizations - authorizationsBeforeSave };
    });
    assert.equal(result.firstImmediate, `${original}甲`, 'edit updates the controller before returning its pending save');
    assert.equal(result.secondImmediate, `${original}甲乙`, 'a second pending edit uses the latest document');
    assert.equal(result.savedPrompt, `${original}甲乙`, 'queued persistence retains both edits');
    assert.match(result.editError, /权限已失效/);
    assert.match(result.startError, /权限已失效/);
    assert.match(result.retryError, /权限已失效/, 'retrying a trigger-count edit must repeat authorization');
    assert.match(result.controllerError, /工作流未保存/);
    assert.equal(result.writesAfterDenial, 0, 'authorization denial never reaches native save');
    assert.equal(result.persistedUnchanged, true);
    assert.equal(result.recoveredCount, 2, 'restored permission lets retry persist the pending edit');
    assert.equal(result.runtimeSaveAuthorizations, 0, 'ordinary runtime persistence does not request edit authorization');
    assert.equal(result.generations, 0);
    assert.deepEqual(errors, []);
    console.log('H3 prompt synchronous edits, queued persistence and denied authorization: passed');
  } finally { await page.close(); }
  assert.equal(failures.length, 0, `${failures.length} H3 prompt input scenarios failed`);
} finally { await browser.close(); await server.close(); }
