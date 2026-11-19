import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/generation-galleries/vite', server: { host: '127.0.0.1', port: 17934, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await mkdir('.tmp/generation-galleries', { recursive: true });
  await page.addInitScript(() => {
    window.total = 2;
    const image = (id, color) => ({ id, name: `${id}.png`, ext: 'png', width: 240, height: 160, store_path: `/${id}.png`,
      thumb_path: 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="${color}"/><text x="20" y="90" fill="white">${id}</text></svg>`), generation_session_id: 'shared' });
    window.testImage = image;
    window.generationGroups = { 'asset-1': [image('previous-1', '#64554e'), image('previous-2', '#556854'), image('asset-1', '#506574')] };
    window.assetDimensions = i => i === 1 ? window.generationGroups['asset-1'].at(-1) : {};
  });
  await page.goto('http://127.0.0.1:17934/scripts/fixtures/catalog-paging/preview.html');
  const group = page.locator('.catalog-generation-group');
  await group.locator('[data-asset-id="asset-1"]').waitFor();
  assert.equal(await page.locator('.folder-media-card').count(), 2, 'only one tile per conversation');
  assert.equal(await group.locator('.generation-group-count').innerText(), '3/3');
  await group.hover();
  await group.getByRole('button', { name: '上一张生成素材' }).click();
  await group.locator('[data-asset-id="previous-2"]').waitFor();
  await group.locator('[data-asset-id="previous-2"]').click();
  await page.waitForFunction(() => window.requests.some(r => r.command === 'external_files_media' && r.args.path === '/previous-2.png'));
  await page.keyboard.press('Escape');
  await group.locator('[data-asset-id="previous-2"]').click({ modifiers: ['Control'] });
  assert.equal(await group.locator('[data-asset-id="previous-2"]').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '全选', exact: true }).click();
  assert.equal(await group.locator('[data-asset-id="previous-2"]').getAttribute('aria-pressed'), 'true', 'select all uses the currently displayed result');
  await page.locator('[data-asset-id="asset-0"]').click({ modifiers: ['Shift'] });
  assert.equal(await group.locator('[data-asset-id="previous-2"]').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  await group.locator('[data-asset-id="previous-2"]').click({ button: 'right' });
  assert.equal(await page.evaluate(() => window.store.getState().contextMenu.assetId), 'previous-2');
  await page.keyboard.press('Escape');
  await group.getByRole('button', { name: '上一张生成素材' }).focus();
  await page.keyboard.press('Enter');
  await group.locator('[data-asset-id="previous-1"]').waitFor();
  assert.equal(await group.locator('.generation-group-count').innerText(), '1/3');
  await page.evaluate(() => {
    const latest = { ...window.testImage('new-result', '#76654d'), generation_session_id: null, source: 'import' };
    window.generationGroups = { 'new-result': [window.testImage('previous-1', '#64554e'), latest] };
    window.assetDimensions = i => i === 1 ? latest : {};
    window.refresh();
  });
  await group.locator('[data-asset-id="new-result"]').waitFor();
  assert.equal(await group.locator('.generation-group-count').innerText(), '2/2', 'changed newest identity resets browsing even when results are removed');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await group.hover();
    await page.screenshot({ path: `.tmp/generation-galleries/library-${theme}.png` });
  }

  await page.goto('http://127.0.0.1:17934/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    const prompt = (id, job, time) => ({ ...base, id, kind: 'prompt', assetId: null, role: null, x: 200, y: 100, width: 260, height: 148, createdAt: time,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: job, conversation_id: job, workflow_generation_group: 'workflow:producer', turn_key: 'turn', text: id, status: 'done' }) });
    const output = (id, job, time) => ({ ...base, id: `output-${id}`, assetId: id, role: 'output', createdAt: time,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: id, width: 190, height: 150 }, execution: { job_id: job, turn_key: 'turn' } }) });
    snapshot.nodes = [prompt('session-first', 'job-first', 1), output('a', 'job-first', 1), prompt('session-next', 'job-next', 2), output('b', 'job-next', 2)];
    snapshot.edges = []; snapshot.view = { ...snapshot.view, panX: 100, panY: 60, zoom: 1 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  await page.locator('[data-conversation-image="b"]').waitFor();
  assert.equal(await page.locator('.canvas-prompt-node').count(), 1, 'independent workflow jobs still share their persisted producer');
  await page.locator('.canvas-conversation-images').hover();
  await page.getByRole('button', { name: '上一张生成图片' }).click();
  await page.locator('[data-conversation-image="a"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    for (const node of snapshot.nodes.filter(node => node.kind === 'prompt')) {
      node.payloadJson = JSON.stringify({...JSON.parse(node.payloadJson),conversation_id:'continued-cell-session'});
    }
    snapshot.nodes.push({ ...base, id: 'container', kind: 'note', threadId: null, assetId: null, role: null, x: 200, y: 100, width: 320, height: 260,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'images', text: '', cells: [[{ id: 'cell', text: '@图片1', content_type: 'image', image_refs: [{ token: '@图片1', asset_id: 'a' }], generation_ref: { session_node_id: 'session-first', output_node_id: 'output-a' } }]] }) });
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  const cell = page.locator('[data-canvas-cell="cell"]');
  await cell.locator('[data-conversation-image="b"]').waitFor();
  assert.equal(await page.locator('.canvas-prompt-node').count(), 0);
  await cell.hover();
  await cell.getByRole('button', { name: '上一张生成图片' }).click();
  await cell.locator('[data-conversation-image="a"]').waitFor();
  const before = await page.evaluate(() => window.snapshot().nodes.find(node => node.id === 'container').payloadJson);
  await cell.getByRole('button', { name: '下一张生成图片' }).click();
  assert.equal(await page.evaluate(() => window.snapshot().nodes.find(node => node.id === 'container').payloadJson), before, 'browsing never rewrites exact generation bindings');
  await page.screenshot({ path: '.tmp/generation-galleries/canvas-embedded.png' });
  await page.reload();
  await cell.locator('[data-conversation-image="b"]').waitFor();
  await page.evaluate(async () => {
    const snapshot = window.snapshot(), base = snapshot.nodes.find(node => node.kind === 'asset');
    const videos = ['old', 'new'].map((id, i) => ({ id: `h3-${id}`, name: `H3 ${id}`, ext: 'mp4', source: 'comfy-h3', width: 320, height: 180,
      store_path: `/h3-${id}.mp4`, thumb_path: window.store.getState().assets[0].thumb_path, created_at: i + 1 }));
    sessionStorage.setItem('reference-drafts', JSON.stringify(videos));
    snapshot.nodes = videos.map((asset, i) => ({ ...base, id: `workflow-comfy:${i}`, assetId: asset.id, x: 600 + i * 340, y: 100, width: 280, height: 158,
      createdAt: i + 1, payloadJson: JSON.stringify({ schema_version: 1, snapshot: {name:asset.name,width:320,height:180}, workflow_generation_group: 'workflow:["p","h3"]' }) }));
    snapshot.edges = []; snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision:1, document:{schema_version:1,run:null,nodes:[
      {...newWorkflowNode('comfy-video',100,100,'codex'),id:'h3',resultNodeIds:['workflow-comfy:1']}
    ]} }));
  });
  await page.reload();
  const h3 = page.locator('[data-canvas-node-id="workflow-comfy:0"]');
  await h3.locator('.generation-group-count').waitFor();
  assert.equal(await page.locator('.canvas-node.is-asset').count(), 1, 'H3 results share one material card');
  assert.equal(await h3.getAttribute('data-frequent-asset-id'), 'h3-new', 'H3 defaults to latest');
  assert.equal(await h3.locator('.generation-group-count').innerText(), '2/2');
  const wire = page.locator('[data-workflow-result-link="workflow-comfy:1"]');
  await wire.waitFor();
  const path = await wire.getAttribute('d');
  assert.match(path, /600[, ]+179/, 'H3 output wire ends at the visible gallery anchor');
  await h3.hover();
  await h3.getByRole('button', {name:'上一张生成素材'}).click();
  assert.equal(await h3.getAttribute('data-frequent-asset-id'), 'h3-old');
  await h3.focus(); await page.keyboard.press('Enter');
  const videoPreview = page.getByRole('dialog', {name:/媒体预览/});
  await videoPreview.waitFor();
  assert.equal(new URL(await videoPreview.locator('video').getAttribute('src'), page.url()).pathname, '/h3-old.mp4');
  await page.keyboard.press('Escape');
  await videoPreview.waitFor({state:'detached'});
  await h3.click({button:'right'});
  assert.equal(await page.evaluate(() => window.store.getState().contextMenu.assetId), 'h3-old');
  await page.keyboard.press('Escape');
  await h3.getByRole('button', {name:'下一张生成素材'}).focus();
  await page.keyboard.press('Enter');
  assert.equal(await h3.getAttribute('data-frequent-asset-id'), 'h3-new');
  assert.equal(await wire.getAttribute('d'), path, 'browsing does not change saved wire identity or geometry');
  await page.screenshot({path:'.tmp/generation-galleries/canvas-h3.png'});
  await page.reload();
  await h3.locator('.generation-group-count').waitFor();
  assert.equal(await h3.getAttribute('data-frequent-asset-id'), 'h3-new');
  const delivery = await page.evaluate(async () => {
    window.store.setState({cloudAuth:{logged_in:true,user_id:'tester'},cloudEntitlement:{user_id:'tester',tier:'pro',offline_state:'fresh',is_test_account:false,balances:{daily:0,sub:0,topup:0},policy:{can_use_cloud:true,can_use_byo:true},generation_services:[]}});
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'comfy_video_environment') return {phase:'ready',endpoint:'http://127.0.0.1:8188',existing:[]};
      if (command === 'comfy_video') return {status:'done',asset:window.store.getState().assets.find(asset => asset.id === 'h3-new')};
      return invoke(command, args);
    };
    const {canvasWorkflowController} = await import('/src/lib/canvasWorkflowRuntime.ts');
    const {DEFAULT_COMFY_VIDEO} = await import('/src/lib/comfyVideo.ts');
    const controller = canvasWorkflowController('p');
    await controller.edit(controller.document.nodes.map(node => ({...node,prompt:'合成测试',comfyVideo:{...DEFAULT_COMFY_VIDEO,...node.comfyVideo,mode:'text'}})));
    await controller.start('h3');
    const run = controller.document.runs.at(-1);
    const result = window.snapshot().nodes.find(node => node.id === `workflow-comfy:${run.steps.h3.jobId}`);
    return {status:run.status,source:result && JSON.parse(result.payloadJson).workflow_source,...(run.steps.h3.error ? {error:run.steps.h3.error} : {})};
  });
  assert.deepEqual(delivery, {status:'done',source:'h3'}, 'new H3 delivery persists the producer without a session node');
  for (const prefix of ['workflow-video', 'gen-output', 'agent-artifact']) {
    await page.evaluate(prefix => {
      const snapshot = window.snapshot(), base = snapshot.nodes.find(node => node.kind === 'asset');
      snapshot.nodes = ['h3-old','h3-new'].map((assetId,i) => ({...base,id:`${prefix}:${i}`,assetId,createdAt:i+1,
        role:prefix === 'agent-artifact' ? 'final' : 'output',payloadJson:JSON.stringify({schema_version:1,snapshot:{name:assetId,width:320,height:180},workflow_generation_group:'exact-producer'})}));
      sessionStorage.setItem('reference-fixture',JSON.stringify(snapshot));
      sessionStorage.removeItem('workflow-p');
    },prefix);
    await page.reload();
    const gallery = page.locator(`[data-canvas-node-id="${prefix}:0"]`);
    await gallery.locator('.generation-group-count').waitFor();
    assert.equal(await page.locator('.canvas-node.is-asset').count(),1,`${prefix} has one visible gallery`);
    assert.equal(await gallery.getAttribute('data-frequent-asset-id'),'h3-new');
    await gallery.hover();
    await gallery.getByRole('button',{name:'上一张生成素材'}).click();
    assert.equal(await gallery.getAttribute('data-frequent-asset-id'),'h3-old');
    await page.screenshot({path:`.tmp/generation-galleries/canvas-${prefix}.png`});
  }
  for (const prefix of ['gen-output', 'agent-artifact']) {
    await page.evaluate(prefix => {
      const snapshot = window.snapshot(), base = snapshot.nodes.find(node => node.kind === 'asset');
      snapshot.nodes = ['a','b'].map((assetId,i) => ({...base,id:`${prefix}:${i}`,assetId,createdAt:i+1,x:400+i*280,y:100,width:220,height:174,
        role:prefix === 'agent-artifact' ? 'final' : 'output',payloadJson:JSON.stringify({schema_version:1,snapshot:{name:assetId,width:190,height:150},execution:{job_id:'agent-tool',turn_key:'turn'},workflow_generation_group:`asset:${prefix}:${i}`})}));
      if (prefix === 'gen-output') snapshot.nodes.push({...base,id:'gen-prompt:agent-tool:turn:0',kind:'prompt',assetId:null,role:null,
        payloadJson:JSON.stringify({schema_version:1,job_id:'agent-tool',turn_key:'turn',status:'done',text:'Agent images',workflow_generation_group:'asset:gen-prompt:agent-tool:turn:0'})});
      sessionStorage.setItem('reference-fixture',JSON.stringify(snapshot));
    },prefix);
    await page.reload();
    await page.locator(`[data-canvas-node-id="${prefix}:1"]`).waitFor();
    assert.equal(await page.locator('.canvas-node.is-asset').count(),2,`${prefix} Agent images stay individually visible`);
    assert.equal(await page.locator('.canvas-node .generation-group-count').count(),0);
    assert.equal(await page.locator('.canvas-prompt-node').count(),0);
    for (const [i,assetId] of ['a','b'].entries()) {
      const card = page.locator(`[data-canvas-node-id="${prefix}:${i}"]`);
      assert.equal(await card.getAttribute('data-frequent-asset-id'),assetId);
      await card.click({button:'right'});
      assert.equal(await page.evaluate(() => window.store.getState().contextMenu.assetId),assetId);
      await page.keyboard.press('Escape');
    }
    await page.screenshot({path:`.tmp/generation-galleries/agent-individual-${prefix}.png`});
  }
  assert.deepEqual(errors, []);
  console.log('generation galleries: library provenance, workflow repeats, embedded continuation, H3 delivery/wire/preview, video, HyperFrames and individual Agent images passed');
} finally { await browser.close(); await server.close(); }
