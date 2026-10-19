import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({cacheDir:'.tmp/tag-overlay-vite',server:{host:'127.0.0.1',port:1697,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1400,height:900}});
page.setDefaultTimeout(10000);
try {
  await page.goto('http://127.0.0.1:1697/scripts/fixtures/canvas-reference/preview.html?detail-route');
  await page.waitForFunction(()=>!!window.store);
  await page.evaluate(()=>{
    const previous=window.__TAURI_INTERNALS__.invoke;
    const labels=Array.from({length:27},(_,i)=>({id:`tag-${i}`,name:`分类标签${i}`,description:'',enabled:true,count:0,has_examples:false}));
    window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
      if(command==='local_classification_labels') return labels;
      if(command==='global_classification_view') return {labels,pictures:[]};
      return previous(command,args);
    };
    window.store.setState({activeProjectId:null});
  });
  await page.getByRole('tab',{name:'全局素材',exact:true}).click();
  const bar=page.locator('.local-file-workspace .library-tag-bar');
  await bar.locator('.library-tag-menu button').first().waitFor({state:'attached'});
  await mkdir('.tmp/tag-overlay',{recursive:true});
  // Use the full App shell: the smaller LibraryHome fixture misses the flex
  // ancestor whose automatic minimum height used to push tags below the window.
  for (const height of [900,600]) {
    await page.setViewportSize({width:1400,height});
    await page.mouse.click(700,300);
    await page.waitForTimeout(300);
    assert.equal(await bar.locator('.library-tag-content').isVisible(),false,'tags remain hidden away from the edge');
    const rect=await bar.boundingBox();
    assert.ok(rect.y+rect.height<=height,'tag overlay must fit inside the window');
    await page.mouse.move(rect.x+rect.width-10,300);
    await page.waitForTimeout(500);
    const first=bar.locator('.library-tag-menu button').first();
    assert.equal(await first.isVisible(),true,'hover reveals category tags');
    const firstRect=await first.boundingBox();
    assert.ok(firstRect.y>=0 && firstRect.y+firstRect.height<=height,'first tag must be on screen');
    const manage=bar.getByRole('button',{name:'管理标签',exact:true});
    assert.equal(await manage.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}),true,'manager must be on screen and unobstructed');
    await page.screenshot({path:`.tmp/tag-overlay/home-${height}.png`});
    await manage.click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({state:'hidden'});
  }
  await bar.getByRole('button',{name:'显示标签列表',exact:true}).click();
  await bar.getByRole('button',{name:'分类标签0',exact:true}).click();
  const chip=page.getByRole('group',{name:'当前标签：分类标签0',exact:true});
  await chip.waitFor();
  const tabs=await page.getByRole('tablist',{name:'素材视图切换条'}).boundingBox();
  assert.ok((await chip.boundingBox()).x>=tabs.x+tabs.width,'active tag is to the right of the view switch');
  await page.screenshot({path:'.tmp/tag-overlay/home-filter.png'});
  await chip.getByRole('button').click();
  await chip.waitFor({state:'hidden'});
  await page.goto('http://127.0.0.1:1697/scripts/fixtures/canvas-reference/preview.html?source-library');
  await page.getByRole('button',{name:'展开画板素材库',exact:true}).click();
  const project=page.getByRole('complementary',{name:'画板素材库',exact:true});
  await project.getByRole('button',{name:'显示标签列表',exact:true}).click();
  await project.getByRole('button',{name:'插画',exact:true}).click();
  await project.getByRole('group',{name:'当前标签：插画',exact:true}).waitFor();
  await page.screenshot({path:'.tmp/tag-overlay/project-filter.png'});
  await project.getByRole('button',{name:'清除标签筛选：插画',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.store.getState().smartFilter),null);
  assert.equal(await project.locator('.library-tag-filter').count(),0);
  console.log('PASS: full App home tag hover, management click, and short-window layout');
} finally {await browser.close();await server.close();}
