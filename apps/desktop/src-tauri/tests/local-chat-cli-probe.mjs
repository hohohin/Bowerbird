// Opt-in managed CLI integration probe. Requires BOWERBIRD_CHAT_PROTOCOL_BINARY.
// Uses fresh temporary CODEX_HOME, fixed local model metadata and localhost Responses;
// no credentials, real models, installed MCP processes or user workspaces are used.
// Covers direct calls AND code_mode_only's functions.exec routing (CLI 0.153.4).
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import readline from 'node:readline';

const binary=process.env.BOWERBIRD_CHAT_PROTOCOL_BINARY;
assert.ok(binary,'explicit managed CLI path required');
const root=await mkdtemp(path.join(tmpdir(),'bowerbird-chat-protocol-'));
const source=await readFile(new URL('../src/commands/local_chat.rs',import.meta.url),'utf8');
const block=source.slice(source.indexOf('fn chat_config()'),source.indexOf('fn isolated_thread_config'));
const productionConfig=Object.fromEntries([...block.matchAll(/config\.insert\(\s*"([^"\n]+)"\.into\(\),\s*json!\(("[^"]*"|true|false|\d+)\),?\s*\)/g)].map(m=>[m[1],JSON.parse(m[2])]));
assert.equal(productionConfig['tools.experimental_request_user_input.enabled'],false,'load multiline Rust config entries');
for(const m of block.match(/for feature in \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g))productionConfig[`features.${m[1]}`]=false;
assert.equal(productionConfig['features.code_mode_host'],true,'production must enable the code-mode-only tool transport');
assert.equal(productionConfig['features.code_mode'],false,'ordinary models keep their direct tool route');
assert.equal(productionConfig['agents.enabled'],false,'code-mode model metadata must not enable delegation');
const toolSpec=JSON.parse(await readFile(new URL('../../../cloud/supabase/functions/_shared/chat-card-tool.json',import.meta.url),'utf8'));
assert.ok(Number(source.match(/const CARD_TOOL_VERSION: i64 = (\d+);/)[1])>=3,'section schema changes require provider-thread migration');
const versionTwoToolSpec=structuredClone(toolSpec);
versionTwoToolSpec.description='Create native generation, local H3, content, trigger and loop cards without executing them.';
delete versionTwoToolSpec.inputSchema.properties.sections;
const legacyToolSpec=structuredClone(versionTwoToolSpec);
legacyToolSpec.description='Create native generation, content, trigger and loop cards without executing them.';
legacyToolSpec.inputSchema.properties.cards.items.oneOf=legacyToolSpec.inputSchema.properties.cards.items.oneOf.filter(card=>card.properties.kind.const!=='comfy-video');
legacyToolSpec.inputSchema.properties.cards.items.oneOf.find(card=>card.properties.kind.const==='loop').properties.body.description='Aliases of generation cards controlled by this loop.';
legacyToolSpec.inputSchema.properties.connections.items.properties.input.enum=['text','image','signal','completion'];
assert.ok(!JSON.stringify(legacyToolSpec).includes('comfy-video'));
const legacyToolArgs={cards:[{id:'ideas',kind:'content',title:'离线内容卡',rows:[['第一行'],['第二行']]},{id:'image',kind:'generation',title:'离线生成卡',prompt:'按当前行绘制',mediaType:'image'},{id:'repeat',kind:'loop',title:'逐行循环',mode:'rows',source:'ideas',body:['image']},{id:'start',kind:'trigger',title:'开始'}],connections:[{from:'start',to:'repeat',output:'signal',input:'signal'}]};
const versionTwoToolArgs=structuredClone(legacyToolArgs);
versionTwoToolArgs.cards.splice(2,0,{id:'h3',kind:'comfy-video',title:'本地 H3',prompt:'由首帧运动至尾帧',seconds:8,ratio:'auto',resolution:0.8,lastFrameAlias:'image1'});
versionTwoToolArgs.cards.find(card=>card.kind==='loop').body.push('h3');
versionTwoToolArgs.connections.push({from:'image',to:'h3',output:'image',input:'first-frame'});
const toolArgs={...structuredClone(versionTwoToolArgs),sections:[{id:'visuals',title:'画面与视频',members:['image','h3']},{id:'sequence',title:'内容与循环',members:['ideas','repeat','start']}]};
function argsForRound(round){return round===8?legacyToolArgs:round===11?versionTwoToolArgs:toolArgs;}
const catalog=JSON.parse(await readFile(new URL('./fixtures/local-chat-code-mode-model.json',import.meta.url),'utf8'));
const catalogPath=path.join(root,'models.json');await writeFile(catalogPath,JSON.stringify(catalog));
const instructions='你是 Bowerbird 创作工作台中的图文对话助手。只能使用 create_canvas_cards 创建待运行卡片，不操作文件或执行生成。';
const evidence={requests:[],calls:[],rounds:[]};
let activeChild;

