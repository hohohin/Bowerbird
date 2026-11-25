import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { checkContextLookup, checkContextRangeSelection } from './helpers/catalog-context-selection.mjs';
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
  await checkContextRangeSelection(page, index => page.locator(`[data-asset-id="asset-${index}"]`), page.getByRole('button', { name: '取消选择', exact: true }));
  await page.locator('[data-asset-id="asset-0"]').click({modifiers:['Shift']});
  await page.locator('[data-asset-id="asset-1"]').click();
  assert.equal(await page.locator('[data-asset-id="asset-1"]').getAttribute('aria-pressed'),'true','the first Shift selection must keep subsequent clicks in selection mode');
  assert.equal(await page.getByRole('dialog').count(),0,'selection must not open a media preview');
  assert.equal(await page.evaluate(()=>window.requests.some(r=>r.command==='external_files_media')),false);
  await page.locator('[data-asset-id="asset-0"]').click();
  assert.equal(await page.locator('[data-asset-id="asset-0"]').getAttribute('aria-pressed'),'false','plain clicks toggle items while selecting');
  await page.getByRole('button',{name:'取消选择',exact:true}).click();
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
  await page.reload(); await ready();
  await checkContextLookup(page, index => page.locator(`[data-asset-id="asset-${index}"]`), page.getByRole('button', { name: '取消选择', exact: true }),
    { idsCommand: 'catalog_ids', lookupCommand: 'get_assets_by_ids', firstId: 'asset-0', secondId: 'asset-1', coldId: 'asset-12000' });
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
  const searchButton = page.getByRole('button',{name:'搜索素材',exact:true});
  const search = page.getByRole('searchbox',{name:'搜索素材',exact:true});
  const waitForQuery = query => page.waitForFunction(value => window.requests.some(r =>
    r.command === 'catalog_overview' && r.args.filter.query === value), query);
  await searchButton.click(); await search.fill('small'); await waitForQuery('small'); await ready();
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
  // Batch tags reuse the full selection and can resume after a committed first chunk.
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.tagBatches = [];
    window.taggedIds = new Set();
    window.tagSaves = [];
    const labels = [{ id: 'batch-tag', name: '示例标签' }];
    window.failTagBatch = true;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'local_classification_labels') return structuredClone(labels);
      if (command === 'local_classification_save_label') {
        window.tagSaves.push(args);
        const id = 'created-batch-tag';
        labels.push({ id, name: args.name });
        return id;
      }
      if (command !== 'local_classification_example') return invoke(command, args);
      window.tagBatches.push(args);
      if (window.failTagBatch && args.assetIds.includes('asset-100')) throw Error('模拟标签写入失败');
      for (const id of args.assetIds) {
        if (args.positive) window.taggedIds.add(id);
        else window.taggedIds.delete(id);
      }
      window.emitFixtureEvent('library://assets-changed', { assetTagIds: args.assetIds });
    };
  });
  await searchButton.click(); await search.fill('batch'); await waitForQuery('batch'); await ready();
  await cards().first().click({modifiers:['Control']});
  await page.getByRole('button',{name:'全选',exact:true}).click();
  await page.getByText('200 项',{exact:true}).waitFor();
  const tagButton = page.getByRole('button',{name:'标签',exact:true});
  await tagButton.click();
  const tags = page.getByRole('dialog',{name:'编辑标签',exact:true});
  await tags.getByRole('radio',{name:'示例标签',exact:true}).check();
  await tags.getByRole('button',{name:'添加标签',exact:true}).click();
  await tags.getByRole('alert').waitFor();
  await tags.getByText(/已处理 100 \/ 200 项/).waitFor();
  await page.evaluate(() => { window.failTagBatch = false; });
  await tags.getByRole('button',{name:'添加标签',exact:true}).click();
  await tags.getByText('添加标签「示例标签」完成 · 已处理 200 项',{exact:true}).waitFor();
  assert.equal(await page.evaluate(() => window.taggedIds.size), 200);
  await tags.getByRole('button',{name:'移除标签',exact:true}).click();
  await tags.getByText('移除标签「示例标签」完成 · 已处理 200 项',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(() => window.tagBatches.map(batch => [batch.tagId, batch.assetIds[0], batch.assetIds.length, batch.positive, batch.assignedOnly])), [
    ['batch-tag', 'asset-0', 100, true, undefined], ['batch-tag', 'asset-100', 100, true, undefined],
    ['batch-tag', 'asset-100', 100, true, undefined], ['batch-tag', 'asset-0', 100, false, true],
    ['batch-tag', 'asset-100', 100, false, true],
  ]);
  assert.equal(await page.evaluate(() => window.taggedIds.size), 0);
  const tagSearch = tags.getByRole('textbox',{name:'搜索标签',exact:true});
  await tags.getByRole('button',{name:'新建标签',exact:true}).click();
  assert.equal(await tags.getByRole('radio',{name:'示例标签',exact:true}).isChecked(),false);
  assert.equal(await tagSearch.evaluate(input => input === document.activeElement),true);
  await tagSearch.fill(' #新标签 ');
  const createTag = tags.getByRole('button',{name:'新建并添加',exact:true});
  await page.evaluate(() => { window.failTagBatch = true; });
  await createTag.evaluate(button => { button.click(); button.click(); });
  await tags.getByRole('alert').waitFor();
  await tags.getByText('添加标签 · 已处理 100 / 200 项',{exact:true}).waitFor();
  await page.evaluate(() => { window.failTagBatch = false; });
  await tags.getByRole('button',{name:'添加标签',exact:true}).click();
  await tags.getByText('添加标签「新标签」完成 · 已处理 200 项',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(() => window.tagSaves), [{ id: null, name: '新标签', description: '', enabled: true }]);
  assert.deepEqual(await page.evaluate(() => window.tagBatches.slice(5).map(batch => [batch.tagId, batch.assetIds[0], batch.assetIds.length])), [
    ['created-batch-tag', 'asset-0', 100], ['created-batch-tag', 'asset-100', 100], ['created-batch-tag', 'asset-100', 100],
  ]);
  await tags.getByRole('button',{name:'关闭',exact:true}).click();
  assert.equal(await tagButton.evaluate(el => el === document.activeElement), true);
  await page.getByRole('button',{name:'取消选择',exact:true}).click();
  // A failed page is retryable and does not poison later requests.
  await scroller().evaluate(el=>{el.scrollTop=0;}); await ready();
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
  await searchButton.click(); await search.fill('slow');
  await waitForQuery('slow'); await search.fill('empty');
  await page.getByText('没有匹配的素材。',{exact:true}).waitFor();
  await page.waitForTimeout(450); assert.equal(await cards().count(),0);
  await page.getByRole('button', { name: '清空搜索', exact: true }).click();
  await search.fill('discarded');
  await page.evaluate(() => window.mode.getState().setQuery(''));
  assert.equal(await search.inputValue(), '');
  await page.waitForTimeout(260);
  assert.equal(await page.evaluate(() => window.requests.some(r => r.args.filter?.query === 'discarded')), false);
  await search.press('Escape'); await ready();
  await page.evaluate(()=>window.changeKind('tags')); await ready();
  await page.locator('.catalog-tag-list').getByRole('button',{name:/Z 末尾/}).first().click();
  await page.locator('[data-tag-section="last"] [data-asset-id="asset-299940"]').waitFor();
  assert.ok(await cards().count()<180);
  await page.screenshot({path:'.tmp/catalog-paging/300k-tag-jump.png'});
  await page.evaluate(()=>window.changeProject(true)); await ready();
  assert.ok(await page.evaluate(()=>window.requests.filter(r=>r.command==='catalog_page').at(-1).args.filter.projectId==='p'));
  await page.setViewportSize({width:440,height:720}); await ready();
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.screenshot({path:'.tmp/catalog-paging/narrow-dark.png'});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,initial,finalCards:await cards().count(),maxInFlight:await page.evaluate(()=>window.maxInFlight)}));
} finally { await browser.close(); await server.close(); }
