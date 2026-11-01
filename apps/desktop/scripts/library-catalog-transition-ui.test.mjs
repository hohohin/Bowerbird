import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const output = '.tmp/sidebar-install';
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 17958, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
const switchTo = name => page.getByRole('tab', { name, exact: true }).click();
async function sample(t) {
 return page.evaluate(t => {
  const read = direction => {
   const el = document.querySelector(`[data-sidebar-motion=${direction}]`);
   el.getAnimations().forEach(a => { a.pause(); a.currentTime = t; });
   const s = getComputedStyle(el), r = el.getBoundingClientRect();
   return { opacity: +s.opacity, blur:s.filter, visibility:s.visibility, shadow:s.boxShadow, x:new DOMMatrix(s.transform).m41, y:r.y, height:r.height, topLayer:el.matches(':popover-open') };
  };
  const slot = document.querySelector('.library-catalog-layer:not([data-outgoing]) [data-sidebar-slot]').getBoundingClientRect();
  return { next:read('incoming'), old:read('outgoing'), slot:{y:slot.y,height:slot.height} };
 }, t);
}
async function finish() {
 await page.evaluate(() => document.querySelectorAll('[data-sidebar-motion]').forEach(el => el.getAnimations().forEach(a => a.finish())));
 await page.waitForFunction(() => !document.querySelector('[data-sidebar-motion]'));
}
try {
 await mkdir(output,{recursive:true});
 await page.goto('http://127.0.0.1:17958/scripts/fixtures/connected-collections/preview.html');
 await page.getByRole('treeitem',{name:'素材目录',exact:true}).waitFor();
 assert.equal(await page.locator('[data-sidebar-motion]').count(),0);
 for(const [theme,name] of [['dark','标签分类'],['light','集合分类']]) {
  await page.evaluate(t => document.documentElement.dataset.theme=t,theme);
  await switchTo(name); await page.waitForTimeout(30);
  assert.equal(await page.locator('[data-sidebar-motion]').count(),2,'full sidebars replace the wipe');
  const entering=await sample(210);
  assert.ok(entering.next.opacity>0 && entering.next.opacity<1 && entering.next.x<0 && entering.next.x>-48);
  assert.notEqual(entering.next.shadow,'none');
  const hover=await sample(350);
  assert.equal(hover.next.opacity,1); assert.equal(hover.next.topLayer,true);
  assert.ok(Math.abs(hover.next.y-hover.slot.y+20)<.2);
  assert.equal(hover.next.height,hover.slot.height); assert.equal(hover.old.y,hover.slot.y);
  assert.equal(hover.old.blur,'blur(3px)');
  const installing=await sample(490);
  assert.equal(installing.next.opacity,1); assert.equal(installing.old.visibility,'hidden');
  assert.ok(installing.next.y>hover.next.y && installing.next.y<hover.slot.y);
  for(const [t,opacity] of [[591,.58],[641,1],[691,.58],[741,1],[790,1]]) {
   const s=await sample(t); assert.ok(Math.abs(s.next.opacity-opacity)<.001,`flash at ${t}: ${JSON.stringify(s)}`);
   assert.ok(Math.abs(s.next.y-s.slot.y)<.2); assert.equal(s.old.visibility,'hidden');
  }
  await sample(350); await page.screenshot({path:`${output}/${theme}-floating.png`}); await finish();
  assert.equal(await page.locator('.library-catalog-layer').count(),1);
  assert.equal(await page.locator('[data-sidebar-slot]').count(),0);
 }
 for(const t of [150,450,650]) {
  await switchTo('标签分类'); await sample(t); await switchTo('集合分类'); await sample(350); await finish();
  assert.equal(await page.locator(':popover-open').count(),0);
 }
 await switchTo('标签分类'); await sample(350);
 await page.setViewportSize({width:820,height:700});
 await page.waitForTimeout(60);
 const resized=await sample(350); assert.equal(resized.next.height,resized.slot.height);
 await page.locator('.library-pane-content').evaluate(el => el.setAttribute('aria-hidden','true'));
 await page.waitForFunction(() => !document.querySelector('[data-sidebar-motion]'));
 assert.equal(await page.locator(':popover-open').count(),0,'hidden host cleans up top layer');
 await page.locator('.library-pane-content').evaluate(el => el.removeAttribute('aria-hidden'));
 await switchTo('集合分类'); await page.emulateMedia({reducedMotion:'reduce'});
 await page.waitForFunction(() => !document.querySelector('[data-sidebar-motion]'));
 await switchTo('标签分类'); await switchTo('集合分类'); assert.equal(await page.locator('[data-sidebar-motion]').count(),0);
 await page.getByRole('treeitem',{name:'风景',exact:true}).click();
 assert.equal(await page.getByRole('treeitem',{name:'风景',exact:true}).getAttribute('aria-selected'),'true');
 await switchTo('全部'); assert.equal(await page.locator('[data-sidebar-motion]').count(),0);
 await page.setViewportSize({width:1280,height:840});
 await page.emulateMedia({reducedMotion:'no-preference'});
 await switchTo('标签分类');
 await page.getByRole('button',{name:'向右分栏',exact:true}).click();
 const panes=page.locator('.library-pane-content');
 await panes.first().getByRole('tab',{name:'集合分类',exact:true}).click();
 assert.equal(await panes.last().locator('[data-sidebar-motion]').count(),0,'other pane stays still');
 await panes.first().getByRole('button',{name:'关闭此栏',exact:true}).click();
 assert.equal(await page.locator(':popover-open').count(),0,'unmount cleans up top layer');
 console.log('PASS home, split, resize and cancellation; checking canvas');
 await page.goto('http://127.0.0.1:17958/scripts/fixtures/canvas-reference/preview.html?source-library');
 await page.waitForFunction(() => document.querySelector('.canvas-workspace')?.getAttribute('aria-busy') === 'false');
 await page.evaluate(async () => {
  const previous=window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke=(command,args) => command==='folder_connections'?Promise.resolve([]):previous(command,args);
  const mode=(await import('/src/lib/localFileMode.ts')).useLocalFileMode;
  mode.getState().setCatalogView('tags');
 });
 await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab');
 await page.getByRole('region',{name:'按标签浏览素材',exact:true}).waitFor();
 await page.locator('.canvas-source-panel [role="tab"][aria-selected="true"]').click();
 const drawer=await sample(350);
 assert.ok(Math.abs(drawer.next.y-drawer.slot.y+20)<.2,'canvas drawer also floats 20px');
 await page.screenshot({path:`${output}/canvas-floating.png`});
 await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab');
 await page.waitForFunction(() => !document.querySelector('[data-sidebar-motion]'));
 assert.equal(await page.locator(':popover-open').count(),0,'collapsing real drawer cleans up');
 await page.evaluate(async () => (await import('/src/lib/localFileMode.ts')).useLocalFileMode.getState().setCatalogView('tags'));
 assert.equal(await page.locator(':popover-open').count(),0,'closed drawer never opens floating panels');
 assert.deepEqual(errors,[]);
 console.log('PASS: full sidebars, 20px float, slide/fade/shadow, stationary blur, post-install flashes, interruption and reduced motion');
} finally { await browser.close(); await server.close(); }
