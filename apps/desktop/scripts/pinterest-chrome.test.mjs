import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
import {chromeFixture} from './fixtures/pinterest-layout/chrome.mjs';
import {imageFor} from './fixtures/pinterest-layout/page.mjs';
const runtime=await readFile(process.env.BOWERBIRD_SCROLLBAR_RUNTIME_PATH||'src/lib/overlayScrollbars.js','utf8');
const css=await readFile('src/components/OverlayScrollbars.css','utf8');
const chrome=(await readFile(process.env.BOWERBIRD_PINTEREST_CHROME_PATH||'src-tauri/src/commands/source_browser_pinterest_chrome.js','utf8'))
 .replace('__BOWERBIRD_SCROLLBAR_RUNTIME__',runtime).replace('__BOWERBIRD_SCROLLBAR_CSS__',JSON.stringify(css))+'\n//# sourceURL=bowerbird-pinterest-chrome.js';
const layout=await readFile('src-tauri/src/commands/source_browser_pinterest_layout.js','utf8');
const browser=await chromium.launch({channel:'chrome',headless:true,ignoreDefaultArgs:['--hide-scrollbars']});
const page=await browser.newPage({viewport:{width:460,height:700}});
const coverageOutput=process.env.BOWERBIRD_PINTEREST_CHROME_COVERAGE;
let coverageStopped=false;
if(coverageOutput)await page.coverage.startJSCoverage({resetOnNavigation:false,reportAnonymousScripts:true});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await mkdir('.tmp/pinterest-chrome',{recursive:true});
await page.route('**/*',route=>route.fulfill({contentType:route.request().url().includes('i.pinimg.com')?'image/svg+xml':'text/html; charset=utf-8',body:route.request().url().includes('i.pinimg.com')?imageFor(route.request().url()):chromeFixture()}));
try{
 await page.addInitScript(chrome);await page.addInitScript(layout);
 await page.goto('https://www.pinterest.com/lens-search/');
 assert.ok(await page.waitForFunction(()=>document.documentElement.hasAttribute('data-bowerbird-pin-nav'),null,{timeout:3000}).then(()=>true,()=>false),'Pinterest chrome initializes on its allowed origin');
 for(const width of [320,460,900]){
  await page.setViewportSize({width,height:700});await page.waitForTimeout(200);
  const size=await page.evaluate(()=>({width:innerWidth,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,nav:document.querySelector('#VerticalNavContent').getBoundingClientRect().width,inset:document.querySelector('.mainContainer').getBoundingClientRect().left}));
  assert.deepEqual(size,{width,client:width,scroll:width,nav:36,inset:36});
  await page.evaluate(()=>window.scrollBy(0,100));await page.waitForTimeout(220);
  const rail=page.locator('body > .industrial-scrollbar[data-axis="y"]:not([hidden])');
  assert.equal(await rail.count(),1);
  const appearance=await rail.evaluate(n=>({opacity:getComputedStyle(n).opacity,width:n.querySelector('span').getBoundingClientRect().width,pattern:getComputedStyle(n.querySelector('span')).backgroundImage}));
  assert.equal(appearance.opacity,'0.5');assert.equal(appearance.width,4);assert.match(appearance.pattern,/repeating-linear-gradient/);
  await page.screenshot({path:'.tmp/pinterest-chrome/'+width+'.png'});
  await page.waitForTimeout(950);assert.equal(await rail.evaluate(n=>getComputedStyle(n).opacity),'0');
  assert.equal(await rail.getAttribute('tabindex'),'-1');
 }
 await page.evaluate(()=>window.scrollTo(0,120));await page.waitForTimeout(150);
 const rootRail=page.locator('body > .industrial-scrollbar[data-axis="y"]:not([hidden])');
 await rootRail.focus();await page.keyboard.press('PageDown');
 assert.ok(await page.evaluate(()=>scrollY>120),'overlay keyboard scrolls the real document');
 await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>scrollY),0);
 await page.evaluate(()=>window.scrollTo(0,120));await page.waitForTimeout(150);
 const thumb=await rootRail.locator('span').boundingBox();
 await page.mouse.move(thumb.x+thumb.width/2,thumb.y+thumb.height/2);await page.mouse.down();
 await page.mouse.move(thumb.x+thumb.width/2,thumb.y+thumb.height/2+30,{steps:4});await page.mouse.up();
 assert.ok(await page.evaluate(()=>scrollY>120),'overlay thumb drags the real document');
 const scrollBeforeWheel=await page.evaluate(()=>scrollY);
 const movingThumb=await rootRail.locator('span').boundingBox();
 await page.mouse.move(movingThumb.x+2,movingThumb.y+movingThumb.height/2);await page.mouse.wheel(0,40);
 await page.waitForFunction(before=>scrollY>before,scrollBeforeWheel);
 await page.evaluate(()=>window.scrollTo(0,0));await page.getByRole('button',{name:'消息',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.navClicks),1);
 await page.waitForFunction(()=>document.querySelector('.mainContainer').getBoundingClientRect().left===276);
 assert.equal(await page.locator('#expanded-sidebar').evaluate(n=>n.getBoundingClientRect().left),36);
 await page.evaluate(()=>{document.querySelector('#expanded-sidebar').hidden=true;document.querySelector('#page-inset').style.paddingLeft='72px';});
 const nested=page.locator('#nested-scroll');await nested.scrollIntoViewIfNeeded();
 await page.waitForFunction(()=>window.appendCount===12);
 await page.evaluate(()=>Promise.all([...document.images].map(image=>image.decode())));
 await nested.scrollIntoViewIfNeeded();await nested.hover();
 await page.mouse.wheel(0,100);await page.waitForTimeout(220);
 const nestedRail=nested.locator('.industrial-scrollbar[data-axis="y"]');
 await nestedRail.focus();await page.keyboard.press('End');assert.equal(await nested.evaluate(n=>n.scrollTop+n.clientHeight),600);
 assert.equal(await nested.evaluate(n=>n.offsetWidth-n.clientWidth),2,'only the border remains, no scrollbar gutter');
 await page.evaluate(()=>{document.querySelector('#VerticalNavContent').remove();history.pushState({},'', '/pin/123/');});
 await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-bowerbird-pin-nav'));
 assert.equal(await page.locator('#page-inset').getAttribute('style'),'padding-left: 72px;','native inset survives removal of our adaptation');
 assert.equal(await page.locator('[data-bowerbird-lens]').count(),0);
 if(coverageOutput){await writeFile(coverageOutput,JSON.stringify(await page.coverage.stopJSCoverage()));coverageStopped=true;}
 await page.goto('https://pinterest.com.evil.test/');assert.equal(await page.locator('.industrial-scrollbar').count(),0);
 assert.equal(await page.locator('#VerticalNavContent').evaluate(n=>n.getBoundingClientRect().width),72);
 assert.deepEqual(errors,[]);
 console.log('PASS Pinterest zero-gutter overlay scrolling, 36px navigation, native sidebar, nested scroll and origin isolation');
}finally{
 if(coverageOutput&&!coverageStopped)await writeFile(coverageOutput,JSON.stringify(await page.coverage.stopJSCoverage()));
 await browser.close();
}
