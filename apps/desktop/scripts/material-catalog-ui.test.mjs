import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir:'.tmp/material-catalog/vite', server:{host:'127.0.0.1',port:1698,strictPort:true,hmr:false,watch:null} });
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1280,height:840}});
page.setDefaultTimeout(10000);
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
async function clickControl(name) {
  const button=page.getByRole('button',{name,exact:true});
  if(!await button.isVisible()) await page.getByRole('button',{name:'更多素材库控件',exact:true}).click();
  await button.click();
}
async function closeControls() {
  await page.waitForTimeout(250);
  const more=page.getByRole('button',{name:'更多素材库控件',exact:true});
  if(await more.count() && await more.getAttribute('aria-expanded')==='true') await more.click();
}
async function collectionAction(name, action) {
  const row = page.getByRole('treeitem', { name, exact: true });
  await row.hover();
  await row.getByRole('button', { name: `「${name}」的更多操作`, exact: true }).click();
  const menu = page.getByRole('menu', { name: '集合操作', exact: true });
  if (action === '删除集合') {
    await menu.getByRole('menuitem', { name: '删除', exact: true }).click();
    await page.getByRole('menu', { name: '删除', exact: true }).getByRole('menuitem', { name: action, exact: true }).click();
  } else await menu.getByRole('menuitem', { name: action, exact: true }).click();
}
const tab = name => page.locator(`[role="tab"][data-tab-value="${name==='全局素材'?'global':'project'}"]`);
const card = name => page.locator('.categorized-library').getByRole('button',{name,exact:true});
async function view(kind) {
  const root=page.locator('.categorized-library');
  const same=await root.count() && await root.getAttribute('aria-label')===(kind==='tags' ? '按标签浏览素材' : '按集合浏览素材');
  if (same) {
    await clickControl('文件浏览器');
    await clickControl('文件浏览器');
  } else {
    await page.locator('[role="tab"][aria-selected="true"]').focus(); await page.keyboard.press('Tab');
  }
  await page.getByRole('region',{name:kind==='tags' ? '按标签浏览素材' : '按集合浏览素材',exact:true}).waitFor();
}
async function mockCatalog() {
  await page.evaluate(() => {
    const previous = window.__TAURI_INTERNALS__.invoke;
    window.catalogCalls=[]; window.catalogFail=false; window.catalogSlow=false;
    const image = '/src-tauri/resources/samples/preset-01.webp';
    window.catalogAssets = ['建筑.png','海报.png','插画.png'].map((name,index)=>({id:`catalog-${index}`,name,ext:'png',source:'imported',store_path:`/catalog-${index}.png`,thumb_path:image,width:576,height:1024}));
    window.catalogCollections = [{id:'root-collection',name:'设计',parent_id:null,kind:'collection'},
      {id:'child-collection',name:'海报',parent_id:'root-collection',kind:'collection'}, {id:'other-collection',name:'灵感',parent_id:null,kind:'collection'}];
    window.catalogMembers = {'root-collection':[], 'child-collection':['catalog-1'], 'other-collection':['catalog-2']};
    const descendants = id => [id,...window.catalogCollections.filter(c=>c.parent_id===id).flatMap(c=>descendants(c.id))];
    window.__TAURI_INTERNALS__.invoke = async (command,args={}) => {
      if (window.catalogDelay && ['material_catalog', 'material_catalog_assets'].includes(command)) await new Promise(resolve => setTimeout(resolve, 160));
      if (['material_catalog','material_catalog_assets','save_collection_node','delete_collection_node','set_collection_members'].includes(command)) window.catalogCalls.push({command,args});
      if (command==='material_catalog') return {tags:[{id:'architecture',name:'建筑',count:1,projectCount:0,description:''},
        {id:'poster',name:'海报',count:1,projectCount:args.projectId ? 2 : 0,description:''},
        {id:'illustration',name:'插画',count:1,projectCount:0,description:''},
        {id:'empty',name:'空标签',count:100,projectCount:100,description:''}],collections:window.catalogCollections,prompts:args.projectId ? ['现代建筑设计'] : [],
        tag_asset_ids:{architecture:['catalog-0'],poster:['catalog-1'],illustration:['catalog-2'],empty:['gone']}};
      if (command==='material_catalog_assets') {
        if (window.catalogFail) throw '模拟读取失败';
        if (window.catalogSlow && args.id==='architecture') await new Promise(r=>setTimeout(r,500));
        const scoped = window.catalogAssets.filter(a=>!args.projectId || a.id!=='catalog-2');
        if (args.kind==='tags') return args.id ? scoped.filter((a,i)=>['architecture','poster','illustration'][i]===args.id) : scoped;
        const members = new Set((args.id ? descendants(args.id) : Object.keys(window.catalogMembers)).flatMap(id=>window.catalogMembers[id] || []));
        return scoped.filter(a=>members.has(a.id));
      }
      if (command==='list_collections') return window.catalogCollections;
      if (command==='save_collection_node') {
        const id=args.id || `new-${window.catalogCollections.length}`;
        window.catalogCollections=window.catalogCollections.filter(c=>c.id!==id).concat({id,name:args.name,parent_id:args.parentId,kind:'collection'});
        window.catalogMembers[id] ||= []; return id;
      }
      if (command==='delete_collection_node') {
        const ids=descendants(args.id); window.catalogCollections=window.catalogCollections.filter(c=>!ids.includes(c.id));
        ids.forEach(id=>delete window.catalogMembers[id]); return null;
      }
      if (command==='set_collection_members') {
        if (args.added) window.catalogMembers[args.id]=[...new Set([...window.catalogMembers[args.id],...args.assetIds])];
        else descendants(args.id).forEach(id=>window.catalogMembers[id]=window.catalogMembers[id].filter(a=>!args.assetIds.includes(a)));
        return null;
      }
      if(command==='external_files_media') return image;
      if(command==='file_colors') return args.path==='/catalog-0.png' ? ['red'] : ['blue'];
      if(command==='external_files_preview' && args.path.startsWith('/catalog-')) return image;
      return previous(command,args);
    };
  });
}
async function stableSwitch(kind) {
  await page.evaluate(() => {
    window.catalogDelay = true;
    window.switchFrames = [];
    const until = performance.now() + 800;
    const frame = () => {
      const root = document.querySelector('.categorized-library');
      const nav = root?.querySelector('.library-view-switch');
      const gallery = root?.querySelector('.catalog-gallery');
      if (root && nav && gallery) window.switchFrames.push([root, nav, gallery].flatMap(el => {
        const rect = el.getBoundingClientRect(); return [rect.x, rect.y, rect.width];
      }));
      if (performance.now() < until) requestAnimationFrame(frame); else window.switchDone = true;
    };
    window.switchDone = false; frame();
  });
  await view(kind);
  await page.waitForFunction(() => window.switchDone);
  const frames = await page.evaluate(() => { window.catalogDelay = false; return window.switchFrames; });
  assert.ok(frames.length > 10);
  for (let i = 0; i < frames[0].length; i++) assert.ok(Math.max(...frames.map(f => f[i])) - Math.min(...frames.map(f => f[i])) < 1, `switch to ${kind}: frame geometry ${i} remains stable`);
}
async function assertLayout(name) {
  await page.waitForTimeout(250);
  const scrollGeometry=await page.locator('.categorized-library').evaluate(root=>{
    const views=[...root.querySelectorAll('.collection-scroll-viewport')];
    const rails=[...root.querySelectorAll('.collection-scroll-rail')];
    const width=()=>[...root.querySelectorAll('.folder-masonry')].map(el=>el.clientWidth);
    const before=width();
    rails.forEach(el=>el.style.display='none'); const hidden=width();
    rails.forEach(el=>el.style.removeProperty('display'));
    return {before,hidden,gutters:views.map(el=>el.offsetWidth-el.clientWidth),
      rails:rails.map(el=>getComputedStyle(el).position),
      padding:getComputedStyle(root.querySelector('.catalog-scroller')).paddingRight};
  });
  assert.ok(scrollGeometry.gutters.every(width=>width===0),`${name}: no native scrollbar consumes width`);
  assert.ok(scrollGeometry.rails.every(position=>position==='absolute'),`${name}: every rail overlays its viewport`);
  assert.deepEqual(scrollGeometry.before,scrollGeometry.hidden,`${name}: rails never change material width`);
  assert.equal(scrollGeometry.padding,'0px',`${name}: no extra gallery padding for a scrollbar lane`);
  assert.equal(await page.locator('.catalog-gallery-heading').count(),0,`${name}: no separate toolbar in either view`);
  assert.equal(await page.getByRole('button',{name:'多选',exact:true}).count(),0,`${name}: no top multi-select button`);
  const surface=await page.locator('.categorized-library').evaluate(root=>{
    const heading=root.querySelector('.catalog-section-heading'), pill=heading.querySelector('.catalog-section-title');
    const nav=root.querySelector('.library-view-switch');
    const appearance=el=>{const s=getComputedStyle(el);return [s.height,s.borderRadius,s.backgroundColor,s.backdropFilter,s.boxShadow,s.border];};
    const section=heading.parentElement, grid=section.querySelector('.folder-masonry');
    const viewport=root.querySelector('.catalog-scroller');
    return {title:appearance(pill),switch:appearance(nav),pinned:heading.classList.contains('is-pinned'),rowBackground:getComputedStyle(heading).backgroundColor,
      rowShadow:getComputedStyle(heading).boxShadow,
      gridInset:grid ? grid.getBoundingClientRect().top-section.getBoundingClientRect().top : 40,
      scrollInset:viewport.getBoundingClientRect().top-root.querySelector('.catalog-gallery').getBoundingClientRect().top};
  });
  if(surface.pinned) {
    assert.equal(surface.title[1],'0px 8px 8px 0px',`${name}: pinned title has square left corners and rounded right corners`);
    assert.deepEqual(surface.title.filter((_,i)=>i!==1),surface.switch.filter((_,i)=>i!==1),`${name}: floating surface stays shared`);
  }
  else {
    assert.equal(surface.title[2],'rgba(0, 0, 0, 0)',`${name}: unpinned title is plain text`);
    assert.equal(surface.title[4],'none',`${name}: unpinned title has no capsule shadow`);
  }
  assert.equal(surface.rowBackground,'rgba(0, 0, 0, 0)',`${name}: no full-width color band`);
  assert.equal(surface.rowShadow,'none',`${name}: no full-width shadow band`);
  assert.equal(surface.gridInset,40,`${name}: only the ordinary title line precedes images`);
  assert.equal(surface.scrollInset,0,`${name}: gallery starts at the top`);
  const layout=await page.locator('.categorized-library').evaluate(root=>{
    const r=root.getBoundingClientRect(), sidebar=root.querySelector('.catalog-sidebar').getBoundingClientRect();
    const buttons=[...root.querySelectorAll('[role="tab"]')].map(b=>{
      const box=b.getBoundingClientRect(); return {left:box.left,right:box.right,width:box.width,overflow:b.scrollWidth>b.clientWidth};
    });
    const heading=root.querySelector('.file-view-heading'), body=root.querySelector('.catalog-body');
    const color=root.querySelector('button[aria-label="颜色筛选"]').getBoundingClientRect();
    const viewTop=root.querySelector('.catalog-scroller').getBoundingClientRect().top;
    const pinned=[...root.querySelectorAll('.catalog-section-heading')].find(el=>Math.abs(el.getBoundingClientRect().top-viewTop)<1);
    const titleBox=pinned?.querySelector('.catalog-section-title').getBoundingClientRect();
    return {left:r.left,right:r.right,sidebar:sidebar.width,buttons,top:r.top,bodyTop:body.getBoundingClientRect().top,
      headingPosition:getComputedStyle(heading).position,color:{left:color.left,right:color.right},
      titleVisible:!pinned || pinned.contains(document.elementFromPoint(titleBox.left+titleBox.width/2,titleBox.top+titleBox.height/2))};
  });
  // Compact navigation is intentionally deferred until the user trims its contents.
  if(layout.right-layout.left>1000) assert.ok(layout.titleVisible,`${name}: floating switch does not cover the current tag title`);
  assert.equal(layout.headingPosition,'absolute',`${name}: navigation and controls float`);
  assert.equal(layout.bodyTop,layout.top,`${name}: navigation reserves no content height`);
  assert.ok(layout.color.left>=layout.left && layout.color.right<=layout.right,`${name}: color filter stays visible`);
  assert.ok(layout.sidebar>=88,`${name}: permanent sidebar remains usable`);
  for(const button of layout.buttons) {
    assert.ok(button.left>=layout.left && button.right<=layout.right+1,`${name}: tabs fit library`);
    assert.ok(button.width>=56 && !button.overflow,`${name}: labels fit tabs ${JSON.stringify(button)}`);
  }
  await page.screenshot({path:`.tmp/material-catalog/${name}.png`});
  const controlWidth=await page.locator('.folder-floating-controls').evaluate(el=>el.getBoundingClientRect().width);
  await clickControl('颜色筛选');
  await page.waitForTimeout(250);
  const expanded=await page.locator('.categorized-library').evaluate(root=>{
    const bounds=root.querySelector('.catalog-gallery').getBoundingClientRect(), pill=root.querySelector('.library-color-control').getBoundingClientRect();
    const popup=root.querySelector('.library-color-strip').getBoundingClientRect();
    const swatches=[...root.querySelectorAll('.library-filter-colors button')].map(el=>el.getBoundingClientRect());
    return {fits:popup.left>=bounds.left && popup.right<=bounds.right,below:popup.top>=pill.bottom+7,aligned:Math.abs(popup.left-pill.left)<1,
      rows:new Set(swatches.map(rect=>Math.round(rect.top))).size,controlWidth:root.querySelector('.folder-floating-controls').getBoundingClientRect().width,
      bodyTop:root.querySelector('.catalog-body').getBoundingClientRect().top};
  });
  assert.ok(expanded.fits,`${name}: expanded color strip stays in the panel`);
  assert.ok(expanded.below && expanded.aligned,`${name}: colors open directly below the trigger`);
  assert.equal(expanded.rows,12,`${name}: colors form a vertical column`);
  assert.equal(expanded.controlWidth,controlWidth,`${name}: opening colors never widens the controls`);
  assert.equal(expanded.bodyTop,layout.top,`${name}: expanded controls still reserve no height`);
  await page.screenshot({path:`.tmp/material-catalog/${name}-colors.png`});
  await page.keyboard.press('Escape'); await closeControls();
}
async function assertColorFilter(name) {
  const before=await page.locator('.catalog-body').boundingBox();
  await clickControl('颜色筛选');
  const strip=page.getByRole('dialog',{name:'颜色筛选',exact:true});
  await strip.getByRole('button',{name:'红',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.categorized-library .folder-media-card').length===1);
  assert.equal(await card('建筑.png').count(),1,`${name}: color actually filters assets`);
  assert.deepEqual(await page.locator('.catalog-body').boundingBox(),before,'opening color strip must not push content');
  await strip.getByRole('button',{name:'清除颜色筛选'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.categorized-library .folder-media-card').length===3);
  await page.keyboard.press('Escape'); await closeControls();
  assert.equal(await page.getByRole('button',{name:'颜色筛选',exact:true}).getAttribute('aria-expanded'),'false');
}
async function assertStickyTags(name) {
  assert.equal(await page.locator('.catalog-gallery-heading').count(),0,'tag view has no overall count toolbar');
  assert.equal(await page.getByRole('button',{name:'多选',exact:true}).count(),0,'tag view has no multi-select toolbar button');
  await page.waitForTimeout(250);
  const metrics=await page.locator('.catalog-scroller').evaluate(view=>{
    view.scrollTop=0;
    const sections=[...view.querySelectorAll('[data-tag-section]')];
    const top=view.getBoundingClientRect().top;
    return sections.slice(0,2).map(section=>({
      top:section.getBoundingClientRect().top-top,
      height:section.querySelector('h3').getBoundingClientRect().height,
      name:section.querySelector('h3').textContent,
    }));
  });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.catalog-section-heading.is-pinned').count(),0,'at the start, all titles are ordinary text');
  async function assertPinnedAppearance() {
    const result=await page.locator('.categorized-library').evaluate(root=>{
      const title=root.querySelector('.is-pinned .catalog-section-title'), nav=root.querySelector('.library-view-switch');
      const style=el=>{const s=getComputedStyle(el);return [s.height,s.borderRadius,s.backgroundColor,s.backdropFilter,s.boxShadow,s.border];};
      return {title:style(title),nav:style(nav),titleTop:title.getBoundingClientRect().top,navTop:nav.getBoundingClientRect().top,
        plain:[...root.querySelectorAll('.catalog-section-heading:not(.is-pinned) .catalog-section-title')].every(el=>getComputedStyle(el).backgroundColor==='rgba(0, 0, 0, 0)' && !el.classList.contains('library-floating-surface'))};
    });
    assert.equal(result.title[1],'0px 8px 8px 0px','pinned heading has square left corners and rounded right corners');
    assert.notEqual(result.title[1],result.nav[1],'heading is distinct from source switch capsule');
    assert.deepEqual(result.title.filter((_,i)=>i!==1),result.nav.filter((_,i)=>i!==1),'pinned title retains shared floating surface');
    assert.ok(Math.abs(result.titleTop-result.navTop)<1,'pinned capsule aligns exactly with the switch');
    assert.ok(result.plain,'upcoming sections remain ordinary text');
  }
  async function scrollTo(top) {
    await page.locator('.catalog-scroller').evaluate((view,top)=>{view.scrollTop=top;},top);
    await page.waitForTimeout(100);
    return page.locator('.catalog-scroller').evaluate(view=>{
      const top=view.getBoundingClientRect().top;
      return [...view.querySelectorAll('.catalog-section-heading')].slice(0,2).map(heading=>{
        const rect=heading.getBoundingClientRect();
        return {top:rect.top-top,bottom:rect.bottom-top,background:getComputedStyle(heading).backgroundColor};
      });
    });
  }
  let headings=await scrollTo(metrics[0].top+60);
  assert.ok(Math.abs(headings[0].top)<1,`${name}: current tag sticks to viewport top`);
  assert.equal(headings[0].background,'rgba(0, 0, 0, 0)','sticky heading row remains transparent');
  await assertPinnedAppearance();
  headings=await scrollTo(metrics[1].top-metrics[0].height/2);
  assert.ok(headings[0].top<0 && headings[1].top>0,`${name}: next tag pushes current title up`);
  assert.ok(Math.abs(headings[0].bottom-headings[1].top)<1,`${name}: titles replace each other without overlap or gap ${JSON.stringify(headings)}`);
  headings=await scrollTo(metrics[1].top+60);
  assert.ok(Math.abs(headings[1].top)<1,`${name}: next tag now sticks`);
  await assertPinnedAppearance();
  assert.equal(await page.locator('.catalog-tag-list [aria-current="location"]').innerText(),metrics[1].name,'sidebar follows pinned tag');
  await page.screenshot({path:`.tmp/material-catalog/${name}-sticky.png`});
  await scrollTo(0);
  assert.equal(await page.locator('.catalog-section-heading.is-pinned').count(),0,'scrolling back to the start restores ordinary text');
}
try {
  await mkdir('.tmp/material-catalog',{recursive:true});
  await page.goto('http://127.0.0.1:1698/scripts/fixtures/project-drop/preview.html?layout');
  await tab('全局素材').waitFor(); await mockCatalog();
  assert.deepEqual(await page.getByRole('tab').allTextContents(),['标签分类']);
  await view('tags'); await card('建筑.png').waitFor();
  assert.deepEqual(await page.locator('.catalog-tag-list .catalog-row span').allTextContents(),['插画','海报','建筑']);
  assert.equal(await page.locator('.catalog-sidebar').isVisible(),true);
  assert.deepEqual(await page.locator('.catalog-section-heading').allTextContents(),['插画','海报','建筑']);
  assert.equal(await page.locator('[data-tag-id="empty"]').count(),0,'empty tags are hidden even if their cached counts are positive');
  assert.equal(await page.locator('[data-tag-section="empty"]').count(),0);
  assert.equal(await page.locator('.catalog-tag-list small').count(),0,'no per-tag counts');
  assert.equal(await page.locator('.catalog-alphabet button').count(),27);
  assert.equal(Math.round((await page.locator('.catalog-sidebar').boundingBox()).width),208,'shared default sidebar');
  await stableSwitch('collections');
  await stableSwitch('tags');
  await assertStickyTags('home-tags-light');
  await assertColorFilter('home-tags');
  const readCount=await page.evaluate(()=>window.catalogCalls.filter(c=>c.command==='material_catalog_assets').length);
  await page.locator('.catalog-tag-list').getByRole('button',{name:'海报',exact:true}).click();
  await card('海报.png').waitFor(); assert.equal(await card('建筑.png').count(),1,'clicking tags navigates without filtering');
  await page.waitForFunction(()=>document.querySelector('.catalog-tag-list [aria-current="location"]')?.textContent==='海报');
  assert.equal(await page.evaluate(()=>window.catalogCalls.filter(c=>c.command==='material_catalog_assets').length),readCount,'navigation is local');
  const letter=await page.getByRole('button',{name:'定位 J 开头的标签'}).boundingBox();
  await page.mouse.move(letter.x+letter.width/2,letter.y+letter.height/2); await page.mouse.down(); await page.waitForTimeout(300);
  assert.equal(await page.locator('.catalog-letter-bubble').innerText(),'J');
  const c=await page.getByRole('button',{name:'定位 C 开头的标签'}).boundingBox();
  await page.mouse.move(c.x+c.width/2,c.y+c.height/2); await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('.catalog-tag-list [aria-current="location"]')?.textContent==='插画');
  const resize=page.getByRole('separator',{name:'调整标签侧栏宽度'}); const r=await resize.boundingBox();
  await page.mouse.move(r.x+r.width/2,r.y+50); await page.mouse.down(); await page.mouse.move(r.x+104,r.y+50); await page.mouse.up();
  assert.ok((await page.locator('.catalog-sidebar').boundingBox()).width>220);
  await stableSwitch('collections');
  await stableSwitch('tags');
  await resize.press('ArrowLeft'); await resize.press('Home');
  assert.equal(Math.round((await page.locator('.catalog-sidebar').boundingBox()).width),208);
  await assertLayout('home-tags-light');
  assert.equal(await page.evaluate(()=>window.catalogCalls.some(c=>c.command.startsWith('save_')||c.command.startsWith('set_'))),false,'browsing does not mutate library');
  await page.evaluate(()=>window.catalogFail=true);
  await view('collections');
  assert.equal(await page.getByRole('button',{name:'全部集合素材',exact:true}).count(),0);
  await page.getByRole('treeitem',{name:'灵感',exact:true}).waitFor();
  assert.equal(await page.getByRole('treeitem',{name:'灵感',exact:true}).getAttribute('aria-selected'),'true','first tree collection is selected by default');
  assert.ok(await page.evaluate(()=>window.catalogCalls.filter(c=>c.command==='material_catalog_assets' && c.args.kind==='collections').every(c=>!!c.args.id)),'collection view never requests all collections');
  await page.getByRole('alert').filter({hasText:'模拟读取失败'}).waitFor();
  await page.evaluate(()=>window.catalogFail=false);
  await page.getByRole('button',{name:'重试',exact:true}).click(); await card('插画.png').waitFor();
  await view('tags'); await card('海报.png').waitFor();
  await card('海报.png').click({modifiers:['Control']});
  await page.getByRole('group',{name:'分类素材所选操作'}).getByRole('button',{name:'添加到集合'}).click();
  let dialog=page.getByRole('dialog',{name:'添加到集合',exact:true});
  await dialog.getByText('灵感', { exact: true }).click();
  await dialog.getByRole('button',{name:'添加',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  await view('collections');
  await page.getByRole('treeitem',{name:'海报',exact:true}).click(); await card('海报.png').waitFor();
  assert.equal(await page.locator('.catalog-tree-actions').count(),0,'no bottom action strip');
  const leaf = page.getByRole('treeitem', { name: '灵感', exact: true });
  const compactRow = await leaf.evaluate(el => ({
    font: getComputedStyle(el).fontSize, height: el.getBoundingClientRect().height,
    inset: el.querySelector('.catalog-tree-name').getBoundingClientRect().left - el.closest('.catalog-sidebar').getBoundingClientRect().left,
    shadow: getComputedStyle(el).boxShadow,
  }));
  assert.equal(compactRow.font,'11px');
  assert.equal(compactRow.height,28);
  assert.ok(compactRow.inset <= 24,'leaf name no longer reserves an empty disclosure column');
  assert.equal(compactRow.shadow,'none','selection has no inset stripe');
  const parentName = await page.getByRole('treeitem',{name:'设计',exact:true}).locator('.catalog-tree-name').boundingBox();
  const childName = await page.getByRole('treeitem',{name:'海报',exact:true}).locator('.catalog-tree-name').boundingBox();
  assert.ok(childName.x >= parentName.x + 8,'a leaf remains visually indented under its parent without a disclosure spacer');
  await page.locator('.catalog-gallery').hover({ position: { x: 30, y: 400 } });
  assert.equal(await leaf.locator('.catalog-tree-row-actions').evaluate(el => getComputedStyle(el).opacity),'0');
  await leaf.hover();
  assert.equal(await leaf.locator('.catalog-tree-row-actions').evaluate(el => getComputedStyle(el).opacity),'1');
  await leaf.getByRole('button', { name: '「灵感」的更多操作', exact: true }).click();
  await page.getByRole('menu', { name: '集合操作' }).waitFor();
  await page.screenshot({path:'.tmp/material-catalog/collection-row-menu.png'});
  await page.keyboard.press('Escape');
  assert.equal(await leaf.getByRole('button', { name: '「灵感」的更多操作', exact: true }).evaluate(el => el === document.activeElement),true);
  const collectionResize = page.getByRole('separator', { name: '调整集合侧栏宽度' });
  await collectionResize.focus();
  for(let i=0;i<4;i++) await collectionResize.press('ArrowLeft');
  await page.locator('.catalog-gallery').hover({ position: { x: 30, y: 400 } });
  assert.equal(await leaf.locator('.catalog-tree-icon').evaluate(el => getComputedStyle(el).display),'none','narrow sidebar hides the icon before truncating the name');
  assert.ok(await leaf.evaluate(el => el.querySelector('.catalog-tree-name').getBoundingClientRect().left - el.closest('.catalog-sidebar').getBoundingClientRect().left) <= 7);
  await page.screenshot({path:'.tmp/material-catalog/collection-tree-compact.png'});
  await collectionResize.press('Home');
  await page.getByRole('treeitem',{name:'设计',exact:false}).click(); await card('海报.png').waitFor();
  await page.getByRole('button',{name:'收起设计',exact:true}).click();
  assert.equal(await page.getByRole('treeitem',{name:'海报',exact:true}).count(),0);
  await page.getByRole('button',{name:'展开设计',exact:true}).click();
  await page.getByRole('treeitem', { name: '灵感', exact: true }).click();
  await collectionAction('设计', '重命名');
  dialog=page.getByRole('dialog',{name:'重命名集合',exact:true});
  assert.equal(await dialog.locator('select').count(),0,'rename cannot reparent a collection');
  assert.equal(await dialog.getByLabel('集合名称').inputValue(),'设计','row menu targets its own collection, not the selected one');
  await page.keyboard.press('Escape'); await closeControls();
  await page.getByRole('treeitem',{name:'灵感',exact:true}).click();
  await page.getByRole('button',{name:'收起设计',exact:true}).click();
  await page.getByRole('button',{name:'在「设计」中新建子集合',exact:true}).focus();
  await page.keyboard.press('Enter');
  dialog=page.getByRole('dialog',{name:'新建集合',exact:true});
  await dialog.getByLabel('集合名称').fill('品牌');
  await dialog.getByText('在「设计」中新建子集合。',{exact:true}).waitFor();
  assert.equal(await dialog.locator('select').count(),0);
  await dialog.getByRole('button',{name:'保存',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  assert.equal(await page.getByRole('treeitem',{name:'品牌',exact:true}).getAttribute('aria-level'),'2');
  assert.equal(await page.getByRole('treeitem',{name:'品牌',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await page.getByRole('treeitem',{name:'设计',exact:true}).getAttribute('aria-expanded'),'true','creating a child reveals its parent branch');
  await page.getByRole('treeitem',{name:'品牌',exact:true}).focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(await page.getByRole('treeitem',{name:'设计',exact:true}).evaluate(el=>el===document.activeElement),true,'left on a child focuses its parent');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.getByRole('treeitem',{name:'品牌',exact:true}).count(),0,'left on expanded parent collapses children');
  await page.keyboard.press('ArrowRight');
  await page.getByRole('treeitem',{name:'品牌',exact:true}).waitFor();
  await collectionAction('品牌', '删除集合');
  dialog=page.getByRole('dialog',{name:'删除集合',exact:true});
  await dialog.getByText(/素材和电脑中的原文件均保留/).waitFor();
  await dialog.getByRole('button',{name:'删除集合',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  assert.equal(await page.getByRole('treeitem',{name:'品牌',exact:true}).count(),0);
  await page.getByRole('treeitem',{name:'设计',exact:false}).click(); await card('海报.png').click({modifiers:['Control']});
  await page.getByRole('button',{name:'移出集合',exact:true}).click(); await card('海报.png').waitFor({state:'hidden'});
  await page.getByRole('treeitem',{name:'灵感',exact:true}).click(); await card('海报.png').waitFor();
  await assertLayout('home-collections-light');
  await card('海报.png').click({modifiers:['Control']}); await page.getByRole('button',{name:'添加到新项目',exact:true}).click();
  await page.waitForFunction(()=>window.catalogCreatedProjectAssets?.length===1);
  assert.deepEqual(await page.evaluate(()=>window.catalogCreatedProjectAssets),['catalog-1']);
  await page.evaluate(()=>{window.catalogCollections=[];window.catalogMembers={};});
  await view('collections');
  await page.getByText('还没有集合，点击左侧 ＋ 新建集合。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('treeitem').count(),0);
  assert.equal(await page.locator('.categorized-library .folder-media-card').count(),0,'no collections does not fall back to all assets');
  await page.getByRole('button',{name:'新建集合',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'新建集合',exact:true});
  await dialog.getByText('新建顶层集合，用来整理素材。',{exact:true}).waitFor();
  assert.equal(await dialog.locator('select').count(),0);
  await dialog.getByLabel('集合名称').fill('新顶层');
  await dialog.getByRole('button',{name:'保存',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  await page.getByRole('treeitem',{name:'新顶层',exact:true}).waitFor();
  assert.equal(await page.getByRole('treeitem',{name:'新顶层',exact:true}).getAttribute('aria-selected'),'true','empty collections remain selectable');
  await page.getByRole('treeitem',{name:'新顶层',exact:true}).hover();
  await page.getByRole('button',{name:'在「新顶层」中新建子集合',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'新建集合',exact:true});
  await dialog.getByText('在「新顶层」中新建子集合。',{exact:true}).waitFor();
  await page.keyboard.press('Escape'); await closeControls();
  await collectionAction('新顶层', '删除集合');
  dialog=page.getByRole('dialog',{name:'删除集合',exact:true});
  await dialog.getByRole('button',{name:'删除集合',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  await page.getByText('还没有集合，点击左侧 ＋ 新建集合。',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>window.catalogCalls.filter(c=>c.command==='material_catalog_assets' && c.args.kind==='collections').every(c=>!!c.args.id)),'initial, created and deleted collections never trigger an aggregate query');
  await page.goto('http://127.0.0.1:1698/scripts/fixtures/canvas-reference/preview.html?source-library');
  await page.waitForFunction(()=>document.querySelector('.canvas-workspace')?.getAttribute('aria-busy')==='false');
  await mockCatalog(); await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab');
  assert.deepEqual(await page.getByRole('tab').evaluateAll(tabs=>tabs.map(tab=>tab.getAttribute('aria-label'))),['全局素材','项目素材']);
  await tab('项目素材').click();
  await view('tags'); await card('建筑.png').waitFor();
  assert.equal(await page.locator('.categorized-library .folder-media-card').count(),2,'project source contains only project members');
  assert.equal(await card('插画.png').count(),0);
  assert.deepEqual(await page.locator('.catalog-tag-list .catalog-row span').allTextContents(),['建筑','海报'],'project tags exclude categories with only global members');
  const drawerGrip = page.getByRole('separator', { name: '调整素材库宽度', exact: true });
  await drawerGrip.press('Home');
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    window.catalogCollections.find(c => c.id === 'other-collection').name = '灵感参考与品牌设计的超长集合名称';
    window.catalogMembers['other-collection'] = ['catalog-0'];
  });
  await stableSwitch('collections');
  const longTitle = page.locator('.catalog-section-title');
  assert.equal(await longTitle.getAttribute('title'), '灵感参考与品牌设计的超长集合名称');
  assert.ok(await longTitle.evaluate(el => el.scrollWidth > el.clientWidth), 'long collection names truncate instead of widening the drawer');
  await page.getByRole('treeitem',{name:'灵感参考与品牌设计的超长集合名称',exact:true}).hover();
  await page.screenshot({path:'.tmp/material-catalog/collection-tree-long-name.png'});
  await stableSwitch('tags');
  await page.evaluate(() => {
    window.catalogCollections.find(c => c.id === 'other-collection').name = '灵感';
    window.catalogMembers['other-collection'] = ['catalog-2'];
  });
  await drawerGrip.press('End');
  await page.waitForTimeout(350);
  await view('collections');
  await page.getByText('集合还没有素材。可在素材右键菜单中选择「添加到集合」。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('treeitem',{name:'灵感',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.categorized-library .folder-media-card').count(),0,'empty project collection does not show other collections or global members');
  await view('tags'); await card('建筑.png').waitFor();
  await page.locator('[role="tab"][aria-selected="true"]').focus(); await page.keyboard.press('q');
  await card('插画.png').waitFor();
  assert.equal(await tab('全局素材').getAttribute('aria-selected'),'true');
  assert.deepEqual(await page.locator('.catalog-tag-list .catalog-row span').allTextContents(),['建筑','海报','插画']);
  assert.equal(await page.evaluate(()=>window.catalogCalls.find(c=>c.command==='material_catalog').args.projectId),'p');
  assert.equal(await page.locator('.categorized-library .folder-media-card').count(),3,'global source in a project still contains the full library');
  await assertStickyTags('project-tags-light');
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await assertStickyTags('project-tags-dark');
  await assertColorFilter('project-tags');
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.locator('.canvas-stage').focus(); await page.keyboard.press('Control+a');
  assert.equal(await page.locator('.catalog-selection').count(),0,'canvas shortcut must not select library assets');
  await card('建筑.png').focus(); await page.keyboard.press('Control+a');
  assert.equal(await page.locator('.categorized-library .folder-media-card[aria-pressed="true"]').count(),3);
  await page.getByRole('button',{name:'取消选择',exact:true}).click();
  await page.evaluate(()=>window.getSelection()?.removeAllRanges());
  await page.getByRole('button',{name:'定位 C 开头的标签',exact:true}).click();
  assert.deepEqual(await page.locator('.catalog-tag-list .catalog-row span').allTextContents(),['插画','海报','建筑']);
  const dragData=await page.evaluateHandle(()=>new DataTransfer());
  await card('建筑.png').dispatchEvent('dragstart',{dataTransfer:dragData});
  await page.waitForFunction(()=>!window.store.getState().canvasLibraryOpen);
  const stage=page.locator('.canvas-stage');
  const bounds=await stage.boundingBox();
  await stage.dispatchEvent('dragover',{dataTransfer:dragData,clientX:bounds.x+100,clientY:bounds.y+100});
  await stage.dispatchEvent('drop',{dataTransfer:dragData,clientX:bounds.x+100,clientY:bounds.y+100});
  await page.waitForFunction(()=>window.calls.some(c=>c.command==='project_canvas_node_create' && JSON.stringify(c.args).includes('catalog-0')));
  await page.locator('.categorized-library [data-asset-id="catalog-0"]').dispatchEvent('dragend',{dataTransfer:dragData}); await dragData.dispose();
  await page.getByRole('button',{name:'展开画板素材库',exact:true}).click();
  await tab('全局素材').click(); await card('建筑.png').waitFor();
  await card('建筑.png').click({button:'right'});
  await page.getByRole('menuitem',{name:'添加到集合',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'添加到集合',exact:true});
  await dialog.getByText('设计', { exact: true }).click();
  await dialog.getByRole('button',{name:'添加',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    for(const width of [1280,760]) {
      await page.setViewportSize({width,height:840});
      await view('tags'); await assertLayout(`project-tags-${theme}-${width}`);
      await view('collections'); await assertLayout(`project-collections-${theme}-${width}`);
    }
  }
  await page.getByRole('separator',{name:'调整素材库宽度'}).focus(); await page.keyboard.press('Home');
  await view('tags'); await assertLayout('project-tags-minimum');
  await view('collections'); await assertLayout('project-collections-minimum');
  await page.locator('.catalog-scroller').evaluate(view=>{view.scrollTop=100;});
  await page.waitForTimeout(100);
  assert.ok(await page.locator('.catalog-scroller').evaluate(view=>view.scrollTop>90 && Math.abs(view.querySelector('.catalog-section-heading').getBoundingClientRect().top-view.getBoundingClientRect().top)<1),'collection title uses the same sticky behavior');
  await page.screenshot({path:'.tmp/material-catalog/project-collections-minimum-sticky.png'});
  const more=page.getByRole('button',{name:'更多素材库控件',exact:true});
  assert.equal(await more.getAttribute('aria-expanded'),'false','minimum width shows only the overflow trigger');
  assert.equal(await page.getByRole('button',{name:'颜色筛选',exact:true}).isVisible(),false);
  assert.ok(await page.locator('.categorized-library').evaluate(root=>{
    const title=root.querySelector('.catalog-section-heading.is-pinned .catalog-section-title').getBoundingClientRect();
    const bar=root.querySelector('.library-view-switch').getBoundingClientRect();
    const more=root.querySelector('[aria-label="更多素材库控件"]').getBoundingClientRect();
    return title.right+8<=bar.left && bar.right+8<=more.left && Math.abs(title.top-bar.top)<1 && Math.abs(more.top-bar.top)<1;
  }),'minimum width fits sticky title, centered switch and More on the same line');
  await more.click();
  const controls=page.getByRole('dialog',{name:'素材库控件',exact:true});
  await controls.waitFor();
  assert.ok((await controls.boundingBox()).y>=(await more.boundingBox()).y+36);
  await page.screenshot({path:'.tmp/material-catalog/project-collections-more-open.png'});
  await page.keyboard.press('Escape');
  await controls.waitFor({state:'hidden'});
  assert.equal(await page.locator('.canvas-source-panel').getAttribute('aria-hidden'),'false','Escape closes overflow without closing the drawer');
  await view('tags'); await card('建筑.png').click({modifiers:['Control']});
  await page.getByRole('button',{name:'添加到画板',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.command==='project_canvas_node_create' && JSON.stringify(c.args).includes('catalog-0')));
  await page.goto('http://127.0.0.1:1698/scripts/fixtures/project-drop/preview.html?layout');
  await tab('全局素材').waitFor(); await mockCatalog();
  await page.evaluate(()=>{
    const previous=window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
      const result=await previous(command,args);
      if(command==='material_catalog') return {...result,tags:[{id:'logo',name:'标志',projectCount:0,description:''},{id:'title',name:'标题卡',projectCount:0,description:''},{id:'art',name:'Art',projectCount:0,description:''}],tag_asset_ids:{logo:['catalog-0','catalog-1'],title:['catalog-1','catalog-2'],art:[]}};
      return result;
    };
  });
  await view('tags'); await card('建筑.png').waitFor();
  assert.deepEqual(await page.locator('.catalog-section-heading').allTextContents(),['标题卡','标志']);
  assert.equal(await page.locator('[data-tag-id="art"]').count(),0,'zero-member tags are hidden from the left index too');
  assert.equal(await card('海报.png').count(),2,'multi-tag image is shown in each matching section');
  await card('海报.png').first().click({modifiers:['Control']});
  assert.equal(await page.locator('.categorized-library .folder-media-card[aria-pressed="true"]').count(),2,'same identity selection is shared');
  await page.getByRole('button',{name:'全选',exact:true}).click();
  assert.ok((await page.getByRole('group',{name:'分类素材所选操作'}).innerText()).includes('3 项'),'actions deduplicate repeated images');
  await page.getByRole('button',{name:'取消选择',exact:true}).click();
  const search=page.getByRole('textbox',{name:'搜索分类素材'});
  await search.fill('建筑');
  await page.waitForFunction(()=>document.querySelectorAll('.catalog-section-heading').length===1);
  assert.deepEqual(await page.locator('.catalog-tag-list .catalog-row').allTextContents(),['标志']);
  await search.fill('');
  await page.getByRole('button',{name:'定位 B 开头的标签'}).click();
  await page.waitForFunction(()=>document.querySelector('.catalog-tag-list [aria-current="location"]')?.textContent==='标题卡');
  await page.setViewportSize({width:1280,height:840});
  await page.waitForTimeout(250);
  const overlap=await page.locator('.catalog-tag-sections').evaluate(root=>[...root.querySelectorAll('.folder-masonry')].some(grid=>{
    const boxes=[...grid.children].map(el=>el.getBoundingClientRect());
    return boxes.some((a,i)=>boxes.slice(i+1).some(b=>a.left<b.right-1 && a.right>b.left+1 && a.top<b.bottom-1 && a.bottom>b.top+1));
  }));
  assert.equal(overlap,false,'reflow after searching and resizing never overlaps grouped cards');
  await page.evaluate(()=>window.getSelection()?.removeAllRanges());
  await page.screenshot({path:'.tmp/material-catalog/tag-sections-examples.png'});
  // Pins survive view remounts and page reload, and reorder both navigation and sections.
  const logo = page.locator('[data-tag-id="logo"]');
  await logo.click({button:'right'});
  await page.getByRole('menuitem',{name:'置顶标签',exact:true}).click();
  assert.equal(await page.locator('.catalog-tag-list [data-tag-id]').first().getAttribute('data-tag-id'),'logo');
  assert.equal(await page.locator('[data-tag-section]').first().getAttribute('data-tag-section'),'logo');
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('bowerbird.catalog.pinnedTags'))),['logo']);
  await view('collections'); await view('tags');
  assert.equal(await page.locator('.catalog-tag-list [data-tag-id]').first().getAttribute('data-tag-id'),'logo');
  await logo.click({button:'right'}); await page.getByRole('menuitem',{name:'取消置顶',exact:true}).click();
  assert.equal(await page.locator('.catalog-tag-list [data-tag-id]').first().getAttribute('data-tag-id'),'title');
  await page.evaluate(()=>{
    const previous=window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
      const result=await previous(command,args);
      if(command==='material_catalog') return {...result,tags:[...result.tags,...Array.from({length:60},(_,i)=>({id:`extra-${i}`,name:`Zebra ${i}`,description:'',projectCount:0}))],
        tag_asset_ids:{...result.tag_asset_ids,...Object.fromEntries(Array.from({length:60},(_,i)=>[`extra-${i}`,['catalog-0']]))}};
      return result;
    };
  });
  await view('tags');
  const rail=page.getByRole('scrollbar',{name:'标签列表滚动条'});
  await rail.waitFor({state:'attached'}); await page.waitForTimeout(1100);
  const width=await page.locator('.catalog-tag-list').evaluate(el=>({outer:el.offsetWidth,inner:el.clientWidth}));
  assert.equal(width.outer,width.inner,'tag scrollbar reserves zero width');
  assert.equal(await rail.evaluate(el=>getComputedStyle(el).opacity),'0','scrollbar hidden at rest');
  await page.locator('.catalog-tag-list').evaluate(el=>{el.scrollTop=150;});
  await page.waitForTimeout(200);
  assert.equal(await rail.getAttribute('data-visible'),'true','scrollbar appears while scrolling');
  await page.waitForTimeout(1100);
  assert.equal(await rail.evaluate(el=>getComputedStyle(el).opacity),'0','scrollbar disappears after scrolling');
  assert.equal(await page.locator('.library-tag-bar').count(),0,'legacy gradient tag sidebar removed');
  await page.screenshot({path:'.tmp/material-catalog/tag-scrollbar.png'});
  for (const entry of ['project-drop/preview.html?layout','canvas-reference/preview.html?source-library']) {
    await page.goto(`http://127.0.0.1:1698/scripts/fixtures/${entry}`);
    if(entry.startsWith('canvas-reference')) {
      await page.waitForFunction(()=>document.querySelector('.canvas-workspace')?.getAttribute('aria-busy')==='false');
      await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab');
    }
    await tab('全局素材').waitFor(); await mockCatalog();
    await page.evaluate(()=>{
      const previous=window.__TAURI_INTERNALS__.invoke;
      const thumb='/src-tauri/resources/samples/preset-01.webp';
      window.catalogAssets.push(...['project-video','global-video'].map(id=>({
        id,name:`${id}.mp4`,ext:'mp4',source:'imported',store_path:`/${id}.mp4`,thumb_path:thumb,width:1280,height:720
      })));
      window.catalogMembers['child-collection'].push('project-video','global-video');
      window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
        const result=await previous(command,args);
        if(command==='material_catalog') return {...result,tag_asset_ids:{...result.tag_asset_ids,architecture:['catalog-0','project-video']}};
        if(command==='material_catalog_assets' && args.projectId) return result.filter(a=>a.id!=='global-video');
        return result;
      };
    });
    await tab('全局素材').click(); await view('tags');
    await card('建筑.png').waitFor();
    assert.equal(await card('project-video.mp4').count(),0,'image type excludes videos, even tagged videos');
    assert.equal(await page.locator('.catalog-video-row,[data-tag-section="__catalog_videos__"]').count(),0);
    await page.locator('[data-tag-id="poster"]').click();
    await page.waitForTimeout(200);
    const imageTop=await page.locator('.catalog-scroller').evaluate(el=>el.scrollTop);
    assert.ok(imageTop>100);
    await clickControl('视频'); await closeControls();
    await page.getByRole('region',{name:'平铺浏览视频',exact:true}).waitFor();
    await card('global-video.mp4').waitFor();
    assert.equal(await page.locator('.categorized-library .folder-media-card').count(),2);
    assert.equal(await page.locator('.catalog-sidebar,.catalog-section-heading').count(),0,'flat videos have neither tag sidebar nor heading');
    assert.equal(await page.locator('.categorized-library video').count(),0,'passive video cards do not initialize playback');
    const flatGeometry=await page.locator('.categorized-library').evaluate(root=>{
      const gallery=root.querySelector('.catalog-gallery').getBoundingClientRect(), bar=root.querySelector('.library-view-switch').getBoundingClientRect();
      const view=root.querySelector('.catalog-scroller');
      return {center:bar.x+bar.width/2-gallery.x-gallery.width/2,top:view.getBoundingClientRect().top-gallery.top,gutter:view.offsetWidth-view.clientWidth};
    });
    assert.ok(Math.abs(flatGeometry.center)<1); assert.equal(flatGeometry.top,0); assert.equal(flatGeometry.gutter,0);
    const query=page.getByRole('textbox',{name:'搜索分类素材'});
    await query.fill('建筑');
    await page.waitForFunction(()=>document.querySelectorAll('.categorized-library .folder-media-card').length===0);
    await query.fill('project-video');
    await card('project-video.mp4').waitFor();
    assert.equal(await page.locator('.categorized-library .folder-media-card').count(),1);
    await query.fill('');
    await card('global-video.mp4').waitFor();
    await page.screenshot({path:`.tmp/material-catalog/${entry.startsWith('canvas-reference')?'project':'home'}-video-flat.png`});
    await clickControl('图片'); await closeControls();
    await card('建筑.png').waitFor();
    await page.waitForFunction(top=>Math.abs(document.querySelector('.catalog-scroller').scrollTop-top)<2,imageTop);
    await view('collections');
    await page.getByRole('treeitem',{name:'海报',exact:true}).click();
    await card('海报.png').waitFor();
    assert.equal(await card('project-video.mp4').count(),0,'image collection excludes videos');
    await clickControl('视频'); await closeControls();
    await page.getByRole('region',{name:'平铺浏览视频',exact:true}).waitFor();
    await page.locator('[role="tab"][aria-selected="true"]').focus(); await page.keyboard.press('Tab');
    await page.getByRole('region',{name:'按集合浏览素材',exact:true}).waitFor();
    await page.getByRole('treeitem',{name:'海报',exact:true}).click();
    await card('project-video.mp4').waitFor();
    assert.equal(await card('海报.png').count(),0,'video collection excludes images');
    await clickControl('图片'); await closeControls();
    await card('海报.png').waitFor();
    assert.equal(await page.getByRole('treeitem',{name:'海报',exact:true}).getAttribute('aria-selected'),'true','image collection restored');
    await clickControl('视频'); await closeControls();
    await card('project-video.mp4').waitFor();
    await clickControl('文件浏览器'); await clickControl('文件浏览器'); await closeControls();
    await card('project-video.mp4').waitFor();
    assert.equal(await page.locator('.library-media-switch button[aria-label="视频"]').getAttribute('aria-pressed'),'true','file browser preserves media type');
    if(entry.startsWith('canvas-reference')) {
      await tab('项目素材').click();
      await card('project-video.mp4').waitFor();
      await card('global-video.mp4').waitFor({state:'hidden'});
      assert.equal(await page.locator('.categorized-library .folder-media-card').count(),1,'project video view follows current source');
      await page.locator('[role="tab"][aria-selected="true"]').focus(); await page.keyboard.press('Tab');
      await page.getByRole('region',{name:'按集合浏览素材',exact:true}).waitFor();
      await page.getByRole('treeitem',{name:'海报',exact:true}).click();
      await card('project-video.mp4').waitFor();
    }
    await assertLayout(entry.startsWith('canvas-reference')?'project-video-collection':'home-video-collection');
    await clickControl('图片'); await closeControls();
  }
  await page.evaluate(()=>window.catalogCollections.push(...Array.from({length:40},(_,i)=>({id:`scroll-collection-${i}`,name:`目录 ${i}`,parent_id:null,kind:'collection'}))));
  await view('collections');
  const collectionRail=page.getByRole('scrollbar',{name:'集合目录滚动条'});
  await collectionRail.waitFor({state:'attached'});
  const collectionWidths=await page.locator('.catalog-index').evaluate(el=>[el.offsetWidth,el.clientWidth]);
  assert.equal(collectionWidths[0],collectionWidths[1],'long collection tree has no native scrollbar gutter');
  await collectionRail.focus(); await page.keyboard.press('End');
  assert.ok(await page.locator('.catalog-index').evaluate(el=>el.scrollTop>100),'overlay collection rail retains keyboard scrolling');
  assert.deepEqual(await page.locator('.catalog-index').evaluate(el=>[el.offsetWidth,el.clientWidth]),collectionWidths,'scrolling never changes tree width');
  await page.screenshot({path:'.tmp/material-catalog/collection-tree-overlay.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS grouped tags, shared floating headings, pin/unpin persistence, overlay scrollbar, project scope, canvas drag, A-Z index, selection/dedup/search, collections, light/dark');
} catch (error) {
  await page.screenshot({path:'.tmp/material-catalog/failure.png'});
  throw error;
} finally { await browser.close(); await server.close(); }
