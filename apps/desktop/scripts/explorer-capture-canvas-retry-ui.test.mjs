import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ cacheDir: '.tmp/explorer-capture-history/canvas-vite', server: { host:'127.0.0.1',port:1875,strictPort:true,hmr:false,watch:null } });
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1500,height:900}});
page.setDefaultTimeout(6000);
const nodes = () => page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId === 'collected'));
const settled = () => page.waitForFunction(() => !document.querySelector('.explore-capture-status'));
async function drop() {
  return page.locator('[data-canvas-stage]').evaluate(element => {
    const rect = element.getBoundingClientRect(), clientX = Math.floor(rect.left + rect.width / 2), clientY = Math.floor(rect.top + rect.height / 2);
    const matrix = new DOMMatrix(getComputedStyle(document.querySelector('.canvas-plane')).transform);
    const point = {x:(clientX-rect.left-matrix.e)/matrix.a,y:(clientY-rect.top-matrix.f)/matrix.d};
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-bowerbird-explorer',JSON.stringify({version:1,imageUrl:'https://i.pinimg.com/image.png',pageUrl:'https://www.pinterest.com/pin/1'}));
    element.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer,clientX,clientY}));return point;
  });
}
try {
  await page.goto('http://127.0.0.1:1875/scripts/fixtures/canvas-reference/preview.html?explorer');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => { window.failNodeSave = true; });
  const point = await drop(); await settled();
  const failedCreate = await page.evaluate(() => window.calls.filter(call => call.command === 'project_canvas_node_create').at(-1).args.value);
  assert.equal((await nodes()).length,0);
  await page.getByRole('button',{name:'采集记录',exact:true}).click();
  const row = page.locator('.explorer-capture-row[data-capture-state="failed"]').filter({hasText:'已入库，交付未完成'});
  await row.waitFor();
  await page.evaluate(() => { window.failNodeSave = false; });
  await row.getByRole('button',{name:'重试',exact:true}).click(); await settled();
  const retried = await nodes();
  assert.equal(retried.length,1,'delivery retry must retry the retained journal entry');
  assert.equal(retried[0].id,failedCreate.id,'retry preserves original node identity');
  assert.deepEqual([retried[0].x,retried[0].y],[failedCreate.x,failedCreate.y],'retry preserves exact first write coordinates');
  assert.ok(Math.abs(retried[0].x+retried[0].width/2-point.x)<.01 && Math.abs(retried[0].y+retried[0].height/2-point.y)<.01,'retry preserves original drop point');
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'capture_source_browser_image').length),1,'retry never redownloads saved media');
  await page.keyboard.press('Escape'); await drop(); await settled();
  const distinct = await nodes(); assert.equal(distinct.length,2); assert.notEqual(distinct[0].id,distinct[1].id,'independent drops still produce distinct nodes');
  await page.evaluate(() => window.save()); await page.reload();
  await page.locator(`[data-canvas-node-id="${distinct[1].id}"]`).waitFor();
  assert.deepEqual(await nodes(),distinct,'retry outcome survives real canvas fixture reload');
  console.log('PASS real CanvasWorkspace retained journal retry: one asset download, same node id and point, independent drop instances, persisted reload');
} finally { await browser.close(); await server.close(); }
