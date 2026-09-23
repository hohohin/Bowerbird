import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1616,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1616/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
    console.log(await page.evaluate(async()=>{
      const {api}=await import('/src/lib/api.ts');
      const {CanvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
      const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
      const {useStore}=await import('/src/store.ts');
      const check=(value,message)=>{if(!value)throw Error(message);};
      const base=window.snapshot().nodes[0],history=api.generationHistory;
      let upstreamCalls=0,requests=[];
      api.generationHistory=async(...args)=>{upstreamCalls++;return history(...args);};
      api.localAgentFindAssetId=async()=> 'existing';
      useStore.setState({startGeneration:async(...args)=>{
        requests.push({prompt:args[0],assets:args[1].map(asset=>asset.id)});
        const identity=args[12];
        useStore.setState(s=>({genJobs:{...s.genJobs,[identity.jobId]:{turns:[{turnKey:identity.turnKey,images:['existing.png']}]}}}));
        return {accepted:true};
      }});
      for(const kind of ['generation','agent'])for(const type of ['text','image'])for(const whole of [false,true])for(const mode of ['fill','empty','missing','disconnected']){
        if(kind==='agent'&&(type==='image'||mode==='fill'))continue;
        upstreamCalls=0;requests=[];
        const name=`reference-${kind}-${type}-${whole}-${mode}`,tableId=name+'-table';
        await api.projectCanvasNodeCreate({...base,id:tableId,kind:'note',role:null,assetId:null,payloadJson:JSON.stringify({schema_version:1,note_type:'text',text:'',member_ids:[],cells:[[{id:'value',content_type:type,text:'  ',image_refs:[]}]]})});
        const input={canvasNodeId:mode==='missing'?name+'-deleted':tableId,cellId:whole?(type==='image'?'*':'*text'):'value'};
        const upstream={...newWorkflowNode('instruction',0,0,'codex'),id:'upstream',action:'reuse',inputs:{image:[{assetId:'existing'}]}};
        const directType=kind==='agent'?'text':'image',direct={nodeId:'upstream',portId:directType};
        const consumer={...newWorkflowNode(kind,800,0,'codex'),id:'consumer',prompt:'使用 @[upstream] 和 @[cell]',
          inputs:{text:[],image:[],[directType]:[direct]},
          promptReferences:[{id:'upstream',type:directType,input:direct,label:'上游内容'},{id:'cell',type,input,label:'单元格内容'}]};
        if(mode!=='disconnected')consumer.inputs[type].push(input);
        // Keep an ambiguous pair so a disconnected image reference cannot be rebound to the sole remaining input.
        else if(type==='image')consumer.inputs.image.push({assetId:'a'});
        const writer={...newWorkflowNode('text',400,0,''),id:'writer',textTarget:{nodeId:tableId,cellId:'value',image:type==='image'},inputs:{[type]:[{nodeId:'upstream',portId:type}]}};
        const c=new CanvasWorkflowController(name);await c.load();
        await c.edit([upstream,...(mode==='fill'?[writer]:[]),consumer]);
        await c.start('upstream');
        check(upstreamCalls===1&&c.document.run.steps.upstream.status==='done',name+': upstream must run first');
        check(JSON.stringify(c.document.nodes.find(n=>n.id==='consumer').promptReferences[1].input)===JSON.stringify(input),name+': reference identity must not change');
        if(mode==='fill'){
          check(c.document.run.status==='done'&&requests.length===1,name+': initially empty cell should be filled before consumption');
          if(type==='text')check(requests[0].prompt.includes('保持产品主体'),name+': prompt uses freshly written text');
          else check(requests[0].assets.includes('existing'),name+': prompt uses freshly written image');
        }else{
          check(c.document.run.status==='failed'&&c.document.run.steps.consumer.status==='failed'&&requests.length===0,name+': failure must occur at consumer before model submission');
          check(c.issue?.nodeId==='consumer'&&c.issue.phase==='execution'&&c.issue.referenceLabel==='单元格内容',name+': diagnostic must name consumer and reference');
        }
      }
      for(const missing of [false,true]){
        upstreamCalls=0;
        const name='reference-instruction-'+missing;
        const upstream={...newWorkflowNode('instruction',0,0,'codex'),id:'upstream',action:'reuse',inputs:{image:[{assetId:'existing'}]}};
        const source={canvasNodeId:missing?'removed-card':'empty-instruction-source',cellId:'*'};
        if(!missing)await api.projectCanvasNodeCreate({...base,id:source.canvasNodeId,kind:'note',role:null,assetId:null,payloadJson:JSON.stringify({schema_version:1,note_type:'text',text:'',member_ids:[],cells:[[{id:'empty',content_type:'image',text:'',image_refs:[]}]]})});
        const consumer={...newWorkflowNode('instruction',400,0,'codex'),id:'consumer',inputs:{image:[{nodeId:'upstream',portId:'image'},source]}};
        const c=new CanvasWorkflowController(name);await c.load();await c.edit([upstream,consumer]);await c.start('upstream');
        check(upstreamCalls===1&&c.document.run.steps.upstream.status==='done'&&c.document.run.steps.consumer.status==='failed',name+': missing instruction input must not block upstream');
        check(c.issue?.phase==='execution'&&c.issue.source?.canvasNodeId===source.canvasNodeId,name+': source diagnosis');
      }
      return 'cell references: text/image cells and whole cards, initially empty then filled, still empty, deleted source and disconnected reference; upstream completion, identity preservation and consumer-only failure passed';
    }));
  assert.deepEqual(errors,[]);
}finally{await browser.close();await server.close();}
