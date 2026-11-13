import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({cacheDir:'.tmp/manual-gallery/vite',server:{host:'127.0.0.1',port:17962,strictPort:true,hmr:false,watch:null}});
await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1150,height:650}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/manual-gallery/preview.html`);
  const check=page.getByRole('checkbox',{name:'并入上个生成'});
  await check.waitFor();await page.waitForFunction(()=>!document.querySelector('.composer-join-previous input').disabled);
  assert.equal(await check.isChecked(),false);assert.equal(await page.getByRole('button',{name:'使用说明',exact:true}).count(),0);
  await check.hover();
  const jump=page.getByRole('button',{name:'打开会话：蓝色玻璃杯的棚拍'});
  await jump.hover();
  assert.equal(await check.isChecked(),false);
  await jump.click();
  await page.getByTestId('session').getByText('蓝色玻璃杯的棚拍',{exact:true}).first().waitFor();
  await page.getByTestId('session').getByText('改变杯子的角度',{exact:true}).first().waitFor();
  assert.deepEqual(await page.evaluate(()=>{const s=window.store.getState();return [s.activeJobId,s.genPanelOpen,s.creativeNavigation?.threadId]}),['previous',true,'original-thread']);
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command==='merge_generation_galleries')),false);
  await page.evaluate(()=>window.store.setState({boardOpen:true,genPanelOpen:false}));
  await check.focus();await page.keyboard.press('Tab');
  assert.equal(await jump.evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Escape');
  assert.equal(await jump.count(),0);
  assert.equal(await check.evaluate(el=>el===document.activeElement),true);
  await page.locator('.ProseMirror').fill('蓝色玻璃杯，柔和光线');
  await check.focus();await page.keyboard.press('Space');assert.equal(await check.isChecked(),true);
  const send=page.locator('.composer-send button');
  await page.evaluate(()=>{window.holdStart=true;});await send.click();
  await page.waitForFunction(()=>!!window.releaseStart);
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='merge_generation_galleries').length),0);
  await page.evaluate(()=>{window.previous.p='unrelated-later-job';window.releaseStart();});
  await page.waitForFunction(()=>window.calls.some(c=>c.command==='merge_generation_galleries'));
  const submitted=await page.evaluate(()=>({call:window.calls.find(c=>c.command==='merge_generation_galleries'),args:window.started}));
  assert.deepEqual(submitted.call.args.input,{jobIds:['previous','new'],projectId:'p'});
  assert.equal(submitted.args[5],undefined,'joining must not change the model conversation');assert.deepEqual(submitted.args[1],[],'joining must not add the previous image as a reference');
  await page.waitForFunction(()=>window.notices.some(n=>n.action?.label==='撤销'));
  await page.evaluate(()=>window.notices.find(n=>n.action?.label==='撤销').action.onClick());
  await page.waitForFunction(()=>window.calls.some(c=>c.command==='undo_generation_gallery_merge'));
  await page.evaluate(()=>{window.holdStart=false;window.calls=[];});await page.locator('.ProseMirror').click();await page.locator('.ProseMirror').fill('蓝色玻璃杯，柔和光线');await check.uncheck();await send.click();
  await page.waitForFunction(()=>!document.querySelector('.composer-send button').disabled);
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command==='merge_generation_galleries')),false);
  await page.locator('.ProseMirror').click();await page.locator('.ProseMirror').fill('新的提示词');
  await page.evaluate(()=>window.switchProject('q'));
  await page.waitForFunction(()=>document.querySelector('.composer-join-previous input').disabled);
  assert.equal(await check.isChecked(),false);
  await page.locator('.composer-join-previous').hover();
  await page.getByText('当前项目还没有可并入的图片生成',{exact:true}).waitFor();
  assert.equal(await jump.count(),0);
  await page.evaluate(()=>{window.previous.p='previous';window.switchProject('p');});
  await page.waitForFunction(()=>!document.querySelector('.composer-join-previous input').disabled);
  await check.check();await page.evaluate(()=>{window.rejectStart=true;window.calls=[];});await send.click();
  await page.waitForFunction(()=>window.notices.some(n=>n.tone==='error'));
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command==='merge_generation_galleries')),false,'failed submission never changes groups');
  await page.evaluate(()=>window.openMulti());await page.getByRole('menuitem',{name:'合为组图',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.command==='merge_generation_galleries'));
  assert.deepEqual(await page.evaluate(()=>window.calls.find(c=>c.command==='merge_generation_galleries').args.input.assetIds),['a','b']);
  mkdirSync('.tmp/manual-gallery',{recursive:true});
  // Desktop shell has a 760px minimum window; narrow panes are separate containers.
  for(const width of [1080,560,380]){
    await page.evaluate(width=>{const host=document.querySelector('main');host.style.right='auto';host.style.width=`${width}px`;},width);
    await page.waitForTimeout(100);
    const box=await check.locator('..').boundingBox(),button=await send.boundingBox();
    assert.ok(box.x+box.width<=button.x+1||box.y+box.height<=button.y,'checkbox and send must not overlap');
    assert.ok(box.x>=0&&button.x+button.width<=width,`controls stay within ${width}px pane`);
  }
  await page.evaluate(()=>{const host=document.querySelector('main');host.style.width='';host.style.right='0';});await check.check();await page.screenshot({path:'.tmp/manual-gallery/dark.png'});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');await page.screenshot({path:'.tmp/manual-gallery/light.png'});
  await page.setViewportSize({width:1600,height:1000});
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(()=>{
    const snapshot=window.snapshot(),base=snapshot.nodes[0];
    snapshot.nodes=['a','b'].map((assetId,index)=>({...base,id:`manual-${assetId}`,assetId,x:180+index*350,y:150,createdAt:index+1,
      payloadJson:JSON.stringify({schema_version:1,snapshot:{name:assetId,width:190,height:150}})}));
    snapshot.edges=[];snapshot.view={...snapshot.view,panX:0,panY:0,zoom:1};sessionStorage.setItem('reference-fixture',JSON.stringify(snapshot));
  });
  await page.reload();await page.locator('[data-canvas-node-id="manual-a"]').waitFor();
  await page.evaluate(()=>{
    const original=window.__TAURI_INTERNALS__.invoke;window.galleryCalls=[];window.manualMerged=false;
    window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
      if(command==='merge_generation_galleries'){
        window.galleryCalls.push({command,args});window.manualMerged=true;window.emitAssetsChanged();
        return {groupKey:'manual:canvas',previous:{'asset:a':null,'asset:b':null}};
      }
      if(command==='undo_generation_gallery_merge'){window.galleryCalls.push({command,args});window.manualMerged=false;window.emitAssetsChanged();return;}
      const value=await original(command,args);
      if(command==='project_canvas_get'&&window.manualMerged)return {...value,nodes:value.nodes.map(node=>({...node,payloadJson:JSON.stringify({...JSON.parse(node.payloadJson),workflow_generation_group:'manual:canvas',generation_gallery_key:'manual:canvas',manual_gallery_node:true})}))};
      return value;
    };
  });
  const first=page.locator('[data-canvas-node-id="manual-a"]'),second=page.locator('[data-canvas-node-id="manual-b"]');
  await first.click({modifiers:['Control']});await second.click({modifiers:['Control']});await second.click({button:'right'});
  await page.getByRole('menuitem',{name:'合为组图',exact:true}).click();
  await page.waitForFunction(()=>window.galleryCalls.length===1);
  assert.deepEqual((await page.evaluate(()=>window.galleryCalls[0].args.input.nodeIds)).sort(),['manual-a','manual-b']);
  await page.waitForFunction(()=>document.querySelectorAll('[data-canvas-node-id="manual-b"]').length===0);
  await page.getByRole('button',{name:'撤销画布操作',exact:true}).click();
  await second.waitFor();assert.equal(await first.count(),1);
  assert.deepEqual(errors,[]);console.log('PASS: explicit join, frozen target, no reference/context injection, unchecked/failed/project isolation, manual menu, undo, keyboard and narrow layout');
}catch(error){mkdirSync('.tmp/manual-gallery',{recursive:true});await page.screenshot({path:'.tmp/manual-gallery/failure.png'});console.error('Page errors:',errors);throw error;}finally{await browser.close();await server.close();}
