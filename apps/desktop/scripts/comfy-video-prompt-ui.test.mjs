import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } }, cacheDir: '.tmp/comfy-video-prompt/vite',
  optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, server: { host: '127.0.0.1', port: 1682, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const failures = [];
const original = '镜头平稳推进，主体自然转动';

async function setup(delay, legacySizing = false) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (legacySizing) await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (property, ...args) => property !== 'field-sizing' && supports(property, ...args);
  });
  await page.goto('http://127.0.0.1:1682/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  if (legacySizing) await page.addStyleTag({ content: '.workflow-card textarea[data-fit-content] { field-sizing: fixed; }' });
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
          if (command === 'canvas_workflow_save' && window.promptTest.denySave) throw new Error('模拟工作流保存失败');
          const result = await invoke(command, args);
          if (command === 'canvas_workflow_save') window.promptTest.writes++;
          return result;
        } finally { window.promptTest.pending--; }
      }
      return invoke(command, args);
    };
    const { newWorkflowNode, selectWorkflowVideoProvider } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller = canvasWorkflowController('p');
    await controller.load();
    await controller.edit([{ ...newWorkflowNode('comfy-video', 400, 60, 'codex'), id: 'h3-prompt', prompt: original }]);
    window.replaceH3Prompt = prompt => controller.edit(controller.document.nodes.map(node => node.id === 'h3-prompt' ? { ...node, prompt } : node));
    window.switchH3ToCloud = () => controller.edit(controller.document.nodes.map(node => node.id === 'h3-prompt' ? selectWorkflowVideoProvider(node, 'cloud') : node));
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
  for (const legacySizing of [false, true]) {
    const { page, prompt, errors } = await setup(0, legacySizing);
    try {
      const dimensions = (field = prompt) => field.evaluate(element => {
        const style = getComputedStyle(element);
        return { height: element.offsetHeight, client: element.clientHeight, scroll: element.scrollHeight,
          max: parseFloat(style.maxHeight), lines: (element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight) };
      });
      const compact = await dimensions();
      assert.equal(compact.height, 64, `a short H3 prompt uses the compact prototype height (legacy sizing: ${legacySizing})`);
      const mediumText = Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 行提示词`).join('\n');
      await prompt.fill(mediumText);
      const expanded = await dimensions();
      assert.ok(expanded.height > compact.height && expanded.height < expanded.max, 'text input grows within the available height');
      assert.ok(expanded.scroll <= expanded.client + 1, 'uncapped text does not need scrolling');
      const longText = `${mediumText}\n`.repeat(12);
      await page.evaluate(text => window.replaceH3Prompt(text), longText);
      await page.waitForFunction(text => document.querySelector('.comfy-video-prompt')?.value === text, longText);
      const capped = await dimensions();
      assert.equal(capped.height, capped.max, 'externally updated text stops growing at the cap');
      assert.ok(capped.scroll > capped.client, 'text beyond the cap can scroll');
      await page.evaluate(text => window.replaceH3Prompt(text), original);
      await page.waitForFunction(text => document.querySelector('.comfy-video-prompt')?.value === text, original);
      assert.equal((await dimensions()).height, compact.height, 'replacing text with a short value restores the minimum');
      if (!legacySizing) {
        await page.evaluate(() => window.switchH3ToCloud());
        const cloudEditor = page.locator('[data-workflow-card="h3-prompt"] .workflow-prompt-editor .ProseMirror');
        await cloudEditor.waitFor();
        assert.ok(Math.abs((await dimensions(cloudEditor)).lines - 4) < 0.15, 'Cloud video prompt uses the same four-line minimum');
        await page.evaluate(text => window.replaceH3Prompt(text), longText);
        await page.waitForFunction(text => document.querySelector('.workflow-prompt-editor .ProseMirror p')?.textContent === text.split('\n')[0] &&
          document.querySelectorAll('.workflow-prompt-editor .ProseMirror p').length === text.split('\n').length, longText);
        const cloud = await dimensions(cloudEditor);
        assert.equal(cloud.height, cloud.max, 'rich input grows to the existing Cloud video cap');
        assert.ok(cloud.scroll > cloud.client, 'rich input scrolls after the cap');
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }

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
      window.promptTest.denySave = true;
      let editError = '', startError = '';
      try { await controller.edit(controller.document.nodes.map(node => node.id === 'h3-trigger' ? { ...node, triggerCount: 2 } : node)); } catch (error) { editError = String(error); }
      try { await controller.start('h3-prompt', true); } catch (error) { startError = String(error); }
      const controllerError = controller.error;
      const writesAfterDenial = window.promptTest.writes - writesBefore;
      const persistedUnchanged = JSON.stringify(saved) === JSON.stringify(JSON.parse(sessionStorage.getItem('workflow-p')).document);
      window.promptTest.denySave = false;
      const authorizationsBeforeSave = window.promptTest.authorizations;
      await controller.retrySave();
      const recoveredCount = JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'h3-trigger').triggerCount;
      await controller.save();
      return { firstImmediate, secondImmediate, savedPrompt: saved.nodes.find(node => node.id === 'h3-prompt').prompt,
        editError, startError, controllerError, writesAfterDenial, generations: window.promptTest.generations,
        persistedUnchanged, recoveredCount, runtimeSaveAuthorizations: window.promptTest.authorizations - authorizationsBeforeSave };
    });
    assert.equal(result.firstImmediate, `${original}甲`, 'edit updates the controller before returning its pending save');
    assert.equal(result.secondImmediate, `${original}甲乙`, 'a second pending edit uses the latest document');
    assert.equal(result.savedPrompt, `${original}甲乙`, 'queued persistence retains both edits');
    assert.match(result.editError, /模拟工作流保存失败/);
    assert.match(result.startError, /权限已失效/);
    assert.match(result.controllerError, /工作流未保存/);
    assert.equal(result.writesAfterDenial, 0, 'rejected persistence never updates the stored revision');
    assert.equal(result.persistedUnchanged, true);
    assert.equal(result.recoveredCount, 2, 'retry persists the pending edit even when runtime access is denied');
    assert.equal(result.runtimeSaveAuthorizations, 0, 'local editing and retry never request runtime authorization');
    assert.equal(result.generations, 0);
    assert.deepEqual(errors, []);
    console.log('H3 prompt synchronous edits and save recovery while runtime authorization is denied: passed');
  } finally { await page.close(); }
  assert.equal(failures.length, 0, `${failures.length} H3 prompt input scenarios failed`);
} finally { await browser.close(); await server.close(); }
