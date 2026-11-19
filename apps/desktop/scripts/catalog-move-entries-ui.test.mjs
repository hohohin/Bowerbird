import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/catalog-move-entries/vite', server: { host: '127.0.0.1', port: 17974, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const url = server.resolvedUrls.local[0] + 'scripts/fixtures/connected-collections/preview.html?file-tasks';
const name = '移动到文件夹';
try {
  for (const view of ['global', 'tags', 'project', 'collections']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(7000);
    page.setDefaultNavigationTimeout(90000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => !!window.store);
    await page.evaluate(view => {
      const backend = window.__TAURI_INTERNALS__;
      const previous = backend.invoke.bind(backend);
      window.moveTasks = [];
      window.projectMoves = [];
      window.exports = [];
      window.exportPickers = [];
      const projects = [
        {id:'test-project',name:'测试项目',archived_at:null},
        {id:'other-project',name:'目标项目',archived_at:null},
        {id:'workspace',name:'创作中的项目',archived_at:null},
      ];
      window.store.setState({ projects, activeProjectId:'workspace' });
      const receipts = [];
      const assets = window.entries.slice(0, 3).map(item => item.asset);
      backend.invoke = async (cmd, args) => {
        if (cmd === 'list_projects') return projects;
        if (cmd === 'move_assets_to_project') { window.projectMoves.push(args); return {changed:args.assetIds.length}; }
        if (cmd === 'plugin:dialog|open' || cmd === 'plugin:dialog|save') {
          window.exportPickers.push({cmd,options:args.options}); return window.exportPath ?? null;
        }
        if (cmd === 'export_assets_to_directory' || cmd === 'export_assets_zip') {
          window.exports.push({cmd,...args}); return args.assetIds.length;
        }
        if (cmd === 'catalog_overview') return { total: 3, untagged: 0, catalog: { tags: [{ id: 'tag', name: '测试标签', description: '', count: 3, projectCount: 0 }], collections: [], prompts: [], tag_asset_ids: {} } };
        if (cmd === 'catalog_page') { window.catalogProject = args.filter.projectId; return assets.slice(args.offset, args.offset + args.limit); }
        if (cmd === 'get_assets_by_ids') return assets.filter(asset => args.assetIds.includes(asset.id));
        if (cmd === 'preview_asset_originals') return args.assetIds.map(id => id === 'root-2' ? { asset_id:id, error:'所选文件不可用' } :
          { asset_id:id, name:id+'.png', fingerprint:'frozen-'+id, path:'/fixture/'+id+'.png', missing:window.missing === id });
        if (cmd === 'project_canvas_get') return {nodes:[]};
        if (cmd === 'resolve_connection_entries') {
          const resolved = (await previous(cmd, args)).filter(row => row.id !== window.dropEntry);
          window.resolvedSelection = args.ids.join();
          return resolved.map(row => row.id === window.noVersion ? {...row,version:null} : row);
        }
        if (cmd === 'list_file_tasks') return receipts;
        if (cmd === 'start_file_task') {
          window.moveTasks.push(args.request);
          const total = (args.request.ids ?? args.request.originals).length;
          receipts.push({ id:args.id,title:args.title,phase:'finished',total,completed:total,succeeded:total,
            skipped:0,recycled:0,cleaned:0,failures:[],retryId:null });
          return;
        }
        return previous(cmd, args);
      };
      if (view === 'project') {
        window.mode.getState().selectProject('test-project');
      }
      if (view === 'collections') {
        window.entries.filter(e => ['ref-one','ref-two'].includes(e.id)).forEach(e => { e.available = false; });
        window.changed();
      }
      window.mode.getState().setView(view);
    }, view);
    const entryView = view === 'collections';
    if (entryView) await page.locator('[data-collection-id="child"]').click();
    const item = (index) => entryView ? page.locator(`[data-connection-entry="${['ref-one','ref-two'][index]}"] .folder-media-card`)
      : page.locator(`.folder-media-card[data-asset-id="root-${index}"]`);
    const dialog = page.getByRole('dialog', { name, exact: true });
    const menu = page.getByRole('menuitem', { name, exact: true });
    const action = label => page.getByRole('menuitem', { name:label, exact:true });
    const bar = page.getByRole('group', { name: '分类素材所选操作' });
    const confirm = async () => {
      await dialog.getByText('另一目录', { exact: true }).click();
      assert.ok(await dialog.getByRole('radio', { name: '另一目录', exact:true }).isChecked());
      await dialog.getByRole('button', { name, exact: true }).click();
      await dialog.waitFor({state:'detached'});
    };
    async function checkOmissions(count) {
      await page.getByRole('button', {name:'查看文件任务',exact:true}).click();
      const panel = page.getByRole('dialog',{name:'文件任务',exact:true});
      const result = panel.getByRole('listitem').first();
      await result.getByText('查看预检跳过的 '+count+' 项',{exact:true}).click();
      assert.ok(await result.locator('details[open] li').count() === count);
      await page.keyboard.press('Escape');
    }
    async function exportMenu() {
      await item(0).click({button:'right'});
      assert.equal(await action('将所选内容打包为压缩包').count(), 0);
      await action('导出').hover();
      const submenu = page.getByRole('menu', {name:'导出', exact:true});
      await submenu.waitFor();
      assert.equal(await submenu.locator('p').innerText(), '您也可以长按素材，看到界面变化后，直接将素材拖动到其他应用中');
      assert.deepEqual(await submenu.getByRole('menuitem').allInnerTexts(), ['将所选内容导出到..','将所选内容打包为压缩包']);
    }
    await exportMenu();
    await action('将所选内容导出到..').click();
    await page.waitForFunction(() => window.exportPickers.length === 1);
    assert.equal(await page.evaluate(() => window.exportPickers[0].options.directory), true);
    assert.deepEqual(await page.evaluate(() => window.exports), []);
    await page.evaluate(() => { window.exportPath = '/fixtures/export'; });
    await exportMenu();
    await action('将所选内容导出到..').click();
    await page.waitForFunction(() => window.exports.length === 1);
    assert.deepEqual(await page.evaluate(() => window.exports[0]), {cmd:'export_assets_to_directory',assetIds:['root-0'],path:'/fixtures/export'});
    await item(0).click({modifiers:['Control']});
    await item(1).click();
    await page.evaluate(() => { window.exportPath = '/fixtures/export.zip'; });
    await exportMenu();
    await action('将所选内容打包为压缩包').click();
    await page.waitForFunction(() => window.exports.length === 2);
    const twoAssets = entryView ? ['root-0'] : ['root-0','root-1'];
    assert.deepEqual(await page.evaluate(() => window.exports[1]), {cmd:'export_assets_zip',assetIds:twoAssets,path:'/fixtures/export.zip'});
    assert.equal(await page.evaluate(() => window.exportPickers.at(-1).options.title), '将所选内容打包为压缩包');
    await item(0).click({button:'right'});
    await action('移动到项目').click();
    const projectDialog = page.getByRole('dialog',{name:'移动到项目',exact:true});
    const moveButton = projectDialog.getByRole('button',{name:'移动',exact:true});
    assert.ok(await moveButton.isDisabled());
    await projectDialog.getByRole('radio',{name:'目标项目',exact:true}).check();
    await moveButton.click();
    await projectDialog.waitFor({state:'detached'});
    assert.deepEqual(await page.evaluate(() => window.projectMoves), [{
      assetIds:twoAssets,sourceProjectId:view === 'project' ? 'test-project' : null,targetProjectId:'other-project',
    }]);
    await bar.waitFor({state:'detached'});
    await item(0).click({button:'right'});
    await menu.click();
    await dialog.getByRole('button', { name:'取消', exact:true }).click();
    assert.equal(await page.evaluate(() => window.moveTasks.length), 0);
    await item(0).click({button:'right'});
    await menu.click();
    await confirm();
    await item(0).click({modifiers:['Control']});
    await item(1).click();
    await item(1).click({button:'right'});
    await menu.click();
    await confirm();
    await bar.waitFor({state:'detached'});
    await item(0).click({modifiers:['Control']});
    await item(1).click();
    if (!entryView) {
      await item(2).click();
      await page.evaluate(() => { window.missing = 'root-1'; });
    }
    await bar.getByRole('button',{name,exact:true}).click();
    if (!entryView) await dialog.getByRole('alert').getByText(/以下 2 项将跳过/).waitFor();
    await confirm();
    const tasks = await page.evaluate(() => window.moveTasks);
    assert.equal(tasks.length, 3);
    assert.ok(tasks.every(t => t.folderId === 'second'));
    if (entryView) {
      assert.ok(tasks.every(t => t.kind === 'move'));
      assert.deepEqual(tasks[0].ids, ['ref-one']);
      for (const task of tasks.slice(1)) {
        assert.deepEqual(task.ids, ['ref-one','ref-two']);
        assert.deepEqual(task.versions, {'ref-one':'1','ref-two':'1'});
      }
      for (const trigger of ['menu','bar']) {
        await page.evaluate(() => { window.resolvedSelection = ''; window.dropEntry = ''; window.noVersion = ''; });
        await item(0).click({modifiers:['Control']});
        await item(1).click();
        await page.waitForFunction(() => window.resolvedSelection === 'ref-one,ref-two');
        if (trigger === 'menu') {
          await page.evaluate(() => { window.dropEntry = 'ref-two'; });
          await item(0).click({button:'right'}); await menu.click();
        } else {
          await page.evaluate(() => { window.noVersion = 'ref-two'; });
          await bar.getByRole('button',{name,exact:true}).click();
        }
        await dialog.getByRole('alert').getByText(trigger === 'menu' ? /待移动条目已不存在/ : /缺少文件版本/).waitFor();
        await confirm();
        assert.deepEqual(await page.evaluate(() => window.moveTasks.at(-1).ids), ['ref-one']);
        await checkOmissions(1);
      }
    } else {
      assert.ok(tasks.every(t => t.kind === 'moveoriginals'));
      assert.deepEqual(tasks.map(t => t.originals.map(o => o.asset_id)), [['root-0'],['root-0','root-1'],['root-0']]);
      assert.ok(tasks.flatMap(t => t.originals).every(o => o.fingerprint === 'frozen-'+o.asset_id && o.path.endsWith(o.asset_id+'.png')));
      if (view === 'project') assert.equal(await page.evaluate(() => window.catalogProject), 'test-project');
      await checkOmissions(2);
    }
    assert.deepEqual(errors, []);
    console.log('PASS', view, 'project and folder moves, directory and ZIP export, selection identity and partial receipts');
    await page.close();
  }
} catch (error) {
  console.error(error);
  throw error;
} finally { await browser.close(); await server.close(); }
