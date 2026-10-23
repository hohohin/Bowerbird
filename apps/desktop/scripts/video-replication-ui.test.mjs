import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
await mkdir('.tmp/video-replication', { recursive: true });
const server = await createServer({ cacheDir: '.tmp/video-replication/vite', server: { host:'127.0.0.1', port:1658, strictPort:true, hmr:false, watch:null } });
await server.listen();
const browser = await chromium.launch({ channel:'chrome', headless:true });
const page = await browser.newPage({ viewport:{ width:1440,height:1000 } });
const errors=[];page.on('pageerror',error=>errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && /same key|Maximum update depth/.test(message.text())) errors.push(message.text()); });
const base='http://127.0.0.1:1658/scripts/fixtures/video-replication/preview.html';
const box=()=>page.getByRole('button',{name:'工具箱',exact:true});
try {
  await page.goto(base);
  await box().click();
  const articleTool = () => page.getByRole('menuitem',{name:/视频转图文/});
  const localImageTool = () => page.getByRole('menuitem',{name:/本地 H3 视频/});
  assert.equal(await articleTool().count(),0,'logged out hides video-to-article');
  assert.equal(await localImageTool().count(),0,'logged out hides local image generation');
  await page.evaluate(() => window.store.setState({ cloudAuth:{logged_in:true,user_id:'tester'}, cloudEntitlement:{user_id:'tester',is_test_account:false} }));
  assert.equal(await articleTool().count(),0,'ordinary accounts hide video-to-article');
  assert.equal(await localImageTool().count(),0,'ordinary accounts hide local image generation');
  for (const tier of ['pro','studio']) {
    for (const offline_state of ['fresh','grace']) {
      await page.evaluate(({tier,offline_state}) => window.store.setState({cloudEntitlement:{user_id:'tester',tier,offline_state,is_test_account:false}}), {tier,offline_state});
      await localImageTool().waitFor();
      assert.equal(await articleTool().count(),0,'paid entitlement does not unlock video-to-article');
    }
  }
  for (const offline_state of ['expired','invalid',null]) {
    await page.evaluate(offline_state => window.store.setState({cloudEntitlement:{user_id:'tester',tier:'pro',offline_state,is_test_account:false}}), offline_state);
    await localImageTool().waitFor({state:'detached'});
  }
  await page.evaluate(() => window.store.setState({cloudEntitlement:{user_id:'other',tier:'pro',offline_state:'fresh',is_test_account:false}}));
  assert.equal(await localImageTool().count(),0,'mismatched paid entitlement stays hidden');
  await page.evaluate(() => window.store.setState({cloudAuth:{logged_in:false,user_id:'tester'},cloudEntitlement:{user_id:'tester',tier:'pro',offline_state:'fresh',is_test_account:false}}));
  assert.equal(await localImageTool().count(),0,'paid entitlement after logout stays hidden');
  await page.evaluate(() => {
    window.notices=[]; window.localPlacements=0; window.addEventListener('local-video-placement',()=>window.localPlacements++);
    window.addEventListener('bowerbird://notify',event=>window.notices.push(event.detail.message));
    window.store.setState({cloudAuth:{logged_in:true,user_id:'tester'},cloudEntitlement:{user_id:'tester',tier:'free',offline_state:'fresh',is_test_account:true}});
  });
  await articleTool().waitFor();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['视频复刻工具分析参考 · 改写分镜 · 生成视频','视频转图文功能开发中','本地 H3 视频首尾帧 · 提示词 · 生成视频']);
  await page.keyboard.press('ArrowDown');
  assert.equal(await articleTool().evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>window.notices),['功能开发中']);
  await box().click();
  await page.keyboard.press('Home');
  assert.equal(await page.getByRole('menuitem').first().evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('End');
  assert.equal(await localImageTool().evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>window.notices),['功能开发中']);
  assert.equal(await page.evaluate(()=>window.localPlacements),1);
  assert.equal(await page.evaluate(()=>window.calls.length),0,'placeholder does not call a model or IPC');
  await box().click();
  await page.evaluate(()=>window.store.setState({cloudAuth:{logged_in:true,user_id:'other'}}));
  await articleTool().waitFor({state:'detached'});
  await localImageTool().waitFor({state:'detached'});
  await page.evaluate(()=>window.store.setState({cloudAuth:{logged_in:false,user_id:'tester'}}));
  assert.equal(await articleTool().count(),0,'stale test entitlement after logout stays hidden');
  assert.equal(await localImageTool().count(),0,'stale test entitlement after logout hides local image generation');
  assert.deepEqual(errors,[]);
  console.log('PASS toolbox Pro/Studio/test access, expired/mismatched/logged-out denial and keyboard/menu');

} finally { await browser.close(); await server.close(); }
if (!process.argv.includes('--toolbox-only')) await import('./video-replication-workbench-ui.test.mjs');
