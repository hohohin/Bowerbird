import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, cacheDir: '.tmp/canvas-document-vite' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(10000);
await page.route('**/fixture/document.png', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#748d81"/></svg>' }));
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-document/preview.html`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const snapshot = window.snapshot();
    snapshot.nodes = [{ id: 'script', projectId: 'p', kind: 'note', assetId: null, role: null, threadId: null, x: 80, y: 80, width: 400, height: 420, zIndex: 1, positionLocked: false, hiddenAt: null, createdAt: 1, updatedAt: 1,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'document', title: '长剧本', text: '# 开场\n\n**镜头**\n\n- 第一个画面\n\n<img data-bowerbird-asset="a" data-caption="" />\n', cells: [], member_ids: [] }) }];
    snapshot.edges = []; snapshot.groups = []; snapshot.groupItems = [];
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const generator = { ...newWorkflowNode('generation', 650, 80, 'codex'), id: 'generator', prompt: '生成第一镜头' };
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 0, document: { schema_version: 1, nodes: [generator], run: null } }));
  });
  await page.reload();
  const document = page.locator('.is-document-card'); await document.waitFor();
  assert.equal(await document.locator('.canvas-document-heading > span').innerText(), '长剧本');
  assert.equal(await document.locator('.canvas-document-body').count(), 0);
  assert.equal(await document.evaluate(el => el.style.height), '56px');
  const generator = page.locator('[data-workflow-card="generator"]');
  await page.getByRole('button', { name: '适应内容', exact: true }).click();
  await document.getByRole('button', { name: '输出文档文本', exact: true }).click();
  await generator.getByRole('button', { name: '输入：文本', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0].inputs.text?.length === 1);
  let state = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0]);
  assert.equal(state.promptReferences?.length, 1, 'a document connection inserts an explicit prompt reference');
  await document.getByRole('button', { name: '输出文档图片', exact: true }).click();
  await generator.getByRole('button', { name: '输入：图片', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0].inputs.image?.length === 1);
  const compiled = await page.evaluate(async () => {
    const { compileGenerationPrompt } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasInputValue } = await import('/src/lib/canvasSessionOutputs.ts');
    const source = window.snapshot().nodes[0];
    return compileGenerationPrompt(JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0], { text: [canvasInputValue(source, '*text', [source])], image: [canvasInputValue(source, '*', [source])] });
  });
  assert.match(compiled.prompt, /# 开场\n\n\*\*镜头\*\*/); assert.deepEqual(compiled.assetIds, ['a']);
  async function delayPromptAsset() {
    await page.evaluate(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.documentAssetWaiting = false;
      window.documentAssetResolved = false;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command !== 'get_prompted_asset') return original(command, args);
        window.__TAURI_INTERNALS__.invoke = original;
        const assets = await original('get_assets_by_ids', { assetIds: [args.assetId] });
        await new Promise(resolve => { window.resolveDocumentAsset = resolve; window.documentAssetWaiting = true; });
        window.documentAssetResolved = true;
        return { ...assets[0], sections: [] };
      };
    });
  }
  await document.getByRole('button', { name: '编辑文本卡片', exact: true }).click();
  await delayPromptAsset();
  await page.getByRole('button', { name: '添加到生成对话框', exact: true }).click();
  await page.waitForFunction(() => window.documentAssetWaiting);
  await page.getByRole('textbox', { name: '文档名称', exact: true }).fill('继续编辑的剧本');
  await page.evaluate(() => window.resolveDocumentAsset());
  await page.waitForFunction(() => document.querySelector('.text-workspace [role="alert"]') || !document.querySelector('.text-workspace'));
  assert.equal(await page.getByRole('dialog', { name: '文本编辑器', exact: true }).count(), 1, 'typing during reference loading keeps the newer draft open');
  assert.match(await page.getByRole('alert').innerText(), /新的更改/);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await document.getByRole('button', { name: '编辑文本卡片', exact: true }).click();
  await delayPromptAsset();
  await page.getByRole('button', { name: '添加到生成对话框', exact: true }).click();
  await page.waitForFunction(() => window.documentAssetWaiting);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await document.getByRole('button', { name: '编辑文本卡片', exact: true }).click();
  await page.getByRole('textbox', { name: '文档名称', exact: true }).fill('重新打开的剧本');
  await page.evaluate(() => window.resolveDocumentAsset());
  await page.waitForFunction(() => window.documentAssetResolved);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole('dialog', { name: '文本编辑器', exact: true }).count(), 1, 'an older closed session cannot close the reopened editor');
  assert.equal(await page.getByRole('textbox', { name: '文档名称', exact: true }).inputValue(), '重新打开的剧本');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await document.getByRole('button', { name: '编辑文本卡片', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true }); await editor.waitFor();
  await editor.locator('.text-document-block').first().click(); await page.keyboard.press('End'); await page.keyboard.insertText(' · 已编辑');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.waitForFunction(() => window.snapshot().nodes[0].payloadJson.includes('已编辑'));
  await page.evaluate(() => sessionStorage.setItem('reference-fixture', JSON.stringify(window.snapshot())));
  await page.reload(); await page.locator('.is-document-card').waitFor();
  assert.match(await page.evaluate(() => JSON.parse(window.snapshot().nodes[0].payloadJson).text), /已编辑/);
  assert.equal(await page.locator('.canvas-document-heading > span').innerText(), '重新打开的剧本');
  assert.equal((await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0])).promptReferences.length, 2);
  await mkdir('.tmp/canvas-document', { recursive: true });
  for (const theme of ['dark', 'light']) { await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await page.screenshot({ path: `.tmp/canvas-document/${theme}.png` }); }
  await page.getByRole('button', { name: '文本卡片工具', exact: true }).click();
  const stage = await page.locator('.canvas-stage').boundingBox();
  await page.mouse.click(stage.x + 160, stage.y + 160);
  await page.waitForFunction(() => window.snapshot().nodes.filter(node => JSON.parse(node.payloadJson).note_type === 'document').length === 2);
  const created = await page.evaluate(() => window.snapshot().nodes.find(node => node.id !== 'script'));
  assert.deepEqual(JSON.parse(created.payloadJson).cells, []);
  assert.equal(created.height, 56);
  assert.equal(await page.locator(`[data-canvas-node-id="${created.id}"] .canvas-document-heading > span`).innerText(), "空白文档");
  assert.deepEqual(errors, []);
  console.log('PASS document canvas: real card, typed wires, explicit prompt references, formatted generation compile, edit and reload, stale reference-load protection');
} finally { await browser.close(); await server.close(); }
