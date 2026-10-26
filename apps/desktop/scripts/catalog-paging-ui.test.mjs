import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({cacheDir:'.tmp/catalog-paging/vite',server:{host:'127.0.0.1',port:17893,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:840}});
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
const cards=()=>page.locator('.catalog-virtual [data-asset-id]');
const scroller=()=>page.locator('.catalog-scroller');
async function ready() { await cards().first().waitFor(); await page.waitForFunction(()=>window.inFlight===0); }
try {
  await mkdir('.tmp/catalog-paging',{recursive:true});
  await page.goto('http://127.0.0.1:17893/scripts/fixtures/catalog-paging/preview.html');
  await ready();
  const initial=await page.evaluate(()=>({cards:document.querySelectorAll('[data-asset-id]').length,requests:window.requests.filter(r=>r.command==='catalog_page').length,height:document.querySelector('.catalog-scroller').scrollHeight}));
  assert.ok(initial.cards<180,JSON.stringify(initial)); assert.ok(initial.requests<=3);
  assert.ok(initial.height>1000000);
  await page.waitForFunction(()=>{const img=document.querySelector('[data-asset-id] img');return img?.complete&&img.naturalWidth>0;});
  await page.waitForTimeout(600);
  await page.screenshot({path:'.tmp/catalog-paging/300k-first.png'});
  await page.locator('[data-asset-id="asset-0"]').click({modifiers:['Control']});
  // Random access to deep pages must not fetch every intervening page.
  await scroller().evaluate(el=>{el.scrollTop=el.scrollHeight*.7;}); await ready();
  await page.waitForFunction(()=>window.requests.some(r=>r.command==='catalog_page'&&r.args.offset>100000));
  const mounted=await page.evaluate(()=>{
    const view=document.querySelector('.catalog-scroller').getBoundingClientRect();
    const cards=[...document.querySelectorAll('[data-asset-id]')];
    return {total:cards.length,near:cards.filter(card=>{const box=card.getBoundingClientRect();return box.bottom>=view.top-500&&box.top<=view.bottom+500;}).length};
  });
  // The selected first page keeps keyboard focus while the denser continuous
  // layout fills the viewport; allow that one retained page separately.
  assert.ok(mounted.near<180&&mounted.total-mounted.near<=60,JSON.stringify(mounted));
  await scroller().evaluate(el=>{el.scrollTop=el.scrollHeight;}); await ready();
  await page.locator('[data-asset-id="asset-299999"]').waitFor();
  assert.ok(await page.evaluate(()=>window.requests.filter(r=>r.command==='catalog_page').length)<15);
  await page.locator('[data-asset-id="asset-299999"]').click({modifiers:['Shift']});
  await page.getByText('300000 项',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.requests.some(r=>r.command==='get_assets_by_ids')),false,'range selection must only fetch IDs');
  await page.getByRole('button',{name:'取消选择',exact:true}).click();
  await page.setViewportSize({width:440,height:720});
  await page.evaluate(()=>window.store.setState({libraryThumbnailWidth:280}));
  await page.waitForTimeout(80);
  await scroller().evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await page.locator('[data-asset-id="asset-299999"]').waitFor();
  assert.ok(await scroller().evaluate(el=>el.scrollHeight)<=8000001);
  await page.screenshot({path:'.tmp/catalog-paging/300k-narrow-last.png'});
  await page.setViewportSize({width:1280,height:840}); await page.evaluate(()=>window.store.setState({libraryThumbnailWidth:150}));
  // Cache and DOM remain bounded across widely separated visits.
  for(let i=0;i<22;i++) { await scroller().evaluate((el,i)=>{el.scrollTop=el.scrollHeight*(i/24);},i); await page.waitForTimeout(65); }
  await ready();
  assert.ok(Number(await page.locator('.catalog-virtual').getAttribute('data-cached-pages'))<=16);
  assert.ok(await page.evaluate(()=>window.maxInFlight)<=3);
  // Same-scope refresh keeps mounted cards while the replacement request is pending.
  await page.evaluate(()=>{window.delay=250;window.beforeCard=document.querySelector('[data-asset-id]');window.refresh();});
  await page.waitForTimeout(160);
  assert.equal(await page.evaluate(()=>window.beforeCard.isConnected),true);
  await ready(); await page.evaluate(()=>{window.delay=0;});
  // Full-result selection, even though only a viewport of cards exists.
  await page.getByRole('textbox',{name:'搜索素材'}).fill('small'); await ready();
  await page.locator('[data-asset-id="asset-0"]').click({modifiers:['Control']});
  await scroller().evaluate(el=>{el.scrollTop=el.scrollHeight;}); await ready();
  await page.locator('[data-asset-id="asset-179"]').click({modifiers:['Shift']});
  await page.getByText('180 项',{exact:true}).waitFor();
  await page.getByRole('button',{name:'取消选择',exact:true}).click();
  await cards().first().click({modifiers:['Control']});
  await page.getByRole('button',{name:'全选',exact:true}).click();
  await page.getByText('180 项',{exact:true}).waitFor();
  await page.getByRole('button',{name:'添加到新项目',exact:true}).click();
  await page.waitForFunction(()=>window.created?.length===180);
  // A failed page is retryable and does not poison later requests.
  await page.evaluate(()=>{window.failOffset=0;window.refresh();});
  await page.getByRole('alert').filter({hasText:'模拟分页读取失败'}).waitFor();
  await page.evaluate(()=>{window.failOffset=-1;});
  await page.getByRole('alert').filter({hasText:'模拟分页读取失败'}).getByRole('button',{name:'重试'}).click(); await ready();
  await page.getByRole('button',{name:'颜色筛选',exact:true}).click();
  await page.getByRole('button',{name:'红',exact:true}).click(); await ready();
  assert.ok(await page.evaluate(()=>window.requests.some(r=>r.command==='catalog_overview'&&r.args.filter.color==='red')));
  assert.equal(await page.evaluate(()=>window.requests.some(r=>r.command==='file_colors')),false);
  await page.getByRole('button',{name:'清除颜色筛选',exact:true}).click();
  await page.getByRole('button',{name:'颜色筛选',exact:true}).click();
  // Late summaries must not revive a previous query.
  await page.getByRole('textbox',{name:'搜索素材'}).fill('slow');
  await page.waitForTimeout(25); await page.getByRole('textbox',{name:'搜索素材'}).fill('empty');
  await page.getByText('没有匹配的素材。',{exact:true}).waitFor();
  await page.waitForTimeout(450); assert.equal(await cards().count(),0);
  await page.getByRole('textbox',{name:'搜索素材'}).fill(''); await ready();
  await page.evaluate(()=>window.changeKind('tags')); await ready();
  await page.locator('.catalog-tag-list').getByRole('button',{name:/Z 末尾/}).first().click();
  await page.locator('[data-tag-section="last"] [data-asset-id="asset-299940"]').waitFor();
  assert.ok(await cards().count()<180);
  await page.screenshot({path:'.tmp/catalog-paging/300k-tag-jump.png'});
  await page.evaluate(()=>window.changeKind('collections')); await ready();
  assert.ok(await page.evaluate(()=>window.requests.some(r=>r.command==='catalog_page'&&r.args.filter.kind==='collections'&&r.args.filter.id==='collection')));
  await page.evaluate(()=>window.changeProject(true)); await ready();
  assert.ok(await page.evaluate(()=>window.requests.filter(r=>r.command==='catalog_page').at(-1).args.filter.projectId==='p'));
  await page.setViewportSize({width:440,height:720}); await ready();
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.screenshot({path:'.tmp/catalog-paging/narrow-dark.png'});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,initial,finalCards:await cards().count(),maxInFlight:await page.evaluate(()=>window.maxInFlight)}));
} finally { await browser.close(); await server.close(); }
