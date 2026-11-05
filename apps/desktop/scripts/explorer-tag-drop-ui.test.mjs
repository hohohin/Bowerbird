import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({cacheDir:'.tmp/explorer-tag-drop-vite',
 plugins:process.env.EXPLORER_TAG_SOURCE?[{name:'isolated-tag-mutation',enforce:'pre',async load(id){if(id.replaceAll('\\','/').endsWith('/src/components/ExploreWorkspace.tsx'))return readFile(process.env.EXPLORER_TAG_SOURCE,'utf8');}}]:[],
 server:{host:'127.0.0.1',port:17963,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:850}});page.setDefaultTimeout(7000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const calls=command=>page.evaluate(command=>window.calls.filter(c=>c.command===command),command);
async function drop(selector,id,mediaKind){
 await page.locator(selector).evaluate((el,{id,mediaKind})=>{
  const dataTransfer=new DataTransfer();
  dataTransfer.setData('application/x-bowerbird-explorer',JSON.stringify({version:1,dragId:id.toString(16).padStart(32,'0'),imageUrl:'https://image.test/'+id+(mediaKind==='video'?'.mp4':'.png'),pageUrl:'https://www.pinterest.com/pin/1/',mediaKind}));
  el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer,clientX:500,clientY:300}));
 },{id,mediaKind});
}
try{
 await page.route('https://image.test/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>'}));
 await page.goto(server.resolvedUrls.local[0]+'scripts/fixtures/explorer/preview.html');
 await page.getByRole('button',{name:'探索',exact:true}).click();
 await page.evaluate(async()=>{
  const {UNTAGGED_SECTION}=await import('/src/lib/materialCatalogOrder.ts');
  window.analyse=true;window.hold=true;
  window.store.setState({activeProjectId:'p',projects:[{id:'p',name:'项目',kind:'blank'}]});
  const catalog=document.createElement('section');catalog.className='is-tag-catalog';catalog.dataset.fileImportProjectId='';
  catalog.innerHTML='<button data-tag-id="chosen"><span id="tag">指定标签</span></button><section data-tag-section="section-tag"><span id="section">标签内容区</span></section><section data-tag-section="'+UNTAGGED_SECTION+'"><span id="untagged">未分类</span></section>';
  document.querySelector('.explore-main').append(catalog);
  const invoke=window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
   if(command==='local_classification_example'){
    window.calls.push({command,args});if(window.failTag)throw new Error('标签写入失败');return;
   }
   return invoke(command,args);
  };
 });
 await drop('#tag',1);await page.waitForFunction(()=>window.release);
 assert.equal((await calls('claim_source_browser_analysis')).length,0,'an explicit tag bypasses classification');
 assert.equal((await calls('capture_source_browser_image')).at(-1).args.skipClassification,true,'native ingestion also skips the automatic queue');
 assert.ok((await calls('release_source_browser_analysis')).some(c=>c.args.dragId==='1'.padStart(32,'0')),'cancel speculative drag analysis before the held capture finishes');
 assert.equal(await page.locator('[data-classification-id]').count(),0,'no classification dock for an explicit tag');
 await page.evaluate(()=>{document.querySelector('[data-tag-id]').dataset.tagId='changed';window.hold=false;window.release();});
 await page.waitForFunction(()=>window.calls.some(c=>c.command==='local_classification_example'));
 assert.deepEqual((await calls('local_classification_example')).at(-1).args,{tagId:'chosen',assetIds:['captured'],positive:true});
 assert.equal((await calls('finish_source_browser_analysis')).length,0);
 // A failed manual assignment retries delivery to the frozen tag without another download.
 await page.evaluate(()=>{document.querySelector('.is-tag-catalog').dataset.fileImportProjectId='p';window.failTag=true;});
 await drop('#section',2);
 await page.getByRole('button',{name:'采集记录',exact:true}).click();
 const failed=page.locator('.explorer-capture-row[data-capture-state="failed"]').filter({hasText:'已入库，交付未完成'});await failed.waitFor();
 const count=(await calls('capture_source_browser_image')).length;
 await page.evaluate(()=>{document.querySelector('[data-tag-section]').dataset.tagSection='later';window.failTag=false;});
 await failed.getByRole('button',{name:'重试',exact:true}).click();
 await page.waitForFunction(()=>window.calls.filter(c=>c.command==='local_classification_example').length===3);
 assert.equal((await calls('capture_source_browser_image')).length,count);
 assert.deepEqual((await calls('local_classification_example')).at(-1).args,{projectId:'p',tagId:'section-tag',assetIds:['captured'],positive:true});
 await page.keyboard.press('Escape');
 await drop('#untagged',3);
 await page.waitForFunction(()=>window.calls.some(c=>c.command==='finish_source_browser_analysis'));
 assert.equal((await calls('claim_source_browser_analysis')).length,1,'untagged space retains automatic classification');
 assert.equal((await calls('capture_source_browser_image')).at(-1).args.skipClassification,undefined);
 assert.equal((await calls('local_classification_example')).length,3,'untagged space never assigns a manual tag');
 assert.equal((await calls('release_source_browser_analysis')).filter(c=>c.args.dragId==='3'.padStart(32,'0')).length,0,'untagged space retains its speculative analysis');
 await drop('#section',4,'video');
 await page.waitForFunction(()=>window.calls.filter(c=>c.command==='local_classification_example').length===4);
 assert.deepEqual((await calls('local_classification_example')).at(-1).args,{projectId:'p',tagId:'later',assetIds:['captured'],positive:true});
 assert.equal((await calls('claim_source_browser_analysis')).length,1,'video tag drops do not start image classification');
 assert.deepEqual(errors,[]);
 console.log('PASS explicit global/project tag drops, frozen destination, skipped classification, retained-asset retry and untagged fallback');
}finally{await browser.close();await server.close();}
