import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1590, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
try {
  await page.goto('http://127.0.0.1:1590/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const base = window.snapshot().nodes[0];
    await api.projectCanvasNodeCreate({ ...base, id: 'prompt-text', kind: 'note', role: null, assetId: null, x: 50, y: 30, payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '柔和光线\n保留留白', cells: [[{ id: 'cell', text: '柔和光线\n保留留白', bold: false, italic: false, align: 'left' }]], member_ids: [] }) });
    const c = canvasWorkflowController('p'); await c.load();
    await c.edit([{ ...newWorkflowNode('generation', 420, 60, 'codex'), id: 'gen', prompt: '只用本地文本', inputs: { text: [{ canvasNodeId: 'prompt-text', cellId: 'cell' }], image: [{ assetId: 'a' }, { assetId: 'b' }] } }]);
    window.save();
  });
  await page.reload();
  const editor = page.getByRole('textbox', { name: '卡片指令', exact: true }); await editor.waitFor();
  assert.equal(await editor.innerText(), '只用本地文本');
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { useStore } = await import('/src/store.ts');
    const { api } = await import('/src/lib/api.ts');
    window.requests = [];
    api.localAgentFindAssetId = async () => 'existing';
    useStore.setState({ startGeneration: async (...args) => {
      const [prompt, assets] = args, identity = args[12];
      window.requests.push({ prompt, ids: assets.map(a => a.id) });
      useStore.setState(state => ({ genJobs: { ...state.genJobs, [identity.jobId]: { turns: [{ turnKey: identity.turnKey, images: ['existing.png'] }] } } }));
      return { accepted: true };
    } });
    await canvasWorkflowController('p').start('gen', true);
  });
  assert.deepEqual(await page.evaluate(() => window.requests[0]), { prompt: '只用本地文本', ids: [] });
  await editor.fill('请使用：'); await editor.press('End'); await editor.pressSequentially('@');
  const list = page.getByRole('listbox', { name: '收到的内容' }); await list.waitFor();
  assert.equal(await list.getByRole('option').count(), 3);
  await page.screenshot({ path: '.tmp/workflow/prompt-menu.png' });
  await list.getByRole('option').filter({ hasText: '柔和光线' }).click();
  assert.equal(await editor.locator('[data-reference-id]').count(), 1);
  await editor.pressSequentially('；参考'); await editor.pressSequentially('@');
  await list.getByRole('option').filter({ hasText: '图片 2.1' }).click();
  assert.equal(await editor.locator('[data-reference-id]').count(), 2);
  await page.screenshot({ path: '.tmp/workflow/prompt-references.png' });
  await page.evaluate(async () => { const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts'); await canvasWorkflowController('p').start('gen', true); });
  assert.deepEqual(await page.evaluate(() => window.requests[1]), { prompt: '请使用：柔和光线\n保留留白；参考@图片1', ids: ['b'] });
  await page.evaluate(() => window.save()); await page.reload(); await editor.waitFor();
  assert.equal(await editor.locator('[data-reference-id]').count(), 2);
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { useStore } = await import('/src/store.ts');
    const table = window.snapshot().nodes.find(n => n.id === 'prompt-text'), payload = JSON.parse(table.payloadJson);
    payload.cells[0][0].text = '更新后的文字'; await api.projectCanvasNoteUpdate(table.id, JSON.stringify(payload));
    api.localAgentFindAssetId = async () => 'existing';
    window.requests = []; useStore.setState({ startGeneration: async (...args) => {
      const [prompt, assets] = args, identity = args[12];
      window.requests.push({ prompt, ids: assets.map(a => a.id) });
      useStore.setState(state => ({ genJobs: { ...state.genJobs, [identity.jobId]: { turns: [{ turnKey: identity.turnKey, images: ['existing.png'] }] } } }));
      return { accepted: true };
    } });
    const c = canvasWorkflowController('p'); await c.start('gen', true);
    if (c.document.run.status !== 'done') throw new Error(JSON.stringify(c.document.run));
  });
  assert.deepEqual(await page.evaluate(() => window.requests[0]), { prompt: '请使用：更新后的文字；参考@图片1', ids: ['b'] });
  await editor.fill('删除引用后只发这句');
  await page.evaluate(async () => { const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts'); await canvasWorkflowController('p').start('gen', true); });
  assert.deepEqual(await page.evaluate(() => window.requests[1]), { prompt: '删除引用后只发这句', ids: [] });
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const table=window.snapshot().nodes.find(n=>n.id==='prompt-text'),payload=JSON.parse(table.payloadJson);
    payload.cells=[[{id:'empty-text',content_type:'text',text:'',image_refs:[]},{id:'empty-image',content_type:'image',text:'',image_refs:[]}]];
    await api.projectCanvasNoteUpdate(table.id,JSON.stringify(payload));window.emitChange();
    const c=canvasWorkflowController('p');await c.edit(c.document.nodes.map(n=>({...n,prompt:'',promptReferences:[],inputs:{text:[{canvasNodeId:table.id,cellId:'empty-text'}],image:[{canvasNodeId:table.id,cellId:'empty-image'}]}})));
  });
  await editor.fill('引用空格：');await editor.press('End');await editor.pressSequentially('@');
  await list.waitFor();
  const textOption=list.getByRole('option').filter({hasText:'文本 1'});
  assert.equal(await textOption.isEnabled(),true);await textOption.click();
  await editor.pressSequentially(' 和 @');await list.waitFor();
  const imageOption=list.getByRole('option').filter({hasText:'图片来源 1'});
  assert.equal(await imageOption.isEnabled(),true);await imageOption.click();
  const identities=await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    return canvasWorkflowController('p').document.nodes[0].promptReferences.map(ref=>ref.input.cellId);
  });
  assert.deepEqual(identities,['empty-text','empty-image']);
  assert.equal(await editor.locator('[data-reference-id]').count(),2);
  console.log('generation prompt: no auto input, @ menu, text/image chips, exact expansion, selected images only, reload, live text and reference deletion passed');
} finally { await browser.close(); await server.close(); }
