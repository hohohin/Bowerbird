import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1604,strictPort:true,hmr:false,watch:null}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:1604/scripts/fixtures/canvas-reference/preview.html');await page.locator('[data-canvas-node-id="old"]').waitFor();
  console.log(await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');const {useStore}=await import('/src/store.ts');
    const {CanvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const check=(v,m)=>{if(!v)throw Error(m);};
    const until=async(fn,message)=>{for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error(message);};
    const trigger={...newWorkflowNode('trigger',0,0,'codex'),id:'key'};
    const gen=(id,refs=[])=>({...newWorkflowNode('generation',0,0,'codex'),id,
      prompt:id+refs.map((_,i)=>` @[r${i}]`).join(''),inputs:{image:refs,signal:[{nodeId:'key',portId:'signal'}]},
      promptReferences:refs.map((input,i)=>({id:`r${i}`,type:'image',input,label:`来源${i}`}))});
    const from=id=>({nodeId:id,portId:'image'});
    let submissions=[],release=new Map(),cancelled=[],c;
    const reset=()=>{submissions=[];release=new Map();cancelled=[];};
    const create=async(name,nodes)=>{reset();c=new CanvasWorkflowController(name);await c.load();await c.edit(nodes);return c;};
    api.localAgentFindAssetId=async path=>path==='A.png'?'a':path==='B.png'?'b':'c';
    api.cancelCodexCreate=async id=>{cancelled.push(id);};
    useStore.setState({startGeneration:async(...args)=>{
      const name=args[0].split(' ')[0],identity=args[12];
      const persisted=JSON.parse(sessionStorage.getItem(`workflow-${c.projectId}`)).document;
      check(persisted.run.steps[name].jobId===identity.jobId,'identity persisted before submit');
      submissions.push({name,identity,assets:args[1].map(a=>a.id)});
      const fail=await new Promise(resolve=>release.set(name,resolve));
      if(fail)return {accepted:false,error:'branch failed'};
      useStore.setState(s=>({genJobs:{...s.genJobs,[identity.jobId]:{turns:[{turnKey:identity.turnKey,images:[name+'.png']}]}}}));
      return {accepted:true};
    }});
    const writer=(id,cell,source)=>({...newWorkflowNode('text',0,0,''),id,textTarget:{nodeId:'shared',cellId:cell,image:true},inputs:{image:[from(source)]}});
    const base=window.snapshot().nodes[0];
    await api.projectCanvasNodeCreate({...base,id:'shared',kind:'note',assetId:null,role:null,threadId:null,payloadJson:JSON.stringify({schema_version:1,note_type:'text',text:'',member_ids:[],cells:[['left','right'].map(id=>({id,text:'',bold:false,italic:false,align:'left',content_type:'image'}))]})});
    const noteUpdate=api.projectCanvasNoteUpdate;let writes=0,maxWrites=0;
    api.projectCanvasNoteUpdate=async(...args)=>{writes++;maxWrites=Math.max(maxWrites,writes);await new Promise(r=>setTimeout(r,30));try{return await noteUpdate(...args);}finally{writes--;}};
    const nodes=[trigger,gen('A'),gen('B'),gen('child',[from('A')]),writer('wa','left','A'),writer('wb','right','B'),gen('join',[{canvasNodeId:'shared',cellId:'*'}])];
    await create('scheduler-fork',nodes);let running=c.start('key');
    await until(()=>submissions.length===2,'both independent branches must start before either finishes');
    check(c.document.run.steps.A.status==='running'&&c.document.run.steps.B.status==='running','parallel status');
    release.get('A')();
    await until(()=>release.has('child'),'fast branch downstream starts while B is still running');
    check(!release.has('join'),'join must wait for both content writers');
    release.get('child')();release.get('B')();
    await until(()=>release.has('join'),'join starts after both branches');
    check(submissions.find(s=>s.name==='join').assets.join(',')==='a,b','join reads both current outputs');
    release.get('join')();await running;
    check(c.document.run.status==='done'&&submissions.length===4,'once-only completion');
    // Complete both parents in the same tick to exercise read-modify-write exclusion.
    await create('scheduler-writes',[trigger,gen('A'),gen('B'),writer('wa','left','A'),writer('wb','right','B')]);running=c.start('key');
    await until(()=>submissions.length===2,'writers parents start');release.get('A')();release.get('B')();await running;
    const cells=JSON.parse((await api.projectCanvasGet(c.projectId)).nodes.find(n=>n.id==='shared').payloadJson).cells.flat();
    check(maxWrites===1&&cells[0].image_refs[0].asset_id==='a'&&cells[1].image_refs[0].asset_id==='b','concurrent writes retain both cells');

    // The screenshot's two describe branches can also run and advance independently.
    useStore.setState({defaultUnderstandProvider:'bowerbird-cloud'});
    const descriptions=new Map();
    api.describeAsset=async id=>{await new Promise(resolve=>descriptions.set(id,resolve));return 'analysis-'+id;};
    api.listAnalysesByAsset=async id=>[{id:'analysis-'+id,kind:'caption',payload:JSON.stringify({sections:[{title:'提示词',body:id}]})}];
    const describe=(id,asset)=>({...newWorkflowNode('instruction',0,0,'codex'),id,action:'describe',overwriteDescribe:true,inputs:{image:[{assetId:asset}],signal:[{nodeId:'key',portId:'signal'}]}});
    const textInput={nodeId:'describe-a',portId:'text'};
    const textChild={...gen('child'),prompt:'child @[text]',inputs:{text:[textInput]},promptReferences:[{id:'text',type:'text',input:textInput,label:'反推'}]};
    await create('scheduler-describe',[trigger,describe('describe-a','a'),describe('describe-b','b'),textChild]);running=c.start('key');
    await until(()=>descriptions.size===2,'both describe branches submitted');descriptions.get('a')();
    await until(()=>release.has('child'),'describe fast branch advances while other describe is pending');
    check(c.document.run.steps['describe-b'].status==='running','other describe still running');
    release.get('child')();descriptions.get('b')();await running;check(c.document.run.status==='done','describe branches complete');

    let confirmed=false;
    api.visualProfileGet=async()=>({id:'profile-result',status:confirmed?'confirmed':'draft',version:1,summary:'规范'});
    const profile={...newWorkflowNode('visual-profile',0,0,'codex'),id:'profile',profileId:'profile-result',inputs:{signal:[{nodeId:'key',portId:'signal'}]}};
    const profileChild={...gen('child'),inputs:{'visual-profile':[{nodeId:'profile',portId:'visual-profile'}]}};
    await create('scheduler-approval',[trigger,profile,gen('A'),profileChild]);running=c.start('key');
    await until(()=>release.has('A')&&c.document.run.steps.profile.status==='waiting','approval does not block independent generation');
    release.get('A')();await running;check(!release.has('child'),'approval blocks only its own consumer');
    confirmed=true;running=c.continue();await until(()=>release.has('child'),'confirmed profile resumes consumer');release.get('child')();await running;
    check(c.document.run.status==='done'&&submissions.length===2,'approval resumes without rerunning completed branch');

    // All interrupted jobs recover independently; one waiting branch does not block the other.
    await create('scheduler-recover',[trigger,gen('A'),gen('B'),gen('child',[from('B')]),gen('join',[from('A'),from('B')])]);
    const run={id:'recover-run',startId:'key',threadId:'thread',order:['key','A','B','child','join'],status:'running',accountId:null,
      steps:{key:{status:'done'},A:{status:'running',jobId:'old-a',turnKey:'turn-a'},B:{status:'running',jobId:'old-b',turnKey:'turn-b'},child:{status:'pending'},join:{status:'pending'}}};
    await c.save({...c.document,run,runs:[run]});c=new CanvasWorkflowController('scheduler-recover');await c.load();
    check(c.document.run.steps.A.status==='waiting'&&c.document.run.steps.B.status==='waiting','all running steps become recoverable');
    let aReady=false;
    api.recentGenSessions=async()=>[{id:'old-a',status:aReady?'done':'running',turns:[{turn_key:'turn-a',images:['A.png']}]},{id:'old-b',status:'done',turns:[{turn_key:'turn-b',images:['B.png']}]}];
    running=c.continue();await until(()=>release.has('child'),'ready recovered branch advances past waiting sibling');
    release.get('child')();await running;
    check(c.document.run.status==='waiting'&&submissions.length===1&&!release.has('join'),'waiting keeps join pending and does not resubmit');
    aReady=true;running=c.continue();await until(()=>release.has('join'),'join resumes after original job finishes');release.get('join')();await running;
    check(c.document.run.status==='done'&&submissions.length===2,'completed branch never resubmitted');

    // Failure blocks new submissions while already-submitted work drains under the original locks.
    await create('scheduler-failure',[trigger,gen('A'),gen('B'),gen('child',[from('A')]),gen('join',[from('B')])]);running=c.start('key');
    await until(()=>submissions.length===2,'failure branches started');release.get('A')(true);
    await new Promise(r=>setTimeout(r,40));
    check(c.isLocked('B'),'active sibling remains locked during failure');release.get('B')();await running;
    check(c.document.run.status==='failed'&&c.document.run.steps.A.status==='failed'&&submissions.length===2,'no downstream submission after failure');
    check(c.issue?.nodeId==='A','failure points to its actual branch');

    await create('scheduler-stop',[trigger,gen('A'),gen('B'),gen('join',[from('A'),from('B')])]);running=c.start('key');
    await until(()=>submissions.length===2,'stop branches started');let stopped=false;const stopping=c.stop().then(()=>{stopped=true;});
    await until(()=>cancelled.length===2,'both active jobs cancelled');
    check(!stopped&&c.isLocked('A')&&c.isLocked('B'),'stop holds locks until active callbacks finish');
    release.get('A')();release.get('B')();await Promise.all([running,stopping]);
    check(c.document.run.status==='stopped'&&!c.isLocked('A')&&submissions.length===2,'stop drains and never starts join');
    return 'scheduler: concurrent roots, eager downstream, content-cell join, serialized writes, multi-job reload/recovery, waiting isolation, exact failure and stop drainage passed';
  }));
  assert.deepEqual(errors,[]);
}finally{await browser.close();await server.close();}
