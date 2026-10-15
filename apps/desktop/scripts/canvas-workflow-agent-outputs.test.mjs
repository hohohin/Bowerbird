import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const production = process.env.BOWERBIRD_WORKFLOW_PRODUCTION === '1';
const server = await createServer({ define: production ? { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' } : undefined, configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1652, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
try {
  await page.goto('http://127.0.0.1:1652/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const c = canvasWorkflowController('p'); await c.load();
    const base = window.snapshot().nodes[0];
    await api.projectCanvasNodeCreate({ ...base, id: 'classification', kind: 'note', role: null, assetId: null, x: 750, y: 350, width: 400, height: 400,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', title: '分类结果', text: '', member_ids: [], cells:
        ['copy','product','explanation','untouched'].map(id => [{ id, text: `保留 ${id}` }, { id: `${id}-neighbor`, text: '邻格' }]) }) });
    const agent = { ...newWorkflowNode('agent', 300, 300, ''), id: 'agent', agentTransport: 'codex-cli', prompt: '判断图层类型：', inputs: { image: [{ assetId: 'a' }, { assetId: 'b' }] } };
    const writers = ['copy','product','explanation','untouched'].map((cellId,i) => ({ ...newWorkflowNode('text',0,0,''), id: `writer-${cellId}`,
      textTarget: { nodeId: 'classification', cellId, image: i !== 2 }, inputs: { [i === 2 ? 'text' : 'image']: [{ nodeId: agent.id, portId: i === 2 ? 'text' : 'image' }] } }));
    await c.edit([agent,...writers]);
    await c.save({ ...c.document, cardNames: { ...c.document.cardNames, classification: '分类结果' } });
    window.save();
  });
  await page.reload();
  const editor = page.getByRole('textbox', { name: 'Agent 要求' }); await editor.waitFor();
  for (const [row,text] of [[1,'文案图片输出到'],[2,'，产品图片输出到'],[3,'，判断说明输出到']]) {
    await editor.press('End'); await editor.pressSequentially(`${text}@`);
    const menu = page.getByRole('listbox', { name: '收到的内容' }); await menu.waitFor();
    await menu.getByRole('option').filter({ hasText: `输出 · 分类结果 · 第 ${row} 行 · 第 1 列` }).click();
  }
  assert.equal(await editor.locator('[data-reference-id]').count(),3);
  await page.reload(); await editor.waitFor();
  assert.equal(await editor.locator('[data-reference-id]').count(),3);
  assert.match(await editor.innerText(), /第 3 行/);
  await mkdir('.tmp/workflow',{recursive:true});
  await page.screenshot({path:'.tmp/workflow/agent-output-references.png'});
  console.log(await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController, CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { agentOutputTargets } = await import('/src/lib/workflowAgentOutputs.ts');
    const { cloneCanvasClipboard } = await import('/src/lib/canvasClipboard.ts');
    const check = (ok,message) => { if(!ok) throw Error(message); };
    const c = canvasWorkflowController('p'); await c.load();
    let submissions=0, imported=0, ready=true, bad=false, empty=false;
    api.agentDsWorkflowGenerationRequest = async () => null;
    api.codexCreateImage = async () => { throw Error('classification must not generate'); };
    api.agentDsWorkflowIngestImages = async () => { imported++; return []; };
    api.agentDsWorkflowStart = async (_id,instruction,source,_purpose,images) => {
      submissions++;
      check(instruction.includes('output1') && !instruction.includes('@['),'output references compile separately from input pipes');
      check(JSON.parse(source).__outputTargets.length===3 && images.length===2,'contract and input attachment order supplied');
      return {autoDelivered:true,path:'synthetic'};
    };
    api.agentDsWorkflowResult = async requestId => ready ? {schemaVersion:1,requestId,text:JSON.stringify({format:'bowerbird-deliveries',deliveries:[
      {target:'output1',inputImages:empty?[]:[2]},
      {target:bad?'unknown':'output2',inputImages:[1]},
      {target:'output3',text:'图层 2 属于文案；图层 1 属于产品。'},
    ]})} : null;
    const cells = () => JSON.parse(window.snapshot().nodes.find(node=>node.id==='classification').payloadJson).cells;
    await c.start('agent',true);
    check(c.document.run.status==='done',JSON.stringify(c.issue));
    check(cells()[0][0].image_refs[0].asset_id==='b' && cells()[1][0].image_refs[0].asset_id==='a','images go to separate fixed rows');
    check(cells()[2][0].text==='图层 2 属于文案；图层 1 属于产品。' && cells()[3][0].text==='保留 untouched','text assignment and unmentioned target protection');
    check(cells().every(row=>row[1].text==='邻格') && cells().length===4 && imported===0,'no new rows, image generation, image import or neighbor overwrite');
    const beforeBad=JSON.stringify(cells()); bad=true; await c.start('agent',true);
    check(c.document.run.status==='failed' && JSON.stringify(cells())===beforeBad,'invalid assignment cannot partially write');
    bad=false; empty=true; await c.start('agent',true);
    check(c.document.run.status==='done' && !cells()[0][0].image_refs.length && !cells()[0][0].text,'empty category clears previous image');
    empty=false;
    // Simulate failure after the native cell write succeeded, before the writer completed.
    const update=api.projectCanvasNoteUpdate; let failOnce=true;
    api.projectCanvasNoteUpdate=async (...args)=>{ await update(...args); if(failOnce){failOnce=false;throw Error('synthetic interrupted write');} };
    await c.start('agent',true);
    check(c.document.run.status==='waiting' && c.document.run.steps.agent.status==='done','delivery failure preserves completed model assignment');
    const beforeRecovery=submissions; api.projectCanvasNoteUpdate=update;
    const recovered=new CanvasWorkflowController('p');await recovered.load();await recovered.continue();
    check(recovered.document.run.status==='done' && submissions===beforeRecovery,'reload retries only cell writing');
    check(cells()[0][0].image_refs[0].asset_id==='b' && cells()[1][0].image_refs[0].asset_id==='a','recovery keeps exact row assignments');
    // Recovery while the model is still running uses frozen targets and the same request.
    const saved=structuredClone(recovered.document); saved.run.status='running';saved.run.steps.agent.status='running';
    for(const id of ['writer-copy','writer-product','writer-explanation','writer-untouched'])saved.run.steps[id]={status:'pending'};
    saved.runs=saved.runs.map(run=>run.id===saved.run.id?saved.run:run);
    sessionStorage.setItem('workflow-output-pending',JSON.stringify({revision:1,document:saved}));
    const pending=new CanvasWorkflowController('output-pending');await pending.load();await pending.continue();
    check(pending.document.run.status==='done' && submissions===beforeRecovery,'pending model recovers without resubmitting or losing targets');
    const note=window.snapshot().nodes.find(node=>node.id==='classification');
    const clone=cloneCanvasClipboard({projectId:'p',nodes:[note],groups:[],items:[],workflow:recovered.document.nodes,selection:['agent','classification']},'copy-project',0,0);
    const clonedAgent=clone.workflow.find(node=>node.kind==='agent');
    const clonedTargets=agentOutputTargets(clonedAgent,clone.workflow);
    check(clonedTargets.length===3 && clonedTargets.every(target=>target.nodeId!==note.id),'copy remaps targets to copied card');
    await recovered.edit(recovered.document.nodes.filter(node=>node.id!=='writer-copy'));
    let disconnected;
    try { await recovered.start('agent',true); } catch(error) { disconnected=error.message; }
    check(submissions===beforeRecovery && disconnected?.includes('已断开'),'disconnected output is blocked before model submission');
    return `PASS output @ menu/reload, fixed-row classification, empty clearing, validation, no generation, copy and both recovery paths (${submissions} submissions)`;
  }));
} finally { await browser.close(); await server.close(); }
