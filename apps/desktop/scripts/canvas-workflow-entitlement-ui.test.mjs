import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/canvas-workflow-entitlement-vite',
  server: { host: '127.0.0.1', port: 18442, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const denial = '运行工作流卡片需要 Pro。已有结果仍可查看和导出';
try {
  await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    snapshot.nodes.push({ ...snapshot.nodes[0], id: 'note', kind: 'note', assetId: null, role: null,
      x: 220, y: 630, width: 340, height: 180,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', member_ids: [],
        cells: [[{ id: 'cell', content_type: 'text', text: '原有内容' }]] }),
    });
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  await page.locator('[data-canvas-node-id="note"]').waitFor();
  await page.evaluate(async denial => {
    const { api } = await import('/src/lib/api.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    await c.load();
    const source = { ...newWorkflowNode('instruction', 180, 280, 'codex'), id: 'source', action: 'reuse' };
    const target = { ...newWorkflowNode('generation', 610, 280, 'codex'), id: 'target',
      inputs: { image: [{ nodeId: source.id, portId: 'image', autoConnect: 'wire' }, { assetId: 'a' }] } };
    window.store.setState({ cloudAuth: null, cloudEntitlement: null });
    window.authorizeCalls = 0;
    api.canvasWorkflowAuthorize = async () => { window.authorizeCalls++; throw denial; };
    await c.edit([source, target]);
    const copy = { ...source, id: 'free-copy', x: 920 };
    const pending = c.edit([...c.document.nodes, copy]);
    const dependent = c.edit(c.document.nodes.map(node => node.id === copy.id ? { ...node, x: 1000 } : node));
    await Promise.all([pending, dependent]);
    await c.disconnectAutomatic('wire');
    const saved = (await api.canvasWorkflowGet('p')).document;
    if (saved.nodes.find(node => node.id === copy.id)?.x !== 1000 || saved.nodes[1].inputs.image.length !== 1
      || saved.nodes[1].inputs.image[0].assetId !== 'a') throw Error('edits must be persisted');
    await c.edit(c.document.nodes.filter(node => node.id !== copy.id));

    const save = api.canvasWorkflowSave;
    api.canvasWorkflowSave = async () => { throw Error('simulated I/O failure'); };
    await c.edit(c.document.nodes.map(node => ({ ...node, prompt: 'recoverable draft' }))).catch(() => {});
    if (!c.error || !c.document.nodes.every(node => node.prompt === 'recoverable draft')) throw Error('I/O failure must preserve the optimistic draft');
    api.canvasWorkflowSave = save;
    await c.retrySave();
    await c.flush();
  }, denial);

  const stage = page.locator('[data-canvas-stage]');
  const box = await stage.boundingBox();
  await page.mouse.dblclick(box.x + box.width - 100, box.y + box.height - 110);
  await page.getByRole('menuitem', { name: '视频生成', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length === 3);
  await stage.focus();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length === 2);
  assert.equal(await page.getByRole('button', { name: '重试保存', exact: true }).count(), 0);
  await stage.focus();
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { captureCanvasClipboard, serializeCanvasClipboard } = await import('/src/lib/canvasClipboard.ts');
    const c = canvasWorkflowController('p');
    const before = window.snapshot();
    const value = captureCanvasClipboard('p', new Set(['target', 'note']), before.nodes, [], [], c.document.nodes);
    const data = new DataTransfer();
    data.setData('text/plain', serializeCanvasClipboard(value));
    window.beforePasteNodeCount = before.nodes.filter(node => node.hiddenAt == null).length;
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length === 3
    && window.snapshot().nodes.filter(node => node.hiddenAt == null).length === window.beforePasteNodeCount + 1);
  await stage.focus();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length === 2
    && window.snapshot().nodes.filter(node => node.hiddenAt == null).length === window.beforePasteNodeCount);
  const input = page.locator('[data-canvas-node-id="note"] textarea').first();
  await input.fill('免费编辑后仍能保存内容');
  await input.press('Escape');
  await page.waitForFunction(() => window.snapshot().nodes.find(node => node.id === 'note')?.payloadJson.includes('免费编辑后仍能保存内容'));
  await stage.focus();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => !window.snapshot().nodes.find(node => node.id === 'note')?.payloadJson.includes('免费编辑后仍能保存内容'));
  await page.locator('[data-workflow-card="source"]').getByRole('button', { name: '删除卡片', exact: true })
    .evaluate(button => button.click());
  await page.waitForFunction(() => {
    const nodes = JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes;
    return nodes.length === 1 && nodes[0].id === 'target';
  });
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    await canvasWorkflowController('p').flush();
    await window.store.getState().exitProject();
    if (window.store.getState().activeProjectId !== null) throw Error('project exit was blocked');
  });
  assert.equal(await page.evaluate(() => window.authorizeCalls), 0);
  console.log('PASS Free creation, edits, paste, undo and project exit, including recovery from an I/O failure.');
} finally { await browser.close(); await server.close(); }
