import assert from 'node:assert/strict';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { createServer } from 'vite';

const entry = 'scripts/fixtures/home-navigation-live/preview.html';
const server = await createServer({ cacheDir: '.tmp/h3-image-vite', optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(server.resolvedUrls.local[0] + entry + '?detail-route&source-library&canvas-library');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.envCalls = [];
    window.__TAURI_INTERNALS__.invoke = async (command,args) => {
      if (command !== 'comfy_video_environment') return invoke(command,args);
      window.envCalls.push([args.action,args.mode]);
      if (args.action === 'install') window.prepared = true;
      return { mode:args.mode,phase:window.prepared?'ready':'missing',message:window.prepared?'本机环境已就绪':'请准备图片环境',
        endpoint:'http://127.0.0.1:18190',directory:'D:/test/Bowerbird-ComfyUI-Image',canInstall:true,installed:!!window.prepared,
        downloadBytes:51360641689,requiredBytes:64245543577,completedBytes:0,totalBytes:51360641689 };
    };
    window.store.setState({codexHealth:null,dreaminaHealth:null,activeGenProvider:'codex',cloudAuth:{logged_in:true,user_id:'test'},
      cloudEntitlement:{user_id:'test',tier:'free',offline_state:'fresh',is_test_account:true,
        policy:{can_use_byo:false,max_parallel_jobs:2},balances:{daily:0,sub:0,topup:0}}});
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller=canvasWorkflowController('p');
    await controller.load();
    await controller.edit([{...newWorkflowNode('generation',100,120,'codex'),id:'test-image',prompt:'画一只鸟'}]);
  });
  const card=page.locator('[data-workflow-card="test-image"]');
  const menu=page.getByRole('dialog',{name:'图像模型',exact:true});
  await card.getByRole('button',{name:/选择图像模型/}).click();
  await menu.locator('[data-model-key="minimax-h3-image"]').click();
  await page.waitForFunction(()=>window.envCalls.some(([action,mode])=>action==='detect' && mode==='image'));
  assert.equal(await page.evaluate(()=>window.envCalls.some(([action])=>action==='install')),false);
  await card.locator('header').getByRole('button',{name:/打开环境设置/}).click();
  const settings=page.getByRole('dialog',{name:'本地部署工作流环境设置'});
  await settings.getByText(/下载 51.4 GB/).waitFor();
  await settings.getByRole('button',{name:'安装',exact:true}).click();
  await settings.waitFor({state:'hidden'});
  await card.getByRole('button',{name:/环境就绪/}).waitFor();

  async function checkModelStatusPosition(surface) {
    const group = surface.locator('.h3-image-model-controls');
    const model = await group.locator('.model-select-trigger').boundingBox();
    const status = await group.locator('.h3-image-environment').boundingBox();
    assert.ok(status.x >= model.x + model.width - 1);
    assert.ok(Math.abs(status.y + status.height / 2 - model.y - model.height / 2) <= 2);
  }
  const composer=page.locator('.composer-glass');
  const expand=composer.getByRole('button',{name:'展开创作描述'});
  if (await expand.isVisible()) await expand.click();
  await composer.getByRole('button',{name:/选择图像模型/}).click();
  await menu.locator('[data-model-key="minimax-h3-image"]').click();
  await page.waitForFunction(()=>window.store.getState().activeGenProvider==='minimax-h3-image');
  await composer.getByRole('button',{name:/环境就绪/}).waitFor();
  await checkModelStatusPosition(composer);
  await page.evaluate(()=>window.store.setState({cloudAuth:{logged_in:false}}));
  await composer.getByRole('button',{name:/选择图像模型/}).click();
  assert.equal(await menu.locator('[data-model-key="minimax-h3-image"]').isDisabled(),true);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const job = {id:'h3-conversation',conversationId:'h3-conversation',sessionId:'previous-session',projectId:'p',threadId:'t',
      media:'image',provider:'codex',createdAt:1,streaming:'',running:false,lastPrompt:'上一张图',lastRefs:[],refAssets:[],
      turns:[{id:1,prompt:'上一张图',provider:'codex',images:['test.png'],media:'image'}]};
    window.store.setState({genJobs:{[job.id]:job},genJobOrder:[job.id],cloudAuth:{logged_in:true,user_id:'test'}});
    window.store.getState().openGenerationJob(job.id,{navigate:false});
    window.store.getState().setGenEditing('revise');
  });
  const dock=page.locator('.generation-toolbar');
  await dock.getByRole('button',{name:/选择图像模型/}).click();
  await menu.locator('[data-model-key="minimax-h3-image"]').click();
  await page.waitForFunction(()=>window.envCalls.some(([action,mode])=>action==='detect' && mode==='edit'));
  assert.match(await dock.locator('.model-select-trigger').innerText(),/MiniMax-H3-Image/);
  await checkModelStatusPosition(dock);
  await page.evaluate(() => {
    const invoke=window.__TAURI_INTERNALS__.invoke;
    window.cancelCalls=[];
    window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
      if(command!=='cancel_codex_create')return invoke(command,args);
      window.cancelCalls.push(args);
      throw new Error('unconfirmed cancel at http://127.0.0.1:18190/private');
    };
    const job=window.store.getState().genJobs['h3-conversation'];
    window.store.setState({genJobs:{...window.store.getState().genJobs,[job.id]:{...job,running:true,
      turns:[{...job.turns[0],turnKey:'current-h3-turn'}]}}});
    window.store.getState().cancelGeneration(job.id);
  });
  await page.getByText('尚未确认停止，请检查原任务状态',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.cancelCalls),[{jobId:'h3-conversation',turnKey:'current-h3-turn'}]);
  assert.equal(await page.evaluate(()=>window.store.getState().genJobs['h3-conversation'].running),true);
  assert.equal(await page.getByText(/unconfirmed cancel|18190\/private/).count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: H3 image selection and setup, account gates, cancellation identity and visible unconfirmed-stop error');
} finally { await browser.close(); await server.close(); }
