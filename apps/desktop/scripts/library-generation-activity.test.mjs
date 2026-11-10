import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { libraryGenerationTasks, libraryLocalVideoTask } from '../src/lib/libraryGenerationActivity.ts';

const projects = [{ id: 'p', name: '快速生成' }, { id: 'q', name: '品牌' }];
const job = (id, overrides = {}) => ({ id, projectId: 'p', threadId: 't', createdAt: 100, lastPrompt: '首轮', running: false,
  turns: [{ id: 1, turnKey: 'one', prompt: '海报', images: ['image.png'] }], ...overrides });
test('recent tasks retain completed jobs, latest retry state and exact frozen locator', () => {
  const rows = libraryGenerationTasks({ projects, jobs: [job('done'), job('retry', { createdAt: 200, turns: [
    { turnKey: 'old', error: 'failed', images: [] }, { turnKey: 'new', prompt: '新的海报', images: ['new.png'] },
  ] })] });
  assert.deepEqual(rows.map(row => [row.id, row.status, row.nodeId]), [
    ['retry', 'completed', 'gen-prompt:retry:new:0'], ['done', 'completed', 'gen-prompt:done:one:0'],
  ]);
  assert.equal(rows[0].title, '新的海报');
});
test('running, unresolved, no result, deleted and legacy owner states are not mislabeled success', () => {
  const rows = libraryGenerationTasks({ projects, jobs: [
    job('run', { running: true }), job('unknown', { turns: [{ error: 'SECRET /url/stack', images: [] }] }),
    job('empty', { turns: [{ images: [] }] }), job('deleted', { projectId: 'gone' }),
    job('legacy', { threadId: null }),
  ] });
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.id, row.status])), { run: 'running', unknown: 'attention', empty: 'attention' });
  assert.ok(rows.every(row => !row.statusLabel.includes('SECRET')));
});
test('Agent completion requires durable result and chat/extra task locators keep their project', () => {
  const rows = libraryGenerationTasks({ projects, runs: [{ runId: 'agent', projectId: 'p', threadId: 'a', creativeLaunchId: 'launch',
    status: 'succeeded', feedbackAction: 'accept', createdAt: 300, updatedAt: 350, intentPrompt: '一组图片',
    snapshot: { run: {}, artifacts: [] },
  }], chats: [{ id: 'chat', projectId: 'q', threadId: 'ct', nodeId: 'cn', title: '聊天', status: 'idle', turnCount: 1, updatedAt: 400 }],
    extraTasks: [{ id: 'h3', source: 'extra', projectId: 'q', threadId: 'ht', nodeId: 'hn', title: '本机视频',
      status: 'running', statusLabel: '生成中', updatedAt: 450 }],
  });
  assert.deepEqual(rows.map(row => [row.id, row.status]), [['h3', 'running'], ['chat', 'completed'], ['agent', 'attention']]);
  assert.equal(rows[0].projectId, 'q');
  assert.equal(rows[1].nodeId, 'cn');
  assert.equal(rows[2].nodeId, 'agent-prompt:launch:0:0');
  assert.equal(rows[2].statusLabel, '待保存结果');
});
test('local H3 follows its existing run and never treats waiting recovery as completed', () => {
  const locator = {projectId:'p',nodeId:'h3',createdAt:500};
  const document = {nodes:[{id:'h3',prompt:'花朵绽放',resultNodeIds:['output'],outputs:{image:{assetIds:['video']}}}],
    runs:[{id:'run',threadId:'h3-thread',startId:'h3',status:'running',steps:{h3:{status:'running'}}}]};
  assert.equal(libraryLocalVideoTask(locator,document).status,'running');
  document.runs[0].status='waiting'; document.runs[0].steps.h3.status='waiting';
  assert.equal(libraryLocalVideoTask(locator,document).statusLabel,'待继续取回');
  document.runs[0].status='done'; document.runs[0].steps.h3.status='done';
  assert.equal(libraryLocalVideoTask(locator,document).nodeId,'output');
  assert.equal(libraryLocalVideoTask(locator,document).status,'completed');
  assert.equal(libraryLocalVideoTask(locator,document,'write failed').status,'attention');
});
test('generation rows show original user text and order by latest completed turn time', () => {
  const rows=libraryGenerationTasks({projects,jobs:[
    job('completed',{createdAt:10,turns:[{promptRaw:'用户的原话',prompt:'expanded',turnKey:'x',images:['out'],startedAt:500,durationMs:20}]}),
    job('started',{createdAt:30,running:true,turns:[{prompt:'组稿',images:[],startedAt:600}]}),
    job('fallback',{createdAt:40,turns:[],lastPrompt:'初始意图'}),
    job('untitled',{createdAt:20,turns:[],lastPrompt:''}),
  ]});
  assert.deepEqual(rows.map(({id,title,statusLabel,updatedAt})=>[id,title,statusLabel,updatedAt]),[
    ['started','组稿','准备生成',600],['completed','用户的原话','已完成',520],
    ['fallback','初始意图','需处理',40],['untitled','生成任务','需处理',20],
  ]);
});
test('local H3 covers missing owners, run-only terminal states and incomplete delivery',()=>{
  const locator={projectId:'p',nodeId:'h3',createdAt:1};
  const node={id:'h3',prompt:'',outputs:{image:{assetIds:['asset']}},resultNodeIds:['result']};
  const run={id:'run',threadId:'thread',status:'running',steps:{h3:{status:'running'}}};
  const project=(runPatch={},nodePatch={},stepPatch={})=>({nodes:[{...node,...nodePatch}],run:{...run,...runPatch,steps:{h3:{...run.steps.h3,...stepPatch}}}});
  assert.equal(libraryLocalVideoTask(locator,{nodes:[],runs:[run]}),null);
  assert.equal(libraryLocalVideoTask(locator,{nodes:[node],runs:[]}),null);
  for(const [state,status,label] of [['waiting','attention','待继续取回'],['failed','failed','生成未完成'],['stopped','cancelled','已停止']]) {
    const task=libraryLocalVideoTask(locator,project({status:state}));
    assert.equal(task.status,status);assert.equal(task.statusLabel,label);
  }
  assert.equal(libraryLocalVideoTask(locator,project({}, {}, {comfyCancelled:true})).status,'cancelled');
  assert.equal(libraryLocalVideoTask(locator,project({}, {}, {status:'failed'})).status,'failed');
  const pending=libraryLocalVideoTask(locator,project());
  assert.equal(pending.title,'本机 H3 视频');assert.equal(pending.nodeId,'h3');
  assert.equal(libraryLocalVideoTask(locator,project({},{outputs:{}},{status:'done'})).status,'attention');
  assert.equal(libraryLocalVideoTask(locator,project({},{outputs:{image:{type:'image'}}},{status:'done'})).status,'attention');
  assert.equal(libraryLocalVideoTask(locator,project({},{resultNodeIds:[]},{status:'done'})).status,'attention');
  const missingTarget=project({}, {}, {status:'done'});
  delete missingTarget.nodes[0].resultNodeIds;
  assert.equal(libraryLocalVideoTask(locator,missingTarget).statusLabel,'待保存结果');
});
test('Agent and chat rows distinguish waiting for user, failure, cancellation and replies',()=>{
  const base={runId:'agent',projectId:'p',threadId:'a',status:'running',intentPrompt:'',updatedAt:10};
  const chat={id:'chat',projectId:'p',threadId:'c',nodeId:'cn',title:'',updatedAt:20};
  const runs=['failed','cancelled','awaiting_approval','running'].map((status,index)=>({...base,runId:`a${index}`,status}));
  const chats=['running','stopping','idle','interrupted','failed'].map((status,index)=>({...chat,id:`c${index}`,status}));
  const rows=libraryGenerationTasks({projects,runs,chats});
  const byId=Object.fromEntries(rows.map(row=>[row.id,row]));
  assert.deepEqual(runs.map(run=>byId[run.runId].status),['failed','cancelled','attention','running']);
  assert.equal(byId.a0.statusLabel,'执行失败'); assert.equal(byId.a1.statusLabel,'已取消');
  assert.equal(byId.a2.statusLabel,'等待你批准计划');assert.equal(byId.a3.title,'Agent 创作');
  assert.deepEqual(chats.map(chat=>byId[chat.id].statusLabel),['回复中','回复中','已回复','需处理','需处理']);
  assert.equal(byId.c0.title,'对话');
});
test('durably saved Agent outputs are complete, while archived projects stay out of recent history',()=>{
  const wire=JSON.parse(readFileSync(new URL('./fixtures/agent-ingest-identity.json',import.meta.url),'utf8'));
  const run={runId:wire.runId,projectId:'p',threadId:'t',status:'succeeded',feedbackAction:'accept',finalAssetId:'final',intentPrompt:'确认结果',updatedAt:600,
    snapshot:{run:{},artifacts:wire.artifacts,_bowerbirdAgentIngestV1:{schemaVersion:1,fingerprint:wire.fingerprint,completedAt:600}}};
  const rows=libraryGenerationTasks({projects:[...projects,{id:'archived',archived_at:3}],runs:[run],jobs:[job('archived',{projectId:'archived'})]});
  assert.equal(rows.length,1);assert.equal(rows[0].status,'completed');assert.equal(rows[0].statusLabel,'已完成');
});
test('recent history keeps the twenty newest tasks without changing source records',()=>{
  const jobs=Array.from({length:25},(_,index)=>job(`job${index}`,{createdAt:index}));
  const before=structuredClone(jobs);
  const rows=libraryGenerationTasks({projects,jobs});
  assert.equal(rows.length,20);assert.equal(rows[0].id,'job24');assert.equal(rows[19].id,'job5');
  assert.deepEqual(jobs,before);
});
