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
const tab = name => page.getByRole('tab', { name, exact: true });
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
  await tab('全局素材').click();
  await page.getByRole('button',{name:'child.png',exact:true}).waitFor();
  assert.equal(await page.getByRole('group',{name:'文件夹地址栏'}).count(),0,'global view has no address bar');
  assert.equal(await page.locator('.app-file-navigation-slot').count(),0,'global view reserves no address slot');
  assert.equal(await page.getByRole('button',{name:'浏览本机文件',exact:true}).count(),0);
  const aggregateCalls = await page.evaluate(() => window.aggregateCalls);
  await tab('文件浏览器').click();
  await page.getByRole('button',{name:'文件夹 sub',exact:true}).waitFor();
  assert.equal(await page.locator('.app-topbar .folder-address').count(),1,'file browser has its address bar in the top toolbar');
  assert.equal(await page.getByRole('button',{name:'child.png',exact:true}).count(),0,'directory view must not flatten descendants');
  assert.equal(await page.evaluate(() => window.aggregateCalls), aggregateCalls,'browser never invokes aggregate enumeration');
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => window.loadFlashed),false,'classification does not keep directory loading visible');
  await page.getByRole('button',{name:'文件夹 sub',exact:true}).dblclick();
  await page.getByRole('button',{name:'child.png',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'root.png',exact:true}).count(),0);
  await page.getByRole('button',{name:'上一级',exact:true}).click();
  await page.getByRole('button',{name:'文件夹 sub',exact:true}).waitFor();
  await tab('全局素材').click(); await page.getByRole('button',{name:'child.png',exact:true}).waitFor();
  await page.evaluate(() => window.slowBrowse = true);
  await tab('文件浏览器').click();
  await page.getByRole('status').filter({hasText:'正在读取文件夹'}).waitFor();
  await tab('全局素材').click();
  await page.waitForTimeout(800);
  assert.equal(await tab('全局素材').getAttribute('aria-selected'),'true','late directory response cannot replace aggregate mode');
  await page.getByRole('button',{name:'child.png',exact:true}).waitFor();
  await page.evaluate(() => window.slowBrowse = false);
  await tab('全局素材').focus(); await page.keyboard.press('Tab');
  await page.getByRole('button',{name:'文件夹 sub',exact:true}).waitFor();
  await page.keyboard.press('Shift+Tab');
  await page.getByRole('button',{name:'child.png',exact:true}).waitFor();
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
  await page.keyboard.press('Escape'); await panel.waitFor({state:'hidden'});
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
  await sources.locator('[data-asset-id="existing"]').waitFor();
  const switchBox = async () => {
    await sources.evaluate(async el => { await Promise.all(el.getAnimations({subtree:true}).map(animation => animation.finished.catch(() => {}))); });
    return sources.locator('.library-view-switch:visible').boundingBox();
  };
  const projectSwitch = await switchBox();
  assert.deepEqual(await sources.getByRole('tab').allTextContents(),['项目素材','全局素材','文件浏览器']);
  assert.equal(await sources.getByRole('tab',{name:'项目素材',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'file_workspace_all' || c.command === 'external_files_browse').length),0,'opening canvas sources only shows project assets');
  await sources.getByRole('tab',{name:'项目素材',exact:true}).focus(); await page.keyboard.press('Alt+ArrowRight');
  assert.equal(await sources.getByRole('tab').first().innerText(),'项目素材','project view stays first');
  await page.keyboard.press('Tab');
  await sources.getByRole('button',{name:'原图.png',exact:true}).waitFor();
  assert.deepEqual(await switchBox(),projectSwitch,'global switch matches project switch position and size');
  assert.equal(await page.getByRole('group',{name:'文件夹地址栏'}).count(),0);
  assert.equal(await sources.getByRole('button',{name:'管理标签',exact:true}).isVisible(),false,'collapsed empty tag lists also hide management');
  await page.keyboard.press('Tab');
  await sources.getByRole('button',{name:'文件夹 旅行',exact:true}).waitFor();
  assert.deepEqual(await switchBox(),projectSwitch,'browser switch matches project switch position and size');
  await page.keyboard.press('Control+l');
  await page.getByRole('textbox',{name:'文件夹路径'}).fill('/pending-edit');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.store.getState().canvasLibraryOpen),true,'first Escape cancels address editing');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.store.getState().canvasLibraryOpen);
  await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab');
  await sources.locator('[data-asset-id="existing"]').waitFor();
  assert.equal(await sources.getByRole('tab',{name:'项目素材',exact:true}).getAttribute('aria-selected'),'true','reopening defaults to current project assets');
  await page.keyboard.press('Shift+Tab');
  await sources.getByRole('button',{name:'文件夹 旅行',exact:true}).waitFor();
  await sources.getByRole('button',{name:'返回画板',exact:true}).click();
  await page.getByRole('button',{name:'展开画板素材库',exact:true}).click();
  await sources.locator('[data-asset-id="existing"]').waitFor();
  assert.equal(await sources.getByRole('tab',{name:'项目素材',exact:true}).getAttribute('aria-selected'),'true','button opening also defaults to project assets');
  await page.screenshot({path:'.tmp/material-navigation/canvas-sources.png'});
  for (const view of ['项目素材','全局素材','文件浏览器']) {
    await sources.getByRole('tab',{name:view,exact:true}).click();
    await page.waitForTimeout(400);
    const bar=await sources.locator('.library-tag-bar:visible').boundingBox();
    await page.mouse.move(bar.x+bar.width-10,bar.y+bar.height/2);
    await sources.locator('.library-tag-manage:visible').waitFor();
    await sources.locator('.library-tag-content:visible').evaluate(async el => { await Promise.all(el.getAnimations({subtree:true}).map(animation => animation.finished.catch(() => {}))); });
    const manager=sources.getByRole('button',{name:'管理标签',exact:true});
    assert.equal(await manager.evaluate(el => { const r=el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); }),true,`${view}: hovered management is clickable`);
    await manager.click();
    const classification=page.getByRole('dialog',{name:'管理分类数据',exact:true});
    await classification.waitFor();
    if (view === '项目素材') {
      await classification.getByText('分类目标：项目 · 引用布局合成验收',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='project_classification_labels').at(-1).args.projectId),'p');
      await classification.getByRole('button',{name:'寻找匹配',exact:true}).click();
      await page.waitForFunction(()=>window.calls.some(c=>c.command==='project_classification_start'));
      assert.deepEqual(await page.evaluate(()=>window.calls.find(c=>c.command==='project_classification_start').args),{projectId:'p',tagId:'project-label',pendingOnly:true});
      assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command==='local_classification_start'||c.command==='global_classification_start')),false);
    }
    assert.equal(await classification.getByRole('button',{name:'选择目标文件夹',exact:true}).count(),view === '文件浏览器' ? 1 : 0);
    assert.equal(await classification.getByRole('button',{name:'自动分类设置',exact:true}).count(),0);
    assert.equal(await classification.getByRole('textbox',{name:'标签名称',exact:true}).count(),0);
    await classification.getByRole('button',{name:'新建标签',exact:true}).click();
    await classification.getByRole('textbox',{name:'标签名称',exact:true}).waitFor();
    await classification.getByRole('button',{name:'取消',exact:true}).click();
    await page.screenshot({path:`.tmp/material-navigation/classification-${view}.png`});
    await page.keyboard.press('Escape'); await classification.waitFor({state:'hidden'});
    await page.screenshot({path:`.tmp/material-navigation/canvas-${view}.png`});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS manager open/search/create/select, directory-only browsing, no aggregate overlap, delayed loading, stale response protection, Tab cycling, light/dark wide/narrow panels');
} finally { await browser.close(); await server.close(); }
