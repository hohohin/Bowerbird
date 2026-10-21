import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ server: { host: '127.0.0.1', port: 1693, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', e => errors.push(e.message));
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
const tab = name => page.locator(`[role="tab"][data-tab-value="${name==='全局素材'?'global':'project'}"]`);
function feedbackSignature(el) {
  return ['.library-tab-overlay','.library-tab-ghost','.library-tab-crossing-arrow','.library-tab-view-label'].map(selector=>{
    const style=getComputedStyle(el.querySelector(selector));
    return [style.animationName,style.animationDuration,style.animationTimingFunction];
  });
}
async function assertHomeAnimation(name) {
  const feedback=page.locator('.library-home .library-tab-feedback');
  await feedback.waitFor();
  assert.equal(await feedback.locator('.library-tab-view-label').innerText(),name);
  assert.equal(await feedback.locator('.library-tab-source-label').innerText(),name,'home reveals the current category name');
  const before=await tab('全局素材').boundingBox();
  const signature=await feedback.evaluate(feedbackSignature);
  const motion=await feedback.evaluate(el=>{
    const animations=el.getAnimations({subtree:true});
    const sample=time=>{
      animations.forEach(animation=>{animation.pause();animation.currentTime=time;});
      const layer=getComputedStyle(el.querySelector('.library-tab-overlay'));
      const ghost=getComputedStyle(el.querySelector('.library-tab-ghost'));
      return {x:new DOMMatrixReadOnly(layer.transform).m41,opacity:layer.opacity,ghost:new DOMMatrixReadOnly(ghost.transform).m11};
    };
    const start=sample(180),middle=sample(500),end=sample(900);
    return {start,middle,end,stroke:getComputedStyle(el.querySelector('.library-tab-crossing-arrow')).stroke,
      textOpacity:getComputedStyle(el.querySelector('.library-tab-view-label')).opacity};
  });
  assert.equal(motion.stroke,'rgb(255, 255, 255)');
  assert.equal(motion.middle.opacity,'1');
  assert.ok(motion.start.ghost<motion.middle.ghost,'home uses expanding ghost');
  assert.ok(motion.end.x>motion.middle.x,'home overlay exits right');
  assert.equal(motion.end.opacity,'1');
  assert.equal(motion.textOpacity,'1','home text leaves with its blue overlay');
  assert.deepEqual(await tab('全局素材').boundingBox(),before,'home feedback preserves geometry');
  await feedback.waitFor({state:'detached'});
  assert.equal(await tab('全局素材').innerText(),name);
  assert.equal(await page.locator('.library-source-key-hint').count(),0);
  return signature;
}
try {
  await page.goto('http://127.0.0.1:1693/scripts/fixtures/project-drop/preview.html?layout');
  await tab('全局素材').waitFor();
  await page.evaluate(() => {
    window.directoryCalls = []; window.aggregateCalls = 0; window.slowBrowse = false; window.loadFlashed = false;
    localStorage.setItem('bowerbird.localFiles.lastDirectory', '/pictures');
    const previous = window.__TAURI_INTERNALS__.invoke;
    const entry = (path, directory = false) => ({ path, name: path.split('/').pop(), directory });
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === 'list_library_view') { const s = window.store.getState(); return { assets:s.assets, memberships:s.libraryMemberships, total:s.total }; }
      if (command === 'file_workspace_all') { window.aggregateCalls++; return { entries:[entry('/pictures/root.png'),entry('/pictures/sub/child.png')], unavailable:[] }; }
      if (command === 'external_files_browse') {
        window.directoryCalls.push(args.path);
        if (window.slowBrowse) await new Promise(r => setTimeout(r, 650));
        const path = args.path || '/pictures';
        return { path, parent:path === '/pictures' ? null : '/pictures', entries:path.endsWith('/sub') ? [entry(path+'/child.png')] : [entry(path+'/sub',true),entry(path+'/root.png')], total:path.endsWith('/sub') ? 1 : 2 };
      }
      if (command === 'folder_classification_view') { await new Promise(r => setTimeout(r, 600)); return { root:args.path, storage:'folder',record:{version:1,recursive:false,labels:[],pictures:[]} }; }
      if (command === 'external_files_preview') return '/src-tauri/resources/samples/preset-01.webp';
      return previous(command,args);
    };
    new MutationObserver(() => { if ([...document.querySelectorAll('[role="status"]')].some(el => el.textContent.includes('正在读取文件夹'))) window.loadFlashed = true; }).observe(document.body,{childList:true,subtree:true});
  });
  assert.deepEqual(await page.getByRole('tab').allTextContents(),['标签分类']);
  assert.equal(await page.locator('.library-source-key-hint').count(),0,'home has no source-switch hints');
  await page.getByRole('region',{name:'按标签浏览素材',exact:true}).waitFor();
  assert.equal(await page.getByRole('group',{name:'文件夹地址栏'}).count(),0);
  const aggregateCalls = await page.evaluate(() => window.aggregateCalls);
  await clickControl('文件浏览器');
  await page.getByRole('button',{name:'文件夹 sub',exact:true}).waitFor();
  assert.equal(await page.locator('.app-topbar .folder-address').count(),1);
  assert.equal(await page.getByRole('button',{name:'child.png',exact:true}).count(),0);
  assert.equal(await page.evaluate(() => window.aggregateCalls),aggregateCalls);
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => window.loadFlashed),false);
  await page.getByRole('button',{name:'文件夹 sub',exact:true}).dblclick();
  await page.getByRole('button',{name:'child.png',exact:true}).waitFor();
  await page.getByRole('button',{name:'上一级',exact:true}).click();
  await page.getByRole('button',{name:'文件夹 sub',exact:true}).waitFor();
  await tab('全局素材').click();
  await page.evaluate(() => window.slowBrowse = true);
  await clickControl('文件浏览器');
  await page.getByRole('status').filter({hasText:'正在读取文件夹'}).waitFor();
  await tab('全局素材').click(); await page.waitForTimeout(800);
  await page.getByRole('region',{name:'按标签浏览素材',exact:true}).waitFor();
  assert.equal(await page.locator('.local-file-workspace').count(),0,'late file responses cannot replace category view');
  await tab('全局素材').focus(); await page.keyboard.press('Tab');
  await page.getByRole('region',{name:'按集合浏览素材',exact:true}).waitFor();
  const homeSignature=await assertHomeAnimation('集合分类');
  await page.keyboard.press('Shift+Tab');
  await page.getByRole('region',{name:'按标签浏览素材',exact:true}).waitFor();
  assert.deepEqual(await assertHomeAnimation('标签分类'),homeSignature);
  assert.equal(await page.locator('.local-file-workspace').count(),0,'Tab never enters file browser');
  await page.getByRole('button',{name:'我的项目',exact:true}).click();
  const panel = page.getByRole('dialog',{name:'项目管理',exact:true});
  await panel.waitFor();
  const sizesBefore = await page.evaluate(() => ({library:window.store.getState().libraryThumbnailWidth, canvas:window.store.getState().canvasThumbnailWidth, projects:window.store.getState().projectsThumbnailWidth}));
  await panel.locator('.project-manager-gallery').dispatchEvent('wheel',{ctrlKey:true,deltaY:-120,bubbles:true,cancelable:true});
  assert.equal(await page.evaluate(() => window.store.getState().libraryThumbnailWidth), sizesBefore.library, 'project wheel zoom must not resize the background gallery');
  assert.equal(await page.evaluate(() => window.store.getState().canvasThumbnailWidth), sizesBefore.canvas, 'project zoom must not resize canvas sources');
  assert.ok(await page.evaluate(before => window.store.getState().projectsThumbnailWidth > before, sizesBefore.projects));
  const projectSize = panel.getByRole('spinbutton',{name:'项目卡片大小数值'});
  await projectSize.fill('65'); await projectSize.press('Enter');
  assert.equal(await page.evaluate(() => window.store.getState().libraryThumbnailWidth), sizesBefore.library, 'project slider has independent storage too');
  assert.equal(await page.evaluate(() => window.createdProjects || 0),0,'toolbar opens manager without creating a project');
  await panel.getByRole('button',{name:'打开项目 目标项目'}).waitFor();
  await panel.getByRole('textbox',{name:'搜索项目'}).fill('空');
  assert.equal(await panel.getByRole('button',{name:'打开项目 目标项目'}).count(),0);
  await panel.getByRole('textbox',{name:'搜索项目'}).fill('');
  await mkdir('.tmp/material-navigation',{recursive:true});
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme,theme);
    for (const width of [1280,760]) {
      await page.setViewportSize({width,height:840}); await page.waitForTimeout(350);
      const box = await panel.locator('.app-modal').boundingBox();
      assert.ok(box.x >= 0 && box.x+box.width <= width && box.y+box.height <= 840);
      await page.screenshot({path:`.tmp/material-navigation/projects-${theme}-${width}.png`});
    }
  }
  await page.keyboard.press('Escape'); await closeControls(); await panel.waitFor({state:'hidden'});
  assert.equal(await tab('全局素材').getAttribute('aria-selected'),'true');
  await page.getByRole('button',{name:'我的项目',exact:true}).click();
  await panel.getByRole('button',{name:'新建项目',exact:true}).click();
  assert.equal(await page.evaluate(() => window.createdProjects),1);
  await panel.waitFor({state:'hidden'});
  await page.evaluate(() => window.store.setState({enterProject:async id => {window.openedProject=id;}}));
  await page.getByRole('button',{name:'我的项目',exact:true}).click();
  assert.equal(await panel.getByRole('spinbutton',{name:'项目卡片大小数值'}).inputValue(),'65','project size survives closing and reopening the panel');
  await panel.getByRole('button',{name:'打开项目 目标项目'}).click();
  await panel.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(() => window.openedProject),'p');
  await page.goto('http://127.0.0.1:1693/scripts/fixtures/canvas-reference/preview.html?source-library');
  await page.waitForFunction(() => document.querySelector('.canvas-workspace')?.getAttribute('aria-busy') === 'false');
  await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab');
  const sources = page.getByRole('complementary',{name:'画板素材库'});
  const region = kind => sources.getByRole('region',{name:kind==='tags'?'按标签浏览素材':'按集合浏览素材',exact:true});
  await region('tags').waitFor();
  assert.deepEqual(await sources.getByRole('tab').evaluateAll(tabs=>tabs.map(tab=>tab.getAttribute('aria-label'))),['全局素材','项目素材']);
  assert.equal(await tab('全局素材').getAttribute('aria-selected'),'true','Tab opens the first source');
  await tab('项目素材').click();
  await sources.evaluate(async el => { await Promise.all(el.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{}))); });
  const switchBox=await sources.locator('.library-view-switch').boundingBox();
  await page.mouse.move(5,5); await page.waitForTimeout(150);
  assert.deepEqual(await sources.locator('.library-source-key-hint').evaluateAll(hints=>hints.map(el=>getComputedStyle(el).opacity)),['0','0']);
  await sources.locator('.library-view-switch').hover(); await page.waitForTimeout(150);
  const hints=await sources.locator('.library-view-switch').evaluate(el=>{
    const box=el.getBoundingClientRect();
    const keys=[...el.querySelectorAll('.library-source-key-hint')];
    return {inside:keys.every(key=>{const r=key.getBoundingClientRect();return r.left>=box.left && r.right<=box.right && r.top>=box.top && r.bottom<=box.bottom;}),
      noOverlap:keys.every(key=>{
        const range=document.createRange();range.selectNodeContents(key.closest('button').firstChild);
        const text=range.getBoundingClientRect(),r=key.getBoundingClientRect(); return r.right<=text.left || r.left>=text.right;
      }),visible:keys.every(key=>getComputedStyle(key).opacity==='1'),arrows:keys.some(key=>key.querySelector('svg'))};
  });
  assert.deepEqual(hints,{inside:true,noOverlap:true,visible:true,arrows:false},'hover reveals only keycaps inside the switch without covering names');
  assert.deepEqual(await sources.locator('.library-source-key-hint kbd').allTextContents(),['Q','E']);
  assert.deepEqual(await sources.locator('.library-view-switch').boundingBox(),switchBox,'hover never shifts navigation');
  await page.screenshot({path:'.tmp/material-navigation/source-keycaps-hover.png'});
  await page.mouse.move(5,5); await page.waitForTimeout(150);
  assert.deepEqual(await sources.locator('.library-source-key-hint').evaluateAll(hints=>hints.map(el=>getComputedStyle(el).opacity)),['0','0'],'keycaps disappear after pointer leaves');
  const close=page.getByRole('button',{name:'关闭素材库',exact:true});
  assert.equal(await close.locator('.canvas-library-close-hint').innerText(),'ESC');
  const handleLayout=await page.locator('.canvas-library-resize').evaluate(el=>{
    const panel=el.parentElement.querySelector('.canvas-source-panel').getBoundingClientRect();
    const box=el.getBoundingClientRect(),hint=el.querySelector('.canvas-library-close-hint').getBoundingClientRect();
    const icon=el.querySelector('.canvas-library-close svg').getBoundingClientRect();
    return {atTop:Math.abs(box.top-panel.top)<1,outside:box.left>=panel.right-.5,hintAbove:hint.bottom<=icon.top,
      clickable:el.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))};
  });
  assert.deepEqual(handleLayout,{atTop:true,outside:true,hintAbove:true,clickable:true});
  assert.equal(await sources.locator('.library-tab-feedback').count(),0,'first Tab only opens the library');
  const initial=await tab('项目素材').evaluate(el=>({box:el.getBoundingClientRect().toJSON(),radius:getComputedStyle(el).borderRadius}));
  await tab('项目素材').focus(); await page.keyboard.press('Tab'); await region('collections').waitFor();
  const empty=sources.locator('.catalog-empty');
  await sources.getByText('还没有集合，点击左侧 ＋ 新建集合。',{exact:true}).waitFor();
  const emptyLayout=await empty.evaluate(el=>{
    const range=document.createRange(); range.selectNodeContents(el);
    const text=range.getBoundingClientRect(), area=el.closest('.catalog-gallery').getBoundingClientRect();
    return {dy:Math.abs(text.y+text.height/2-area.y-area.height/2),dx:Math.abs(text.x+text.width/2-area.x-area.width/2)};
  });
  assert.ok(emptyLayout.dx<2 && emptyLayout.dy<2,'empty message is centered in content without top spacer');
  const feedback=sources.locator('.library-tab-feedback');
  await feedback.waitFor();
  assert.deepEqual(await feedback.evaluate(feedbackSignature),homeSignature,'home and project use identical animation names, durations and easing');
  assert.equal(await feedback.locator('.library-tab-view-label').innerText(),'集合分类');
  const frames=[];
  for(const time of [180,500,900]) {
    frames.push(await feedback.evaluate((el,time)=>{
      for(const animation of el.getAnimations({subtree:true})) {animation.pause();animation.currentTime=time;}
      const tab=el.closest('button'); const arrow=el.querySelector('svg'); const label=el.querySelector('.library-tab-view-label');
      return {box:tab.getBoundingClientRect().toJSON(),radius:getComputedStyle(tab).borderRadius,
        stroke:getComputedStyle(arrow).stroke,fill:getComputedStyle(el.querySelector('.library-tab-overlay')).backgroundColor,
        fillOpacity:getComputedStyle(el.querySelector('.library-tab-overlay')).opacity,
        overlayTransform:getComputedStyle(el.querySelector('.library-tab-overlay')).transform,
        ghost:getComputedStyle(el.querySelector('.library-tab-ghost')).transform,
        sourceOpacity:getComputedStyle(el.querySelector('.library-tab-source-label')).opacity,
        sourceTransform:getComputedStyle(el.querySelector('.library-tab-source-label')).transform,
        arrow:getComputedStyle(arrow).transform,labelOpacity:getComputedStyle(label).opacity,duration:getComputedStyle(arrow).animationDuration};
    },time));
    await page.screenshot({path:`.tmp/material-navigation/tab-motion-${time}.png`});
  }
  assert.ok(frames.every(f=>f.box.width===initial.box.width && f.box.height===initial.box.height && f.box.y===initial.box.y && f.radius===initial.radius),'animation preserves size, height and radius while centering follows the view sidebar');
  assert.ok(frames.every(f=>f.duration==='1s'));
  assert.equal(frames[1].labelOpacity,'1','category name is readable mid-animation');
  assert.equal(frames[0].stroke,'rgb(255, 255, 255)','arrow is white');
  assert.equal(frames[0].fillOpacity,'1','blue fill is opaque while arrow crosses');
  assert.equal(frames[1].fillOpacity,'1','blue fill remains behind category name');
  assert.notEqual(frames[0].fill,'rgba(0, 0, 0, 0)');
  assert.ok(Number(frames[0].ghost.split('(')[1].split(',')[0])<Number(frames[1].ghost.split('(')[1].split(',')[0]),'ghost expands');
  assert.equal(frames[2].sourceOpacity,'1','original name remains visible underneath the exiting overlay');
  assert.equal(frames[2].labelOpacity,'1','category text exits with the blue block without fading');
  assert.equal(frames[2].fillOpacity,'1','blue block stays opaque during exit');
  assert.ok(Number(frames[2].overlayTransform.split(',')[4])>0,'blue block and its child text slide right together');
  assert.ok(frames.every(frame=>frame.sourceTransform==='none'),'original name stays still');
  assert.ok(Number(frames[0].arrow.split(',')[4])<Number(frames[1].arrow.split(',')[4]),'arrow moves left to right');
  await feedback.waitFor({state:'detached'});
  assert.equal(await tab('项目素材').evaluate(el=>el.firstChild.textContent),'项目素材');
  await page.keyboard.press('Tab'); await page.waitForTimeout(150);
  await page.keyboard.press('Tab'); await page.waitForTimeout(150);
  await page.keyboard.press('Tab');
  assert.equal(await sources.locator('.library-tab-view-label').innerText(),'标签分类','rapid input replaces the previous animation');
  await page.waitForTimeout(800);
  assert.equal(await sources.locator('.library-tab-feedback').count(),1,'old timeout does not clear newest feedback');
  await page.waitForTimeout(300);
  assert.equal(await sources.locator('.library-tab-feedback').count(),0);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.keyboard.press('Tab'); await region('collections').waitFor();
  assert.equal(await sources.locator('.library-tab-crossing-arrow').evaluate(el=>getComputedStyle(el).display),'none');
  assert.equal(await sources.locator('.library-tab-view-label').evaluate(el=>getComputedStyle(el).opacity),'1');
  await page.emulateMedia({reducedMotion:'no-preference'});

  await page.keyboard.press('q'); await region('tags').waitFor();
  assert.equal(await sources.locator('.library-tab-feedback').count(),0,'source change cancels feedback');
  assert.equal(await tab('全局素材').getAttribute('aria-selected'),'true');
  await page.keyboard.press('e'); await region('collections').waitFor();
  assert.equal(await tab('项目素材').getAttribute('aria-selected'),'true','each source remembers its own view');
  await page.keyboard.press('Tab'); await region('tags').waitFor();
  const search=page.getByRole('textbox',{name:'搜索分类素材'});
  await search.fill('qe'); await search.press('q'); await search.press('e');
  assert.equal(await tab('项目素材').getAttribute('aria-selected'),'true','typing Q/E does not switch source');
  await search.press('Tab'); await region('tags').waitFor();
  await search.fill('');
  await tab('项目素材').focus();
  await tab('项目素材').dispatchEvent('keydown',{key:'q',isComposing:true,bubbles:true});
  assert.equal(await tab('项目素材').getAttribute('aria-selected'),'true','IME composition does not switch source');
  await page.keyboard.press('Control+e');
  assert.equal(await tab('项目素材').getAttribute('aria-selected'),'true');
  await clickControl('文件浏览器');
  await sources.getByRole('button',{name:'文件夹 旅行',exact:true}).waitFor();
  assert.equal((await sources.locator('.library-view-switch').boundingBox()).width,switchBox.width,'file tool preserves switch width');
  await page.keyboard.press('Control+l');
  await page.getByRole('textbox',{name:'文件夹路径'}).fill('/pending-edit');
  await page.keyboard.press('Escape'); await closeControls();
  assert.equal(await page.evaluate(()=>window.store.getState().canvasLibraryOpen),true);
  await tab('项目素材').focus(); await page.keyboard.press('Tab'); await region('collections').waitFor();
  assert.equal(await sources.locator('.local-file-workspace').count(),0);
  await page.keyboard.press('Tab'); await region('tags').waitFor();
  await sources.getByRole('button',{name:'管理标签',exact:true}).click();
  const classification=page.getByRole('dialog',{name:'管理分类数据',exact:true});
  await classification.getByText('项目 · 引用布局合成验收',{exact:true}).waitFor();
  await classification.press('q');
  assert.equal(await tab('项目素材').getAttribute('aria-selected'),'true','dialog owns its keys');
  await page.keyboard.press('Escape'); await closeControls(); await classification.waitFor({state:'hidden'});
  assert.equal(await page.locator('.library-tag-bar').count(),0);
  await sources.focus(); await page.keyboard.press('Escape'); await closeControls();
  await page.waitForFunction(()=>!window.store.getState().canvasLibraryOpen);
  await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab'); await region('tags').waitFor();
  assert.equal(await tab('全局素材').getAttribute('aria-selected'),'true','reopening resets the source to the first tab');
  await sources.evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
  const grip=page.getByRole('separator',{name:'调整素材库宽度'});
  const beforeResize=await sources.boundingBox(),gripBox=await grip.boundingBox();
  await page.mouse.move(gripBox.x+gripBox.width/2,gripBox.y+gripBox.height/2);
  await page.mouse.down(); await page.mouse.move(gripBox.x-100+gripBox.width/2,gripBox.y+gripBox.height/2,{steps:6}); await page.mouse.up();
  assert.ok(Math.abs((await sources.boundingBox()).width-beforeResize.width+100)<2,'top grip still resizes the panel');
  await grip.focus(); await grip.press('End');
  assert.ok(Math.abs((await sources.boundingBox()).width-beforeResize.width)<2);
  await page.screenshot({path:'.tmp/material-navigation/canvas-sources.png'});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.waitForTimeout(300);
  await page.screenshot({path:'.tmp/material-navigation/canvas-sources-dark.png'});
  await close.click();
  await page.waitForFunction(()=>!window.store.getState().canvasLibraryOpen);
  await page.keyboard.press('Tab');
  await sources.evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
  async function centered() {
    const geometry=await sources.evaluate(el=>{
      const surface=el.querySelector('.categorized-library, .local-file-workspace').getBoundingClientRect();
      const sidebar=el.querySelector('.catalog-sidebar, .file-browser-places').getBoundingClientRect();
      const bar=el.querySelector('.library-view-switch').getBoundingClientRect();
      return {center:(bar.left+bar.right-sidebar.right-surface.right)/2,top:bar.top,width:bar.width};
    });
    assert.ok(Math.abs(geometry.center)<1,`switch is centered in the content area: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(geometry.width-224*.8)<1,'switch width is reduced by 20 percent');
    return geometry;
  }
  await page.setViewportSize({width:1280,height:840});
  await page.waitForFunction(()=>Number(document.querySelector('.canvas-library-grip').getAttribute('aria-valuemax'))>900);
  for(const value of [620,480,900]) {
    await grip.focus(); await grip.press('Home');
    await page.waitForFunction(()=>{const grip=document.querySelector('.canvas-library-grip');return grip.getAttribute('aria-valuenow')===grip.getAttribute('aria-valuemin');});
    await page.waitForTimeout(250);
    // Dragging uses the actual panel boundary, preserving keyboard resize coverage above.
    const box=await grip.boundingBox(), before=await sources.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.down(); await page.mouse.move(box.x+box.width/2+value-before.width,box.y+box.height/2,{steps:6}); await page.mouse.up();
    await page.waitForTimeout(100);
    assert.ok(Math.abs((await sources.boundingBox()).width-Math.max(value,Number(await grip.getAttribute('aria-valuemin'))))<2,`drag is clamped to minimum: requested=${value}, width=${(await sources.boundingBox()).width}, minimum=${await grip.getAttribute('aria-valuemin')}`);
    for(const mode of ['tags','collections','files']) {
      if(mode==='collections') { await sources.focus(); await page.keyboard.press('Tab'); await region('collections').waitFor(); }
      if(mode==='files') await clickControl('文件浏览器');
      const before=await centered();
      assert.ok(await sources.locator('.library-controls-host').evaluate(el=>{
        const controls=el.getBoundingClientRect(), bar=el.closest('.file-view-heading').querySelector('.library-view-switch').getBoundingClientRect();
        return controls.top>=bar.bottom || controls.left>=bar.right;
      }),'controls never overlap the centered switch');
      await clickControl('颜色筛选');
      await page.waitForTimeout(250);
      assert.deepEqual(await centered(),before,'expanded controls do not move the switch');
      await page.keyboard.press('Escape'); await closeControls();
      if(value===480 && mode==='collections') await page.screenshot({path:'.tmp/material-navigation/content-center-narrow-collections.png'});
      if(mode==='files') { await clickControl('文件浏览器'); await sources.focus(); await page.keyboard.press('Tab'); await region('tags').waitFor(); }
    }
  }
  await tab('项目素材').click(); await close.click(); await page.keyboard.press('Tab');
  assert.equal(await tab('全局素材').getAttribute('aria-selected'),'true');
  assert.equal(await grip.getAttribute('aria-valuenow'),'900');
  await page.reload(); await page.waitForFunction(()=>document.querySelector('.canvas-workspace')?.getAttribute('aria-busy')==='false');
  await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab');
  assert.equal(await grip.getAttribute('aria-valuenow'),'900','width persists after remount/reload');
  await page.setViewportSize({width:760,height:840});
  await page.waitForFunction(()=>Number(document.querySelector('.canvas-library-grip').getAttribute('aria-valuenow'))<760);
  assert.equal(await page.evaluate(()=>localStorage.getItem('bowerbird.canvasLibraryWidth')),'900','window clamping never overwrites the preference');
  await page.setViewportSize({width:1280,height:840});
  await page.waitForFunction(()=>document.querySelector('.canvas-library-grip').getAttribute('aria-valuenow')==='900');
  await sources.evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
  await centered();
  const sidebarResize=sources.getByRole('separator',{name:'调整标签侧栏宽度'});
  await sidebarResize.focus(); await sidebarResize.press('End');
  await centered();
  await sidebarResize.press('Home');
  await centered();
  await page.screenshot({path:'.tmp/material-navigation/remembered-width-centered.png'});
  await grip.focus(); await grip.press('End');
  assert.equal(await page.evaluate(()=>localStorage.getItem('bowerbird.canvasLibraryWidth')),null,'restore maximum clears the saved width');
  assert.deepEqual(errors,[]);
  console.log('PASS two-source Q/E navigation, per-source Tab views, IME/editor/dialog guards, independent browser and stale response protection, project manager');
} finally { await browser.close(); await server.close(); }
