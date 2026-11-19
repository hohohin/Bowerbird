import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({cacheDir:'.tmp/pending-original-ui/vite',server:{host:'127.0.0.1',port:17991,hmr:false,watch:null}});
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultNavigationTimeout(90000);
page.setDefaultTimeout(10000);
const card = id => page.locator(`.folder-media-card[data-asset-id="${id}"]`);
const view = name => page.evaluate(name => window.mode.getState().setView(name), name);
try {
  await page.goto(server.resolvedUrls.local[0]+'scripts/fixtures/connected-collections/preview.html?file-tasks');
  await page.waitForFunction(() => !!window.store);
  await page.locator('[data-connection-entry="root-0"]').waitFor();
  await page.evaluate(async () => {
    const { startFileTask, changeFileTask, listFileTasks, FILE_TASKS_UPDATED } = await import('/src/lib/fileTasks.ts');
    const { isPendingOriginal } = await import('/src/lib/pendingOriginalDeletion.ts');
    const previous = window.__TAURI_INTERNALS__.invoke;
    const originals = window.entries.slice(0,4).map(row => row.asset);
    const assets = [...originals, {...originals[0],id:'alias'}];
    const tasks = window.tasks = [], hidden = new Set();
    const update = () => window.dispatchEvent(new Event(FILE_TASKS_UPDATED));
    window.hideTask = (ids,missing=false) => startFileTask({kind:'delete',originals:ids.map(id=>({
      asset_id:id,path:originals.find(a=>a.id===id).store_path,name:id,missing,fingerprint:'frozen',
    }))},'删除原文件');
    window.retry = () => changeFileTask('retry',tasks[0].id);
    window.isPending = isPendingOriginal;
    window.finish = (index,completed,failures,phase) => {
      const task = tasks[index];
      task.phase = phase; task.completed = completed;
      task.failures = failures.map(id=>({id,label:id,retryable:true,message:'文件被占用'}));
      task.succeeded = completed - failures.length;
      for (const item of task.deleteOriginals.slice(0,completed)) if (!failures.includes(item.assetId)) hidden.add(item.path);
      update();
    };
    window.restore = () => { hidden.clear(); window.changed(); };
    window.readTasks = listFileTasks;
    window.__TAURI_INTERNALS__.invoke = async (cmd,args) => {
      if (cmd === 'list_file_tasks') {
        const response = structuredClone(tasks);
        if (window.delayList) { window.delayList=false; await new Promise(resolve => { window.releaseList=resolve; }); }
        return response;
      }
      if (cmd === 'start_file_task') {
        if (window.deny) throw new Error('文件任务未受理');
        if (window.alreadyDismissed) return;
        const list = args.request.originals.map(item=>({assetId:item.asset_id, path:item.path, missing:!!item.missing}));
        tasks.push({id:args.id,title:args.title,total:list.length,phase:'running',completed:0,succeeded:0,cleaned:0,recycled:0,skipped:0,failures:[],retryId:null,deleteOriginals:list}); return;
      }
      if (cmd === 'retry_file_task') {
        const parent=tasks.find(task=>task.id===args.id); parent.retryId=args.newId;
        const list=parent.deleteOriginals.filter(item=>parent.failures.some(f=>f.id===item.assetId));
        tasks.push({...parent,id:args.newId,phase:'running',failures:[],completed:0,succeeded:0,total:list.length,retryId:null,deleteOriginals:list}); return;
      }
      if (cmd === 'catalog_overview') return {total:assets.length,untagged:0,catalog:{tags:[{id:'tag',name:'测试标签',description:'',count:assets.length,projectCount:0}],collections:[],prompts:[],tag_asset_ids:{}}};
      if (cmd === 'catalog_page') {
        if (window.holdPages) await new Promise(resolve => window.pageWaiters.push(resolve));
        return assets.filter(a=>!hidden.has(a.store_path)).slice(args.offset,args.offset+args.limit);
      }
      if (cmd === 'project_canvas_get') return {nodes:[]};
      if (cmd === 'get_assets_by_ids') return assets.filter(a=>args.assetIds.includes(a.id));
      if (cmd === 'preview_asset_originals') return assets.filter(a=>args.assetIds.includes(a.id)).map(a=>({asset_id:a.id,name:a.name,path:a.store_path,missing:false,fingerprint:'frozen'}));
      return previous(cmd,args);
    };
    window.pageWaiters=[];
    window.mode.getState().setView('global');
  });
  await card('root-0').click({modifiers:['Control']});
  await card('root-1').click(); await card('root-2').click();
  await card('root-0').click({button:'right'});
  const action = name => page.getByRole('menuitem',{name,exact:true});
  await action('删除').click(); await action('删除原文件…').click();
  await page.getByRole('dialog',{name:'删除原文件',exact:true}).getByRole('button',{name:'删除原文件',exact:true}).click();
  await card('root-0').waitFor({state:'detached'}); assert.equal(await card('alias').count(),0);
  await card('root-3').waitFor();
  await view('tags'); await card('root-3').waitFor(); assert.equal(await card('root-1').count(),0);
  await page.evaluate(() => {
    window.store.setState({projects:[{id:'project',name:'测试项目',archived_at:null}]});
    window.mode.getState().selectProject('project');
  });
  await view('project'); await card('root-3').waitFor(); assert.equal(await card('alias').count(),0);
  await view('collections');
  await page.locator('[data-collection-id="child"]').click();
  await page.locator('[data-connection-entry="child-0"]').waitFor();
  for (const id of ['ref-one','ref-two']) assert.equal(await page.locator(`[data-connection-entry="${id}"]`).count(),0);
  await view('global'); await card('root-3').waitFor();
  await page.evaluate(() => { window.holdPages=true; window.finish(0,2,['root-1'],'cancelled'); });
  await card('root-1').waitFor(); await card('root-2').waitFor();
  assert.equal(await card('root-0').count(),0); assert.equal(await card('alias').count(),0);
  await page.evaluate(() => { window.holdPages=false; window.pageWaiters.splice(0).forEach(done=>done()); });
  await page.evaluate(() => window.retry());
  await card('root-1').waitFor({state:'detached'});
  await page.evaluate(() => { window.delayList=true; void window.readTasks(); });
  await page.waitForFunction(() => !!window.releaseList);
  await page.evaluate(() => { window.finish(1,0,[],'cancelled'); });
  await card('root-1').waitFor();
  await page.evaluate(() => window.releaseList());
  assert.equal(await page.evaluate(() => window.isPending('root-1')), false);
  await page.evaluate(() => window.restore());
  await card('root-0').waitFor(); await card('alias').waitFor();
  await view('collections'); await page.locator('[data-collection-id="child"]').click();
  await page.locator('[data-connection-entry="ref-one"]').waitFor();
  await page.evaluate(() => window.hideTask(['root-0'],true));
  await page.locator('[data-connection-entry="ref-one"]').waitFor({state:'detached'});
  await page.evaluate(() => window.finish(2,0,[],'cancelled'));
  await page.locator('[data-connection-entry="ref-one"]').waitFor();
  for (const [index,phase] of [[3,'finished'],[4,'cancelled']]) {
    await page.evaluate(() => window.hideTask(['root-0']));
    for (const id of ['ref-one','ref-two']) await page.locator(`[data-connection-entry="${id}"]`).waitFor({state:'detached'});
    await page.evaluate(([index,phase]) => window.finish(index,phase==='finished'?1:0,phase==='finished'?['root-0']:[],phase),[index,phase]);
    for (const id of ['ref-one','ref-two']) await page.locator(`[data-connection-entry="${id}"]`).waitFor();
    assert.equal(await page.locator('[data-connection-entry="ref-one"] .connected-missing').count(),0);
  }
  await view('global'); await card('root-0').waitFor();
  assert.equal(await page.evaluate(async () => {
    window.deny=true;
    try { await window.hideTask(['root-0']); return false; }
    catch { return !window.isPending('root-0'); }
  }), true);
  await card('root-0').waitFor();
  await page.evaluate(async () => {
    window.deny=false; window.alreadyDismissed=true;
    await window.hideTask(['root-1']);
    await window.readTasks();
  });
  assert.equal(await page.evaluate(() => window.isPending('root-1')), false);
  assert.deepEqual(errors, []);
  console.log('PASS immediate deletion across library views, path aliases, reference cleanup, cold/warm pages, partial failure, cancellation, retry, late receipt and reindex');
} catch (error) {
  console.error(error, errors, (await page.locator('body').innerText()).slice(0,850));
  throw error;
}
finally { await browser.close(); await server.close(); }
