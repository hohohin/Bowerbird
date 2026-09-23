import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1589, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
try {
  await page.goto('http://127.0.0.1:1589/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const containerId = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const c = canvasWorkflowController('p'); await c.load();
    const dataUrl = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
    const document = { schemaVersion: 1, width: 8, height: 8, layers: [0, 1].map(i => ({ id: `l${i}`, name: `图层${i}`, dataUrl, x: 0, y: 0, width: 8, height: 8, opacity: 1, visible: true, background: i === 0 })) };
    api.layerWorkspaceLoad = async () => ({ document });
    api.layerExport = async (_id, doc) => ({ id: doc.layers[0].visible ? 'a' : 'b' });
    const split = { ...newWorkflowNode('instruction', 1600, 1000, 'codex'), id: 'terminal-split', action: 'layers', inputs: { image: [{ assetId: 'existing' }] } };
    await c.edit([split]); await c.start(split.id, true);
    if (c.document.run.status !== 'done') throw new Error(JSON.stringify(c.document.run));
    window.layerController=c; window.originalLayerExport=api.layerExport;
    return c.document.nodes[0].resultNodeIds[0];
  });
  const folder = page.locator(`[data-canvas-node-id="${containerId}"]`);
  await folder.waitFor();
  await folder.locator('[role="cell"] img').first().waitFor();
  assert.equal(await folder.locator('[role="cell"] img').count(), 2);
  assert.equal(await folder.getByRole('cell').count(), 2);
  assert.equal(await folder.getByRole('row').count(), 1);
  assert.equal(await page.locator('[data-workflow-card="terminal-split"] .workflow-port.is-output').count(),1);
  const bounds = await folder.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1600 && bounds.y + bounds.height <= 1000, 'products are revealed within the viewport');
  await page.evaluate(async () => { const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts'); await canvasWorkflowController('p').start('terminal-split', true); });
  assert.equal(await page.evaluate(id => window.snapshot().nodes.filter(item => item.id === id).length, containerId), 1);
  assert.equal(await page.evaluate(()=>window.snapshot().nodes.filter(item=>item.id.startsWith('workflow-layer:')).length),0);
  assert.equal(await page.evaluate(()=>window.snapshot().groups.length),0);
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts'); const c=window.layerController;
    api.layerExport=async(_id,doc)=>({id:doc.layers[0].visible?'c':'d'});
    const before=window.snapshot().nodes.find(n=>n.id===c.document.nodes[0].resultNodeIds[0]);window.cellId=JSON.parse(before.payloadJson).cells[0][0].id;
    await c.start('terminal-split',true);
    const after=window.snapshot().nodes.find(n=>n.id===before.id),resultCells=JSON.parse(after.payloadJson).cells.flat(),cell=resultCells[0];
    if(cell.id!==window.cellId||resultCells.map(cell=>cell.image_refs[0].asset_id).join(',')!=='c,d'||resultCells.some(cell=>cell.image_refs.length!==1))throw Error('rerun replaces separate images preserving cell identity');
    const legacyNote=JSON.parse(after.payloadJson);
    legacyNote.cells=[[{...cell,image_refs:[{asset_id:'a',token:'@图片1'},{asset_id:'b',token:'@图片2'}]}]];
    await api.projectCanvasNoteUpdate(after.id,JSON.stringify(legacyNote));
    await c.start('terminal-split',true);
    const migrated=JSON.parse(window.snapshot().nodes.find(node=>node.id===after.id).payloadJson).cells.flat();
    if(migrated.length!==2||migrated[0].id!==window.cellId||migrated.some(cell=>cell.image_refs.length!==1))throw Error('legacy multi-image cell migrates to separate slots');
    // Auto-container outputs participate in ordering and read this run, not the previous contents.
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const next={...newWorkflowNode('instruction',2100,1000,'codex'),id:'relay',action:'describe',inputs:{image:[{canvasNodeId:before.id,cellId:'*'}]}};
    api.listAnalysesByAsset=async id=>[{id:'caption-'+id,kind:'caption',created_at:1,payload:JSON.stringify({sections:[{title:'图',body:id}]})}];
    await c.edit([...c.document.nodes,next]);await c.start('terminal-split');
    if(c.document.run.status!=='done'||!c.document.run.order.includes('relay'))throw Error('auto container relays downstream: '+JSON.stringify(c.document.run));
    // Explicit cell input keeps other cells and suppresses automatic container creation.
    const base=before;await api.projectCanvasNodeCreate({...base,id:'explicit-images',payloadJson:JSON.stringify({schema_version:1,note_type:'images',text:'',cells:[[{id:'keep',text:'',image_refs:[{asset_id:'existing',token:'@图片1'}]},{id:'target',text:''}]],member_ids:[]})});
    const split={...newWorkflowNode('instruction',500,500,'codex'),id:'explicit-split',action:'layers',inputs:{image:[{assetId:'existing'}]}};
    await c.edit([...c.document.nodes,split]);await c.bindTextInput('explicit-images','target',{nodeId:split.id,portId:'image'},'image');
    await c.start(split.id,true);
    const cells=JSON.parse(window.snapshot().nodes.find(n=>n.id==='explicit-images').payloadJson).cells[0];
    if(cells[0].image_refs[0].asset_id!=='existing'||cells[1].image_refs.length!==2||c.document.nodes.find(n=>n.id===split.id).resultNodeIds.length)throw Error('explicit container fill');
    const writer=c.document.nodes.find(n=>n.textTarget?.nodeId==='explicit-images');
    if(!c.document.run.writeNodeIds.includes(writer.id))throw Error('single split reserves explicit container writer');
    // A surviving table can contain stale writers for removed cells, including text siblings.
    const sibling={...newWorkflowNode('text',0,0,''),id:'stale-sibling',textTarget:{nodeId:'explicit-images',cellId:'deleted-text'},inputs:{text:[{nodeId:'relay',portId:'text'}]}};
    await c.edit([...c.document.nodes,sibling]);
    const remaining=JSON.parse(window.snapshot().nodes.find(node=>node.id==='explicit-images').payloadJson);
    remaining.cells=[remaining.cells[0].slice(0,1)];
    await api.projectCanvasNoteUpdate('explicit-images',JSON.stringify(remaining));
    await c.start(split.id,true);
    if(c.document.run.status!=='done'||c.document.nodes.some(node=>node.id===writer.id||node.id===sibling.id))throw Error('missing output cells and sibling writers block split');
    if(JSON.parse(window.snapshot().nodes.find(node=>node.id==='explicit-images').payloadJson).cells[0][0].image_refs[0].asset_id!=='existing')throw Error('surviving contents changed');
    // Reconnect the main input to exercise whole-table removal as well.
    await c.bindTextInput('explicit-images',undefined,{nodeId:split.id,portId:'image'},'image');
    // Removing a destination must not invalidate the split's source image.
    await api.projectCanvasNodeRemove('explicit-images');
    await c.start(split.id,true);
    if(c.document.run.status!=='done'||c.document.nodes.some(node=>node.id===writer.id))throw Error('deleted output writer blocks rerun');
    const recoveredId=c.document.nodes.find(node=>node.id===split.id).resultNodeIds[0];
    const recovered=JSON.parse(window.snapshot().nodes.find(node=>node.id===recoveredId).payloadJson);
    if(recovered.cells.flat().length!==2||recovered.cells.flat().some(cell=>cell.image_refs.length!==1))throw Error('deleted explicit target replaced by split image grid');
    await api.projectCanvasNodeRemove(recoveredId);
    await c.start(split.id,true);
    const replacement=c.document.nodes.find(node=>node.id===split.id).resultNodeIds[0];
    if(c.document.run.status!=='done'||replacement===recoveredId||!window.snapshot().nodes.some(node=>node.id===replacement&&node.hiddenAt==null))throw Error('deleted auto target recreated');
    const deletedInput={canvasNodeId:replacement,cellId:'*'};
    const downstream={...newWorkflowNode('instruction',0,0,'codex'),id:'deleted-relay',action:'describe',inputs:{image:[deletedInput]}};
    const reference={...newWorkflowNode('generation',0,0,'codex'),id:'deleted-reference',prompt:'unused',inputs:{image:[deletedInput]},promptReferences:[{id:'deleted-ref',type:'image',input:deletedInput,label:'产物'}]};
    await c.edit([...c.document.nodes,downstream,reference]);
    await api.projectCanvasNodeRemove(replacement);
    await c.start(split.id);
    if(c.document.run.status!=='done'||!c.document.run.order.includes(downstream.id))throw Error('deleted auto relay blocks full flow');
    if(c.document.nodes.find(node=>node.id===reference.id).promptReferences[0].input.nodeId!==split.id)throw Error('inline references not forwarded');
    // Also repair an old auto result ID after resultNodeIds already points to its replacement.
    await c.edit(c.document.nodes.map(node=>node.id===downstream.id?{...node,inputs:{image:[deletedInput]}}:node));
    await c.start(split.id);
    if(c.document.run.status!=='done')throw Error('historical deleted result relay blocks rerun');
    // Real-board shape: a generation has a live image connection, but its active
    // prompt token still names another, permanently deleted table of unknown origin.
    const lost={canvasNodeId:'deleted-unknown-origin',cellId:'*'};
    await api.projectCanvasNodeCreate({...before,id:'deferred-images',payloadJson:JSON.stringify({schema_version:1,note_type:'text',text:'',member_ids:[],cells:[[{id:'deferred-cell',content_type:'image',text:''}]]})});
    await c.bindTextInput('deferred-images','deferred-cell',{nodeId:split.id,portId:'image'},'image');
    const blank=JSON.parse(window.snapshot().nodes.find(node=>node.id==='deferred-images').payloadJson);
    blank.cells[0][0].image_refs=[];blank.cells[0][0].text='';
    await api.projectCanvasNoteUpdate('deferred-images',JSON.stringify(blank));
    const dangling={...newWorkflowNode('generation',0,0,'codex'),id:'dangling-prompt',prompt:'参考 @[lost]',inputs:{image:[lost,{canvasNodeId:'deferred-images',cellId:'*'}]},promptReferences:[{id:'lost',type:'image',input:lost,label:'图片来源 1'}]};
    await c.edit([...c.document.nodes,dangling]);
    const {useStore}=await import('/src/store.ts');window.deferredSent=[];
    api.localAgentFindAssetId=async()=> 'existing';
    useStore.setState({startGeneration:async(...args)=>{window.deferredSent.push(args[1].map(asset=>asset.id));const identity=args[12];useStore.setState(state=>({genJobs:{...state.genJobs,[identity.jobId]:{turns:[{turnKey:identity.turnKey,images:['existing.png']}]}}}));return {accepted:true};}});
    await c.start(split.id);
    if(c.document.run.status!=='done'||window.deferredSent[0]?.join(',')!=='c,d')throw Error('empty container must be filled before generation reads its reference: '+JSON.stringify(c.document.run));
    api.layerExport=async(_id,doc)=>({id:doc.layers[0].visible?'a':'b'});
    await c.start(split.id);
    if(c.document.run.status!=='done'||window.deferredSent[1]?.join(',')!=='a,b'||c.document.nodes.find(node=>node.id===dangling.id).prompt!==dangling.prompt)throw Error('same prompt must read new run images');
    // Legacy per-layer bindings and inline references upgrade together.
    const legacy={...split,id:'legacy',outputPorts:[{id:'layer-old',label:'old',type:'image'}],outputs:{image:{type:'image',assetIds:['a','b']},'layer-old':{type:'image',assetIds:['a']}}};
    const binding={nodeId:'legacy',portId:'layer-old'};
    const gen={...newWorkflowNode('generation',0,0,'codex'),id:'legacy-target',prompt:'@[ref]',inputs:{image:[binding]},promptReferences:[{id:'ref',type:'image',input:binding,label:'old',assetId:'a'}]};
    const {CanvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const old=new CanvasWorkflowController('legacy-layer');await old.load();await old.edit([legacy,gen]);const reload=new CanvasWorkflowController('legacy-layer');await reload.load();
    if(reload.document.nodes[1].inputs.image[0].portId!=='image'||reload.document.nodes[1].promptReferences[0].input.portId!=='image'||reload.document.nodes[0].outputPorts.length)throw Error('legacy layer upgrade');
    window.save();
  });
  await page.reload();await folder.waitFor();
  await folder.locator('[role="cell"] img').first().waitFor();
  assert.equal(await folder.locator('[role="cell"] img').count(),2);
  await page.screenshot({ path: '.tmp/workflow/layer-products-revealed.png' });
  console.log('layers: one output, auto container, focus, no element nodes, rerun replacement, container relay, explicit cell fill/locks, legacy wires and reload passed');
} finally { await browser.close(); await server.close(); }
