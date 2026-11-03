import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({server:{host:'127.0.0.1',port:0,hmr:false,watch:null}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
try {
 await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html`);
 const body=page.getByRole('textbox',{name:'文档正文',exact:true});await body.waitFor();
 assert.equal(await page.locator('.text-workspace-header').count(),0);
 assert.equal(await page.getByRole('button',{name:'源码',exact:true}).count(),0);
 assert.equal(await page.locator('.text-workspace-library').getAttribute('aria-hidden'),'true');
 const toolbar=page.getByRole('toolbar',{name:'文字格式'});
 for(const name of ['返回','保存到集合','保存到项目','添加到生成对话框']) assert.equal(await toolbar.getByRole('button',{name,exact:true}).count(),1);
 await toolbar.getByRole('textbox',{name:'文档名称'}).fill('改名后的文档');
 const before=await body.boundingBox();
 await page.getByRole('button',{name:'打开素材库',exact:true}).click();
 assert.notEqual(await body.evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
 await page.waitForTimeout(80);
 const middle=await body.boundingBox();
 await page.waitForTimeout(320);
 const after=await body.boundingBox();assert(after.x>before.x+300);assert(middle.x>before.x && middle.x<after.x);
 const back=await toolbar.getByRole('button',{name:'返回',exact:true}).boundingBox();
 const handle=await page.getByRole('separator',{name:'调整素材库宽度'}).boundingBox();assert(handle.y>back.y+back.height);
 await toolbar.getByRole('button',{name:'保存到项目',exact:true}).click();await page.getByRole('button',{name:'秋日短片',exact:true}).click();
 await page.waitForFunction(()=>window.calls.some(c=>c.command==='create_text_document'&&c.args.input.title==='改名后的文档'));
 await mkdir('.tmp/text-workspace-layout',{recursive:true});
 for(const width of [1440,900]) {await page.setViewportSize({width,height:900});for(const theme of ['light','dark']) {await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.screenshot({path:`.tmp/text-workspace-layout/${theme}-${width}.png`});}}
 await page.emulateMedia({reducedMotion:'reduce'});
 assert(await body.evaluate(el=>parseFloat(getComputedStyle(el).transitionDuration))<0.001);
 console.log('PASS workspace toolbar, rename/save, collapsed library, animated layout and handle clearance');
} finally {await browser.close();await server.close();}
