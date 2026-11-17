import assert from "node:assert/strict";
import {createServer} from "vite";
import {chromium} from "../../html-renderer/node_modules/playwright/index.mjs";
const server=await createServer({cacheDir:".tmp/h3-delete-vite",optimizeDeps:{entries:["scripts/fixtures/canvas-reference/preview.html"]},server:{host:"127.0.0.1",port:1655,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:"chrome",headless:true});
const page=await browser.newPage({viewport:{width:1500,height:1000}});
try{
 await page.goto("http://127.0.0.1:1655/scripts/fixtures/canvas-reference/preview.html");
 await page.locator('[data-canvas-node-id="old"]').waitFor();
 for(const kind of ["done","failed"]){
  await page.evaluate(async kind=>{
   const s=window.snapshot(),base=s.nodes[0];
   const prompt={...base,id:"h3-session",kind:"prompt",assetId:null,role:null,hiddenAt:null,x:300,y:150,payloadJson:JSON.stringify({schema_version:1,text:"H3 测试",job_id:"h3-job",turn_key:"turn",provider:"minimax-h3-image",status:kind,workflow_generation_group:"producer"})};
   const output={...base,id:"gen-output:h3-job:turn:0",kind:"asset",assetId:"a",role:"output",hiddenAt:null,x:300,y:150,payloadJson:JSON.stringify({schema_version:1,workflow_generation_group:"producer",workflow_source:"producer",source_node_id:"producer",execution:{job_id:"h3-job",turn_key:"turn"},snapshot:{name:"H3 结果",width:190,height:150}})};
   s.nodes=kind==="output"?[output]:kind==="done"?[prompt,output]:[prompt];
   s.edges=kind==="done"?[{id:"produced",projectId:"p",kind:"produced",fromNodeId:prompt.id,toNodeId:output.id,ordinal:0,createdAt:1}]:[];
   s.groups=[];s.groupItems=[];s.view={...s.view,panX:0,panY:0,zoom:1};
   sessionStorage.setItem("reference-fixture",JSON.stringify(s));
   const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
   const producer={...newWorkflowNode('generation',850,100,'minimax-h3-image'),id:'producer',activeSessionNodeId:'h3-session',sessionNodeIds:['h3-session']};
   sessionStorage.setItem('workflow-p',JSON.stringify({revision:0,document:{schema_version:1,nodes:[producer],run:null}}));
  },kind);
  await page.reload();
  const id=kind==="output"?"gen-output:h3-job:turn:0":"h3-session";
  const card=page.locator('[data-canvas-node-id="'+id+'"]');
  await card.waitFor(); await card.click({position:{x:90,y:100},modifiers:["Control"]});
  await page.waitForFunction(id=>document.querySelector('[data-canvas-node-id="'+id+'"]')?.classList.contains("is-selected"),id);
  if (kind === "done") {
   await page.evaluate(async () => {
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller=canvasWorkflowController('p');
    const run={id:'busy',status:'running',order:['producer'],lockedNodeIds:['producer','h3-session'],writeNodeIds:['h3-session'],steps:{producer:{status:'running'}}};
    controller.document={...controller.document,run,runs:[run]};
   });
   await page.keyboard.press('Delete');
   assert.equal(await card.count(),1);
   await page.evaluate(async () => {
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller=canvasWorkflowController('p');
    controller.document={...controller.document,run:null,runs:[]};
   });
  }
  await page.keyboard.press("Delete");
  await card.waitFor({state:"detached",timeout:5000});
  await page.waitForFunction(()=>window.snapshot().nodes.every(n=>n.hiddenAt!=null));
  await page.keyboard.press("Control+z");await card.waitFor();
  console.log("PASS H3",kind);
 }
}finally{await browser.close();await server.close();}
