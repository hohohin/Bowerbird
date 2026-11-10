import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({cacheDir:'.tmp/text-file-drop/vite',server:{host:'127.0.0.1',port:0,hmr:false,watch:null}});
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'});
page.setDefaultTimeout(15000);
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
const url = suffix => `${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html?media-import${suffix}`;
async function drop(selector, files, point) {
  await page.locator(selector).first().evaluate((element,{files,point})=>{
    const dt=new DataTransfer();
    for(const {name,text='',path} of files) {
      const file=new File([text],name,{type:''}); if(path) Object.defineProperty(file,'path',{value:path}); dt.items.add(file);
    }
    const r=element.getBoundingClientRect(); const p=point??{x:r.left+r.width/2,y:r.top+r.height/2};
    for(const type of ['dragenter','dragover','drop']) element.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt,clientX:p.x,clientY:p.y}));
  },{files,point});
}
const documents = () => page.evaluate(()=>window.snapshot().nodes.filter(n=>JSON.parse(n.payloadJson).note_type==='document'));
try {
  await page.goto(url('&source-library&canvas-library'));
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const r=await page.locator('.canvas-stage').boundingBox();
  const point={x:r.x+r.width*.65,y:r.y+r.height*.5};
  const markdown='# 导入标题\n\n正文 **加粗** 与中文。';
  await drop('.canvas-stage',[{name:'中文笔记.MARKDOWN',text:markdown},{name:'原样.txt',text:'# 不是标题\n* 保留星号\n<script>原文</script>'},{name:'空文档.md'}],point);
  await page.waitForFunction(()=>window.snapshot().nodes.filter(n=>JSON.parse(n.payloadJson).note_type==='document').length===3);
  const nodes=await documents();
  assert.equal(JSON.parse(nodes[0].payloadJson).text,markdown);
  for(const node of nodes) assert.equal(node.width/node.height,3/4);
  const first=page.locator(`[data-canvas-node-id="${nodes[0].id}"]`);
  await first.getByText('正文 加粗 与中文。',{exact:false}).waitFor();
  const bounds=await first.boundingBox();
  assert.ok(Math.abs(bounds.x+bounds.width/2-point.x)<2,'frozen canvas drop X');
  assert.ok(Math.abs(bounds.y+bounds.height/2-point.y)<2,'frozen canvas drop Y');
  const txt=page.locator(`[data-canvas-node-id="${nodes[1].id}"]`);
  await txt.getByText('# 不是标题',{exact:false}).waitFor();
  assert.match(await txt.innerText(),/\* 保留星号/);
  assert.match(await txt.innerText(),/<script>原文<\/script>/);
  assert.equal(await txt.locator('script').count(),0);
  assert.ok(await page.evaluate(()=>window.mediaImports.every(i=>i.projectId==='p')));
  await mkdir('.tmp/text-file-drop',{recursive:true});
  await page.screenshot({path:'.tmp/text-file-drop/canvas.png'});
  await page.evaluate(()=>window.save()); await page.reload();
  await page.locator(`[data-canvas-node-id="${nodes[0].id}"]`).waitFor();
  assert.equal((await documents()).length,3);
  // Existing imported library documents use the same document-card placement.
  await drop('.canvas-stage',[{name:'内部拖动.md',text:'内部文本'}],point);
  await page.waitForFunction(()=>window.mediaImports.length===1);
  await page.waitForFunction(()=>window.snapshot().nodes.filter(n=>JSON.parse(n.payloadJson).note_type==='document').length===4);
  await page.evaluate(async point=>{
    const {setDragAssets}=await import('/src/lib/dragPayload.ts'); setDragAssets([window.mediaImports[0].asset.id]);
    const stage=document.querySelector('.canvas-stage'); const dt=new DataTransfer();dt.setData('text/plain','bowerbird-assets');
    for(const type of ['dragover','drop']) stage.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt,clientX:point.x,clientY:point.y}));
    setDragAssets(null);
  },point);
  await page.waitForFunction(()=>window.snapshot().nodes.filter(n=>JSON.parse(n.payloadJson).note_type==='document').length===5);
  assert.equal(await page.evaluate(()=>window.mediaImports.length),1,'internal drop does not import a second file');
  // Failed reads retain the imported original but create no empty canvas card.
  await page.evaluate(()=>{window.failTextRead=true;});
  await drop('.canvas-stage',[{name:'不可读.txt',text:'text'}],point);
  await page.getByText(/已加入素材库，但放置未完成/).waitFor();
  assert.equal((await documents()).length,5);
  // A late import stays in the captured project even after navigation.
  await page.evaluate(()=>{window.failTextRead=false;window.holdMedia=true;});
  await drop('.canvas-stage',[{name:'迟到.md',text:'固定项目'}],point);
  await page.waitForFunction(()=>window.releaseMedia);
  await page.evaluate(()=>{window.store.setState({activeProjectId:'q',projectRouteRevision:window.store.getState().projectRouteRevision+1});window.holdMedia=false;window.releaseMedia();});
  await page.waitForFunction(()=>window.calls.some(c=>c.command==='project_canvas_node_create'&&JSON.parse(c.args.value.payloadJson).text==='固定项目'));
  assert.equal(await page.evaluate(()=>window.calls.find(c=>c.command==='project_canvas_node_create'&&JSON.parse(c.args.value.payloadJson).text==='固定项目').args.value.projectId),'p');

  await page.goto(url('&media-home&canvas-library'));
  await page.locator('.library-home').waitFor();
  await drop('main',[{name:'素材库.md',text:'# 正文\n\n素材库文本'}]);
  await page.waitForFunction(()=>window.mediaImports.length===1);
  await page.evaluate(async()=>{window.__textDropMode=(await import('/src/lib/localFileMode.ts')).useLocalFileMode;});
  await page.waitForFunction(()=>window.__textDropMode.getState().media==='texts');
  assert.equal(await page.evaluate(()=>window.mediaImports[0].projectId),null);
  await page.locator('[data-asset-id="media-0"]').waitFor();
  await page.evaluate(()=>{window.textFiles={'D:/draft.txt':'带路径的原文'};});
  await drop('main',[{name:'draft.txt',path:'D:/draft.txt'}]);
  await page.waitForFunction(()=>window.mediaImports.length===2);
  assert.equal(await page.evaluate(()=>window.mediaCalls.find(c=>c.command==='import_files').args.collect),true);
  await drop('main',[{name:'混合.md',text:'文本'},{name:'picture.png',text:'png fixture'}]);
  await page.waitForFunction(()=>window.__textDropMode.getState().media==='all');
  assert.deepEqual(errors,[]);
  console.log('text file drop: path/blob, TXT/Markdown/empty, canvas placement/reload, internal drag, failed reads, route freeze, library/mixed filters passed');
} finally {await browser.close();await server.close();}