function stream(res,item,n){
  const response={id:`response-${n}`,object:'response',status:'completed',model:'offline-fixture',output:[item],usage:{input_tokens:10,output_tokens:10,total_tokens:20}};
  const empty=item.type==='message'?{...item,content:[]}:item.type==='function_call'?{...item,arguments:''}:{...item,input:''};
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:empty}];
  if(item.type==='message'){
    const part=item.content[0];
    events.push({type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{...part,text:''}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:part.text},{type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:part.text},{type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part});
  }else{
    const custom=item.type==='custom_tool_call',field=custom?'input':'arguments',prefix=custom?'custom_tool_call_input':'function_call_arguments';
    events.push({type:`response.${prefix}.delta`,output_index:0,item_id:item.id,delta:item[field]},{type:`response.${prefix}.done`,output_index:0,item_id:item.id,[field]:item[field]});
  }
  events.push({type:'response.output_item.done',output_index:0,item},{type:'response.completed',response});
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  for(const event of events)res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
}

try{
  for(const route of ['direct','code-mode']){
    const home=path.join(root,route),cwd=path.join(home,'chat-workspaces','probe'),marker=path.join(home,'mcp-started.txt');
    await mkdir(cwd,{recursive:true});
    const config={...productionConfig,'features.enable_request_compression':false,...(route==='code-mode'?{model_catalog_json:catalogPath}:{})};
    let round=-1,providerThread,legacyThread,versionOneThread,versionTwoThread,failedThread,serverFailure;
    const requests=[],calls=[];
    const server=createServer(async(req,res)=>{
      try{
        let bytes=[];for await(const b of req)bytes.push(b);
        if(!req.url?.endsWith('/responses')){res.writeHead(404);res.end();return;}
        const body=JSON.parse(Buffer.concat(bytes));requests.push(body);evidence.requests.push({route,round,body});
        const callId=`${route}-card-${round}`,output=(body.input??[]).find(item=>item.type?.endsWith('_call_output')&&item.call_id===callId);
        const toolText=JSON.stringify([body.tools??[],body.input?.filter(item=>item.type==='additional_tools')??[]]);
        assert.ok(!toolText.includes('"name":"collaboration"'),'delegation must not be advertised');
        if(round!==3&&!output){
          assert.ok(route==='code-mode'?toolText.includes('create_canvas_cards(args'):(body.tools??[]).some(item=>item.name===toolSpec.name),`dynamic tool missing in ${route} round ${round}`);
          assert.equal(toolText.includes('comfy-video'),round!==8,'only migrated tool schemas expose local H3');
          assert.equal(toolText.includes('sections'),![8,11].includes(round),'only the current tool schema exposes sections');
          const currentArgs=argsForRound(round);
          const hostScript=`const toolNames=ALL_TOOLS.map(t=>t.name).sort(); if(JSON.stringify(toolNames)!==JSON.stringify(['apply_patch','clock__curr_time','create_canvas_cards']))throw new Error('unexpected nested tool catalog'); text({isolation:{process:typeof process,require:typeof require,fetch:typeof fetch,toolNames}}); text(await tools.create_canvas_cards(${JSON.stringify(currentArgs)}));`;
          const item=[6,7].includes(round)?{id:`tool-${round}`,type:'function_call',call_id:callId,name:round===6?'list_agents':'spawn_agent',namespace:'collaboration',arguments:JSON.stringify(round===6?{}:{task_name:'boundary_probe_child',fork_turns:'none',message:'Synthetic offline fixture; reply only with FIXTURE_CHILD_UNEXPECTED.'})}:route==='code-mode'?{id:`tool-${round}`,type:'custom_tool_call',call_id:callId,name:'exec',namespace:'functions',input:hostScript}:{id:`tool-${round}`,type:'function_call',call_id:callId,name:toolSpec.name,arguments:JSON.stringify(currentArgs)};
          stream(res,item,evidence.requests.length);
          return;
        }
        if(round!==3){
          if(round===0){assert.match(JSON.stringify(output),/code-mode host is disabled/);assert.equal(calls.length,0,'disabled host never reaches the app tool');}
          else if([6,7].includes(round))assert.match(JSON.stringify(output),new RegExp(`unsupported call: collaboration${round===6?'list_agents':'spawn_agent'}`),'delegation remains unavailable even when forced by the model fixture');
          else{
            assert.ok(JSON.stringify(output).includes(`batch-${route}-${round}`),'model receives the native durable result');
            if(![8,11].includes(round))for(const section of toolArgs.sections)assert.ok(JSON.stringify(output).includes(`saved-${round}-${section.id}`),'model receives each created section with its cards');
            if(route==='code-mode'){
              const returned=JSON.stringify(output);
              for(const name of ['process','require','fetch'])assert.ok(returned.includes(`\\"${name}\\":\\"undefined\\"`),`${name} must not exist in the JS host`);
              assert.ok(!/exec_command|shell_command|mcp__|browser|computer|spawn_agent/.test(returned),'JS host exposes no operating/delegation tools');
            }
          }
        }
        stream(res,{id:`message-${evidence.requests.length}`,type:'message',role:'assistant',content:[{type:'output_text',text:`离线回复 ${round}`,annotations:[]}]},evidence.requests.length);
      }catch(error){serverFailure=error;res.writeHead(500);res.end(String(error));}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
      const port=server.address().port;
      await writeFile(path.join(home,'config.toml'),`model=${JSON.stringify(route==='code-mode'?catalog.models[0].slug:'gpt-5.4')}\nmodel_provider="offline_fixture"\n[mcp_servers."probe.test"]\ncommand="node"\nargs=${JSON.stringify(['-e','require("node:fs").writeFileSync(process.argv[1],"started")',marker])}\n[model_providers.offline_fixture]\nname="Offline fixture"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`);
      const skillDir=path.join(home,'skills','probe-skill');await mkdir(skillDir,{recursive:true});
      await writeFile(path.join(skillDir,'SKILL.md'),'---\nname: probe-skill\ndescription: PRIVATE_SKILL_CATALOG_MUST_NOT_LEAK\n---\nPRIVATE_SKILL_BODY_MUST_NOT_LEAK');
      for(const currentRound of route==='code-mode'?[0,1,2,3,4,5,6,7,8,9,10,11,12,13]:[1,2,3,4,5,8,9,10,11,12,13]){
        round=currentRound;
        if([3,8,11].includes(round))providerThread=undefined;
        if(round===4){legacyThread=providerThread;providerThread=undefined;}
        if(round===9){versionOneThread=providerThread;providerThread=undefined;}
        if(round===12){versionTwoThread=providerThread;providerThread=undefined;}
        const turnConfig={...config,...(round===0?{'features.code_mode_host':false}:{})};
        const args=['app-server','--listen','stdio://','-c','approval_policy="never"','-c','sandbox_mode="read-only"'];
        for(const [key,value]of Object.entries(turnConfig))args.push('-c',`${key}=${JSON.stringify(value)}`);
        const env={...process.env,CODEX_HOME:home};for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','CODEX_AUTH_JSON'])delete env[key];
        const child=spawn(binary,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});activeChild=child;
        let stderr='',closed=false;child.stderr.on('data',b=>stderr=(stderr+b).slice(-5000));child.on('exit',()=>{closed=true;});
        const queued=[],waiters=[];
        readline.createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);const next=waiters.shift();if(next)next(value);else queued.push(value);});
        function next(){if(closed&&!queued.length)throw new Error(`CLI exited: ${stderr}`);return queued.length?Promise.resolve(queued.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(serverFailure??new Error(`protocol timed out: ${stderr}`)),30000);waiters.push(v=>{clearTimeout(timer);resolve(v);});});}
        function send(value){child.stdin.write(JSON.stringify(value)+'\n');}
        async function rpc(id,method,params){send({id,method,params});for(;;){const value=await next();if(value.id===id){if(value.error)throw new Error(JSON.stringify(value.error));return value.result;}if(value.method&&value.id!=null)throw new Error('unexpected server request '+value.method);}}
        await rpc(1,'initialize',{clientInfo:{name:'bowerbird_offline_probe',version:'1.0'},capabilities:{experimentalApi:true}});send({method:'initialized',params:{}});
        const effective=await rpc(5,'config/read',{includeLayers:false});
        for(const key of ['shell_tool','unified_exec','plugins','apps','multi_agent','multi_agent_v2'])assert.equal(effective.config.features[key],false);
        const threadConfig={...turnConfig,mcp_servers:Object.fromEntries(Object.entries(effective.config.mcp_servers??{}).map(([name,value])=>[name,{...(typeof value.command==='string'?{command:value.command}:{}),...(typeof value.url==='string'?{url:value.url}:{}),enabled:false,required:false}]))};
        const thread=await rpc(2,providerThread?'thread/resume':'thread/start',{...(providerThread?{threadId:providerThread}:round===3?{}:{dynamicTools:[round===8?legacyToolSpec:round===11?versionTwoToolSpec:toolSpec]}),cwd,approvalPolicy:'never',sandbox:'read-only',config:threadConfig,baseInstructions:instructions,developerInstructions:instructions});
        assert.equal(thread.approvalPolicy,'never');assert.equal(thread.sandbox.type,'readOnly');
        if(providerThread)assert.equal(thread.thread.id,providerThread);providerThread=thread.thread.id;
        if(round===0)failedThread=providerThread;
        if(round===1&&route==='code-mode')assert.equal(providerThread,failedThread,'the failed production-style thread resumes without migration');
        if(round===4)assert.notEqual(providerThread,legacyThread,'legacy upgrade creates a tool-enabled provider thread');
        if(round===9)assert.notEqual(providerThread,versionOneThread,'v1 upgrade creates a provider thread with the H3 and section schema');
        if(round===12)assert.notEqual(providerThread,versionTwoThread,'v2 H3 upgrade creates a provider thread with the section schema');
        const historyRound=round===4?3:round===9?8:round===12?11:undefined;
        const input=[...(historyRound===undefined?[]:[{type:'text',text:`同一应用对话的历史文字，仅供上下文参考，不重做过去请求：${JSON.stringify([{role:'user',text:`这是离线测试第 ${historyRound} 轮`},{role:'assistant',text:`离线回复 ${historyRound}`}])}`,text_elements:[]}]),{type:'text',text:`这是离线测试第 ${round} 轮`,text_elements:[]}];
        const requestStart=requests.length;
        send({id:3,method:'turn/start',params:{threadId:providerThread,input,approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}}});
        let delta='',providerTurn;for(;;){const value=await next();if(value.error)throw new Error(JSON.stringify(value.error));if(value.id===3)providerTurn=value.result.turn.id;if(value.method==='turn/started')providerTurn=value.params.turn.id;
          if(value.method==='item/tool/call'){
            const currentArgs=argsForRound(round);
            assert.equal(value.params.threadId,providerThread);assert.equal(value.params.turnId,providerTurn);assert.equal(value.params.namespace,null);assert.equal(value.params.tool,toolSpec.name);assert.deepEqual(value.params.arguments,currentArgs);
            calls.push(value.params);evidence.calls.push({route,round,...value.params});
            const receiptCards=[...currentArgs.cards,...(currentArgs.sections??[]).map(section=>({...section,kind:'section'}))].map(c=>({alias:c.id,id:`saved-${round}-${c.id}`,kind:c.kind,title:c.title}));
            send({id:value.id,result:{contentItems:[{type:'inputText',text:JSON.stringify({id:`batch-${route}-${round}`,status:'created',cards:receiptCards})}],success:true}});
          }else if(value.id!=null&&value.method)throw new Error('unexpected server request '+value.method);
          if(value.method==='item/agentMessage/delta')delta+=value.params.delta;
          if(value.method==='turn/completed'){if(serverFailure)throw serverFailure;assert.equal(value.params.turn.status,'completed',JSON.stringify(value.params.turn));break;}
        }
        if(serverFailure)throw serverFailure;assert.equal(delta,`离线回复 ${round}`);
        const roundInput=JSON.stringify(requests[requestStart].input);
        if(round===2){assert.ok(roundInput.includes('离线回复 1'));assert.ok(roundInput.includes(`batch-${route}-1`));}
        if(round===3)assert.ok(!JSON.stringify([requests[requestStart].tools??[],requests[requestStart].input.filter(item=>item.type==='additional_tools')]).includes('create_canvas_cards'),'legacy pure-chat thread has no card tool');
        if(round>=4&&round<=7)assert.ok(roundInput.includes('离线回复 3'),'upgraded transcript persists');
        if(round===5)assert.ok(roundInput.includes(`batch-${route}-4`),'upgraded tool result persists');
        if(round===9||round===10){assert.ok(roundInput.includes('离线回复 8'),'v1 public transcript persists after H3 and section upgrade');assert.ok(!roundInput.includes(`batch-${route}-8`),'old v1 tool result is not replayed as fresh creation authority');}
        if(round===10)assert.ok(roundInput.includes(`batch-${route}-9`),'H3 result survives a resumed CLI process');
        if(round>=12){assert.ok(roundInput.includes('离线回复 11'),'v2 public transcript persists after section upgrade');assert.ok(!roundInput.includes(`batch-${route}-11`),'old v2 tool result is not replayed as fresh creation authority');}
        if(round===13){assert.ok(roundInput.includes(`batch-${route}-12`),'section result survives a resumed CLI process');for(const section of toolArgs.sections)assert.ok(roundInput.includes(`saved-12-${section.id}`),'resumed transcript retains every section receipt');}
        evidence.rounds.push({route,round,threadId:providerThread,requests:requests.length-requestStart});
        child.stdin.end();child.kill();if(!closed)await new Promise(resolve=>child.once('exit',resolve));activeChild=undefined;
      }
      assert.equal(calls.length,10);assert.equal(requests.length,route==='code-mode'?27:21,'disabled delegation must not cause extra child model requests');
      let mcpStarted=true;try{await access(marker);}catch{mcpStarted=false;}assert.equal(mcpStarted,false,'configured MCP process must not start');
      for(const body of requests){const text=JSON.stringify(body);for(const marker of ['PRIVATE_AGENT_INSTRUCTION','PRIVATE_SKILL_CATALOG','PRIVATE_SKILL_BODY'])assert.ok(!text.includes(marker),`${marker} leaked`);}
    }finally{server.close();}
  }
  console.log(JSON.stringify({ok:true,modelRequests:evidence.requests.length,toolCalls:evidence.calls.length,directCalls:true,codeModeHostCalls:true,h3Calls:true,sectionCalls:true,versionOneH3Upgrade:true,versionTwoSectionUpgrade:true,sectionReceiptsResumed:true,disabledHostReproduced:true,sameThreadRecovered:true,dynamicToolsPersisted:true,legacyUpgrade:true,delegationRejected:true,mcpStarted:false,root},null,2));
}finally{
  activeChild?.kill();await writeFile(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));
}
