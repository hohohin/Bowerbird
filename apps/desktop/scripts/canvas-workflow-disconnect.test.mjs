import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1597, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const snapshot = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document);
try {
  await page.goto('http://127.0.0.1:1597/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const canvas = window.snapshot(); canvas.nodes = canvas.nodes.filter(node => node.id === 'old');
    const cell = id => ({ id, text: '保留内容', bold: false, italic: false, align: 'left' });
    canvas.nodes.push({ ...canvas.nodes[0], id: 'table', kind: 'note', assetId: null, x: 80, y: 500, width: 340, height: 230,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', title: '自定义标题', text: '', member_ids: [], cells: [[cell('c1')], [cell('c2')]] }) });
    sessionStorage.setItem('reference-fixture', JSON.stringify(canvas));
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const source = (id, x) => ({ ...newWorkflowNode('instruction', x, 100, 'codex'), id });
    const a = source('a', 80), b = source('b', 480);
    const target = { ...newWorkflowNode('generation', 880, 100, 'codex'), id: 'target', inputs: { text: [{ nodeId: 'a', portId: 'text' }, { nodeId: 'b', portId: 'text' }] } };
    const writer = (id, sourceId, cellId) => ({ ...newWorkflowNode('text', 0, 0, ''), id, inputs: { text: [{ nodeId: sourceId, portId: 'text' }] }, textTarget: { nodeId: 'table', cellId, append: true } });
    const t1 = { ...newWorkflowNode('trigger', 500, 600, ''), id: 't1' }, t2 = { ...newWorkflowNode('trigger', 900, 600, ''), id: 't2' };
    target.inputs.signal = [{ nodeId: 't1', portId: 'signal' }, { nodeId: 't2', portId: 'signal' }];
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 0, document: { schema_version: 1, nodes: [a, b, target, writer('w1', 'a', 'c1'), writer('w2', 'b', 'c2'), t1, t2], run: null } }));
  });
  await page.reload(); await page.locator('[data-workflow-card="target"]').waitFor();
  await page.getByRole('button', { name: '适应内容', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.cardNames?.table);
  const names = (await snapshot()).cardNames;
  assert.equal(names.a, '指令卡片 1'); assert.equal(names.b, '指令卡片 2');
  assert.equal(new Set(Object.values(names)).size, Object.keys(names).length);
  assert.equal(await page.locator('[data-card-name="a"] input').inputValue(), names.a);
  assert.equal(await page.locator('[data-workflow-card="a"] header strong').innerText(), '');
  assert.equal(await page.locator('[data-card-name="table"] input').inputValue(), names.table);
  assert.equal(await page.getByRole('textbox', { name: '内容卡片标题', exact: true }).count(), 0);
  const target = page.locator('[data-workflow-card="target"]');
  const socket = target.getByRole('button', { name: '输入：文本', exact: true });
  const menu = page.getByRole('menu', { name: '选择要断开的连线' });
  await socket.click({ button: 'right' }); await menu.waitFor();
  assert.equal((await snapshot()).nodes.find(node => node.id === 'target').inputs.text.length, 2);
  assert.match(await menu.innerText(), /指令卡片 1/); assert.match(await menu.innerText(), /指令卡片 2/);
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
  await socket.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /指令卡片 2/ }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'target').inputs.text.length === 1);
  assert.equal((await snapshot()).nodes.find(node => node.id === 'target').inputs.text[0].nodeId, 'a');
  await socket.click({ button: 'right' });
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'target').inputs.text.length === 0);
  assert.equal(await menu.count(), 0);
  // Native whole-card inputs choose exactly one hidden writer and retain cell contents.
  const tableInput = page.locator('[data-canvas-node-id="table"]').getByRole('button', { name: '内容卡片输入', exact: true });
  await tableInput.click({ button: 'right', force: true }); await menu.waitFor();
  assert.match(await menu.innerText(), /第 1 行，第 1 列/); assert.match(await menu.innerText(), /第 2 行，第 1 列/);
  await menu.getByRole('menuitem', { name: /指令卡片 1/ }).click();
  await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(node => node.id === 'w1'));
  assert.ok((await snapshot()).nodes.some(node => node.id === 'w2'));
  assert.equal(await page.locator('[data-canvas-node-id="table"] textarea').first().inputValue(), '保留内容');
  // Trigger gear shares the same multi-source chooser.
  await target.getByRole('button', { name: '断开触发器连接', exact: true }).click({ button: 'right' }); await menu.waitFor();
  await menu.getByRole('menuitem', { name: /触发器卡片 1/ }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'target').inputs.signal.length === 1);
  assert.equal((await snapshot()).nodes.find(node => node.id === 'target').inputs.signal[0].nodeId, 't2');
  // Copies get a fresh name; existing names survive reload and deletion.
  await page.locator('[data-workflow-card="a"]').getByRole('button', { name: '复制卡片', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.filter(node => node.kind === 'instruction').length === 3);
  let doc = await snapshot(); const copy = doc.nodes.find(node => node.kind === 'instruction' && node.id !== 'a' && node.id !== 'b');
  assert.equal(doc.cardNames[copy.id], '指令卡片 3');
  await page.reload(); await page.locator('[data-workflow-card="target"]').waitFor();
  doc = await snapshot(); for (const [id, name] of Object.entries(names)) assert.equal(doc.cardNames[id], name);
  // Same table, different cells must be distinguishable in the chooser.
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    await c.edit(c.document.nodes.map(node => node.id === 'target' ? { ...node, inputs: { ...node.inputs, text: [{ canvasNodeId: 'table', cellId: 'c1' }, { canvasNodeId: 'table', cellId: 'c2' }] } } : node));
  });
  await page.getByRole('button', { name: '适应内容', exact: true }).click();
  await socket.click({ button: 'right' }); await menu.waitFor();
  assert.match(await menu.innerText(), /第 1 行，第 1 列/); assert.match(await menu.innerText(), /第 2 行，第 1 列/);
  await page.screenshot({ path: '.tmp/workflow/disconnect-menu.png' });
  await page.mouse.click(10, 10); await menu.waitFor({ state: 'hidden' });
  // A menu near the viewport edge stays on screen, and keyboard selection removes one line.
  await socket.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { clientX: 1798, clientY: 1198, bubbles: true }))); await menu.waitFor();
  const rect = await menu.boundingBox(); assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1800 && rect.y + rect.height <= 1200, JSON.stringify({ rect, viewport: await page.evaluate(() => ({ w: innerWidth, h: innerHeight, zoom: getComputedStyle(document.documentElement).zoom, bodyZoom: getComputedStyle(document.body).zoom })) }));
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'target').inputs.text.length === 1);
  await page.locator('[data-workflow-card="b"]').getByRole('button', { name: '删除卡片', exact: true }).click();
  await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(node => node.id === 'b'));
  doc = await snapshot(); assert.equal(doc.cardNames.a, names.a); assert.equal(doc.cardNames[copy.id], '指令卡片 3');
  // All card kinds share the name editor, and validation spans the whole canvas.
  const nameInput = id => page.locator(`[data-card-name="${id}"] input`);
  await nameInput('a').fill('主视觉'); await nameInput('a').press('Enter');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.cardNames.a === '主视觉');
  const nameBox = await nameInput('a').boundingBox(), cardBox = await page.locator('[data-workflow-card="a"]').boundingBox();
  assert.ok(nameBox.y + nameBox.height <= cardBox.y);
  await nameInput('table').fill(' 主视觉 ');
  assert.equal(await nameInput('table').getAttribute('aria-invalid'), 'true');
  assert.match(await page.locator('[data-card-name="table"] [role="alert"]').innerText(), /该名字重复/);
  assert.equal(await nameInput('table').evaluate(el => getComputedStyle(el).borderTopColor), 'rgb(220, 68, 68)');
  await nameInput('table').blur(); assert.equal((await snapshot()).cardNames.table, names.table);
  await page.screenshot({ path: '.tmp/workflow/duplicate-card-name.png' });
  await nameInput('table').fill('文案素材'); await nameInput('table').press('Enter');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.cardNames.table === '文案素材');
  await nameInput('old').fill('文案素材'); assert.equal(await nameInput('old').getAttribute('aria-invalid'), 'true');
  await nameInput('old').press('Escape'); assert.equal(await nameInput('old').inputValue(), names.old);
  await nameInput('table').fill('   '); assert.equal(await nameInput('table').getAttribute('aria-invalid'), 'true');
  await nameInput('table').press('Escape'); assert.equal(await nameInput('table').inputValue(), '文案素材');
  // Removed cards do not reserve user-entered names.
  await nameInput('target').fill(names.b); await nameInput('target').press('Enter');
  await page.waitForFunction(value => JSON.parse(sessionStorage.getItem('workflow-p')).document.cardNames.target === value, names.b);
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts'); const c = canvasWorkflowController('p');
    await c.edit(c.document.nodes.map(node => node.id === 'target' ? { ...node, inputs: { ...node.inputs, text: [{ nodeId: 'a', portId: 'text' }, { canvasNodeId: 'table', cellId: 'c1' }] } } : node));
  });
  await socket.click({ button: 'right' }); await menu.waitFor();
  assert.match(await menu.innerText(), /主视觉/); assert.match(await menu.innerText(), /文案素材/); assert.doesNotMatch(await menu.innerText(), /自定义标题/);
  await page.keyboard.press('Escape'); await page.reload(); await nameInput('a').waitFor();
  assert.equal(await nameInput('a').inputValue(), '主视觉'); assert.equal(await nameInput('table').inputValue(), '文案素材');
  assert.deepEqual(errors, []);
  console.log('PASS: selective disconnect, native writers, trigger gear, stable unique names, copies, reload, cell labels, dismissal, custom names, duplicate/empty validation');
} finally { await browser.close(); await server.close(); }
