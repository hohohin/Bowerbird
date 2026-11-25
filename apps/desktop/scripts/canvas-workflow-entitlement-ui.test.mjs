import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/canvas-workflow-entitlement-vite',
  server: { host: '127.0.0.1', port: 18442, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const denial = '工作流卡片的创建、编辑和运行需要 Pro；已有结果仍可查看和导出';
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
    await c.edit([source, target]);
    const before = structuredClone(c.document);
    let authorizeCalls = 0;
    api.canvasWorkflowAuthorize = () => {
      authorizeCalls++;
      return new Promise((_, reject) => { window.rejectAuthorization = () => reject(denial); });
    };
    const ghost = { ...source, id: 'unpaid', x: 920 };
    const pending = c.edit([...c.document.nodes, ghost]);
    const dependent = c.edit(c.document.nodes.map(node => node.id === ghost.id ? { ...node, x: 1000 } : node));
    const results = Promise.allSettled([pending, dependent]);
    await Promise.resolve();
    window.rejectAuthorization();
    if ((await results).some(result => result.status !== 'rejected')) throw Error('dependent edits must be rejected');
    if (c.error || c.document.nodes.some(node => node.id === ghost.id)) throw Error('authorization rejection left a failed queue or a ghost card');
    await c.flush();
    api.canvasWorkflowAuthorize = async () => { authorizeCalls++; throw denial; };
    await c.edit(c.document.nodes.map(node => ({ ...node, x: node.x + 10 })));
    await c.disconnectAutomatic('wire');
    if (authorizeCalls !== 1) throw Error('cleanup should bypass preauthorization');
    const saved = (await api.canvasWorkflowGet('p')).document;
    if (saved.nodes[0].x !== before.nodes[0].x + 10 || saved.nodes[1].inputs.image.length !== 1
      || saved.nodes[1].inputs.image[0].assetId !== 'a') throw Error('cleanup must be persisted');

    const save = api.canvasWorkflowSave;
    api.canvasWorkflowAuthorize = async () => {};
    api.canvasWorkflowSave = async () => { throw denial; };
    await c.edit(c.document.nodes.map(node => ({ ...node, prompt: 'denied at save' }))).then(
      () => { throw Error('native permission rejection must reach the caller'); }, () => {},
    );
    if (c.error || c.document.nodes.some(node => node.prompt === 'denied at save')) throw Error('native rejection did not roll back');
    await c.flush();

    api.canvasWorkflowSave = async () => { throw Error('simulated I/O failure'); };
    await c.edit(c.document.nodes.map(node => ({ ...node, prompt: 'recoverable draft' }))).catch(() => {});
    if (!c.error || !c.document.nodes.every(node => node.prompt === 'recoverable draft')) throw Error('I/O failure must preserve the optimistic draft');
    api.canvasWorkflowSave = save;
    await c.retrySave();
    await c.flush();
    api.canvasWorkflowAuthorize = async () => { throw denial; };
  }, denial);

  const stage = page.locator('[data-canvas-stage]');
  const box = await stage.boundingBox();
  await page.mouse.dblclick(box.x + box.width - 100, box.y + box.height - 110);
  await page.getByRole('menuitem', { name: '视频生成', exact: true }).click();
  await page.getByText(denial, { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-workflow-card]').length === 2);
  await page.keyboard.press('Control+z');
  assert.equal(await page.getByRole('button', { name: '重试保存', exact: true }).count(), 0);
  await stage.focus();
  await page.evaluate(async denial => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { captureCanvasClipboard, serializeCanvasClipboard } = await import('/src/lib/canvasClipboard.ts');
    const c = canvasWorkflowController('p');
    const before = window.snapshot();
    const value = captureCanvasClipboard('p', new Set(['target', 'note']), before.nodes, [], [], c.document.nodes);
    const data = new DataTransfer();
    data.setData('text/plain', serializeCanvasClipboard(value));
    const getNative = api.canvasWorkflowSave;
    api.canvasWorkflowAuthorize = async () => {};
    api.canvasWorkflowSave = async (p, r, document) => {
      if (document.nodes.length > 2) { window.pasteDenied = true; throw denial; }
      return getNative(p, r, document);
    };
    window.restoreAuthorizationMock = () => {
      api.canvasWorkflowSave = getNative;
      api.canvasWorkflowAuthorize = async () => { throw denial; };
    };
    window.beforePasteNodeCount = before.nodes.filter(node => node.hiddenAt == null).length;
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, denial);
  await page.waitForFunction(() => window.pasteDenied
    && window.snapshot().nodes.filter(node => node.hiddenAt == null).length === window.beforePasteNodeCount);
  await page.evaluate(() => window.restoreAuthorizationMock());
  const input = page.locator('[data-canvas-node-id="note"] textarea').first();
  await input.fill('权限拒绝后仍能保存内容');
  await input.press('Escape');
  await page.waitForFunction(() => window.snapshot().nodes.find(node => node.id === 'note')?.payloadJson.includes('权限拒绝后仍能保存内容'));
  await stage.focus();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => !window.snapshot().nodes.find(node => node.id === 'note')?.payloadJson.includes('权限拒绝后仍能保存内容'));
  await page.locator('[data-workflow-card="source"]').getByRole('button', { name: '删除卡片', exact: true }).click();
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
  console.log('PASS Pro denial rollback, I/O retry, free cleanup, denied creation and paste, content undo, and project exit.');
} finally { await browser.close(); await server.close(); }
