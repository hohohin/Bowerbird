import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 1561, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
const step = n => page.waitForFunction(n => window.lesson.getState().progress.step === n, n);
async function checkDialogAvoidance(selector) {
  for (const entry of ['测试登录入口', '测试设置入口']) {
    await page.getByRole('button', { name: entry, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await page.locator(selector).waitFor({ state: 'hidden' });
    const close = dialog.getByRole('button', { name: '关闭', exact: true }).first();
    assert.equal(await close.evaluate(button => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true);
    await close.click();
    await page.locator(selector).waitFor();
  }
}
try {
  await page.goto('http://127.0.0.1:1561/scripts/fixtures/onboarding/preview.html');
  await page.getByRole('button', { name: '跟着示例做一次', exact: true }).waitFor();
  await page.getByRole('button', {name:'学习集合与视觉规范',exact:true}).click();
  const collectionGuide = page.getByRole('dialog');
  await collectionGuide.getByText('3. 从一组参考提炼视觉规范', {exact:true}).waitFor();
  assert.equal(await collectionGuide.getByRole('option', {name:'收藏夹不属于集合'}).count(), 0);
  await page.getByLabel('创建你的第一个集合').fill('春季品牌参考');
  await page.evaluate(() => { window.failCollection = true; });
  await page.getByRole('button', {name:'创建并打开集合',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'模拟集合创建失败'}).waitFor();
  await page.evaluate(() => { window.failCollection = false; window.failFolders = true; });
  await page.getByRole('button', {name:'创建并打开集合',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'模拟集合列表加载失败'}).waitFor();
  await page.evaluate(() => { window.failFolders = false; });
  await page.getByRole('button', {name:'打开所选集合',exact:true}).click();
  await page.getByText('这个集合还没有素材', {exact:true}).waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'create_folder').length), 2);
  const inlineGuide = page.locator('.collection-learning');
  assert.equal(await inlineGuide.getAttribute('open'), '');
  await inlineGuide.locator('summary').click();
  await page.waitForFunction(() => window.lesson.getState().progress.dismissed.includes('collections'));
  await inlineGuide.locator('summary').click();
  await page.waitForFunction(() => !window.lesson.getState().progress.dismissed.includes('collections'));
  await mkdir('.tmp', {recursive:true});
  await page.screenshot({path:'.tmp/onboarding-collection.png',animations:'disabled'});
  await page.getByRole('button', {name:'关闭',exact:true}).click();
  await page.evaluate(() => window.lesson.getState().open());
  await page.getByRole('button', {name:'学习集合与视觉规范',exact:true}).click();
  await page.getByLabel('也可以使用已有集合').selectOption('existing-folder');
  await page.getByRole('button', {name:'打开所选集合',exact:true}).click();
  await page.getByText('已有品牌集合', {exact:true}).waitFor();
  await page.getByRole('button', {name:'关闭',exact:true}).click();
  await page.evaluate(() => window.lesson.getState().open());
  await page.evaluate(() => { window.failSample = true; });
  await page.getByRole('button', { name: '跟着示例做一次', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '模拟示例缺失' }).waitFor();
  await page.evaluate(() => { window.failSample = false; });
  await page.getByRole('button', { name: '跟着示例做一次', exact: true }).click();
  await page.getByRole('complementary', { name: '入门任务清单' }).waitFor();
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  assert.equal(await page.evaluate(() => window.lesson.getState().progress.step), 1);
  await checkDialogAvoidance('.onboarding-lesson');
  // Real native HTML drag from the real MasonryGrid to the real canvas.
  await page.locator('.canvas-source-panel [data-asset-id="existing"]').dragTo(page.locator('[data-canvas-stage]'), { targetPosition: { x: 180, y: 180 } });
  await step(2);
  const card = page.locator('.canvas-node.is-asset').first();
  await card.focus(); await card.press('ArrowRight'); await step(3);
  const editor = page.locator('[data-onboarding-composer] .ProseMirror');
  await editor.fill('为这款产品制作宣传图，保留产品外观。');
  await card.click();
  await step(4);
  await page.locator('[data-dim="色调"]').focus();
  await page.locator('[data-dim="色调"]').press('Enter');
  await step(5);
  assert.equal(await editor.locator('[data-keyword]').count(), 1);
  assert.equal(await page.evaluate(() => window.calls.some(call => /codex_create_image|cloud_agent_start/.test(call.command))), false);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '先完成准备，稍后生成' }).click();
  await page.getByText('你已学会准备一次创作', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.lesson.getState().progress.status), 'paused');
  await page.getByRole('button', { name: '继续使用', exact: true }).click();
  await checkDialogAvoidance('.onboarding-resume');
  const pausedProgress = await page.evaluate(() => window.lesson.getState().progress);
  await page.getByRole('button', { name: '跳过入门引导', exact: true }).click();
  await page.locator('.onboarding-resume').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.lesson.getState().progress.status), 'skipped');
  await page.evaluate(() => window.persistLesson());
  await page.reload();
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  assert.equal(await page.locator('.onboarding-resume, .onboarding-lesson').count(), 0);
  assert.equal(await page.evaluate(() => window.lesson.getState().progress.projectId), pausedProgress.projectId);
  assert.equal(await page.evaluate(() => window.lesson.getState().progress.step), pausedProgress.step);
  await page.getByRole('button', { name: '测试设置入口', exact: true }).click();
  await page.getByRole('button', { name: '打开入门引导', exact: true }).click();
  await page.getByRole('button', { name: '继续上次进度 · 5/5' }).click();
  await step(5);
  assert.ok((await editor.textContent()).includes('制作宣传图'));
  const id = await page.evaluate(() => window.lesson.getState().progress.projectId);
  // Synthetic provider events only: failure and unrelated work do not pass.
  await page.evaluate(id => {
    const job = { id:'unrelated', projectId:'elsewhere', createdAt:Date.now(), running:false, turns:[{ images:['result'] }] };
    window.store.setState({ genJobs:{ unrelated:job } });
  }, id);
  await page.waitForTimeout(650); assert.equal(await page.evaluate(() => window.lesson.getState().progress.step), 5);
  await page.evaluate(id => {
    window.store.setState({ genJobs:{ lessonJob: { id:'lessonJob', projectId:id, createdAt:Date.now(), running:false,
      provider:'jimeng', sessionId:'session', threadId:'t', refAssets:[], lastRefs:[], lastPrompt:'宣传图', lastRatio:null, streaming:'',
      turns:[{ id:'turn', prompt:'宣传图', images:[], error:'模拟失败' }] } } });
  }, id);
  await page.getByText('尚未取得生成结果。请查看任务提示，重试后继续。').waitFor();
  await page.evaluate(() => {
    const job=window.store.getState().genJobs.lessonJob;
    window.store.setState({ genJobs:{ lessonJob:{...job,turns:[{...job.turns[0],error:null,images:['data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E']}] } } });
  });
  await page.waitForTimeout(650);
  assert.equal(await page.evaluate(() => window.lesson.getState().progress.step), 5);
  assert.equal(await page.getByText('从结果继续修改', {exact:true}).count(), 0);
  await page.getByRole('button', { name:'完成入门引导',exact:true }).click();
  await page.getByText('第一条创作路径已完成', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.lesson.getState().progress.outcome), 'generated');
  await mkdir('.tmp', {recursive:true});
  await page.waitForTimeout(300);
  await page.screenshot({path:'.tmp/onboarding-complete.png'});
  await page.getByRole('button', { name:'继续使用',exact:true }).click();
  await page.evaluate(() => window.lesson.getState().show('update'));
  await page.getByRole('button',{name:'知道了',exact:true}).click();
  assert.equal(await page.evaluate(() => window.lesson.getState().progress.updateSeen),true);
  await page.evaluate(() => window.lesson.getState().open());
  await page.setViewportSize({width:1000,height:720});
  await page.waitForTimeout(300);
  await page.screenshot({path:'.tmp/onboarding-welcome.png'});
  await page.getByRole('button', { name: '跳过入门引导', exact: true }).click();
  assert.equal(await page.evaluate(() => window.lesson.getState().progress.status), 'completed');
  await page.evaluate(() => {
    window.missingProject = true;
    window.lesson.getState().patch({status:'paused', step:5, jobId:null, startedAt:Date.now()+1000});
    window.lesson.getState().open();
  });
  await page.getByRole('button', { name: '继续上次进度 · 5/5' }).click();
  await page.getByRole('alert').filter({hasText:'原引导项目已不存在'}).waitFor();
  assert.equal(await page.evaluate(() => window.lesson.getState().progress.status), 'paused');
  await page.evaluate(() => { window.missingProject = false; });
  await page.getByRole('button', { name: '继续上次进度 · 5/5' }).click();
  await page.getByRole('complementary', { name: '入门任务清单' }).waitFor();
  await page.evaluate(() => { window.failSave = true; });
  await editor.fill('这条草稿保存失败时应保留教程');
  await page.getByRole('button', {name:'暂停入门引导',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'草稿尚未保存'}).waitFor();
  assert.equal(await page.evaluate(() => window.lesson.getState().progress.status), 'active');
  const draftBeforeSkip = await editor.textContent();
  await page.getByRole('button', { name: '收起入门引导', exact: true }).click();
  await page.getByRole('button', { name: '跳过入门引导', exact: true }).click();
  await page.locator('.onboarding-lesson').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.onboarding-resume').count(), 0);
  assert.equal(await page.evaluate(() => window.lesson.getState().progress.status), 'skipped');
  assert.equal(await editor.textContent(), draftBeforeSkip);
  await page.evaluate(() => window.lesson.getState().open());
  await page.getByRole('button', { name: '跳过入门引导', exact: true }).click();
  assert.equal(await page.locator('.onboarding-resume, .onboarding-lesson').count(), 0);
  // A pending pause must not restore a reminder after the user skips.
  await page.evaluate(() => {
    window.store.setState({ projectCanvasFlush: () => new Promise(resolve => { window.releasePause = resolve; }) });
    window.lesson.getState().patch({ status: 'active' });
    window.lesson.getState().show('lesson');
  });
  await page.getByRole('button', { name: '暂停入门引导', exact: true }).click();
  await page.getByRole('button', { name: '跳过入门引导', exact: true }).click();
  await page.evaluate(async () => { window.releasePause(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.equal(await page.evaluate(() => window.lesson.getState().progress.status), 'skipped');
  assert.equal(await page.locator('.onboarding-resume, .onboarding-lesson').count(), 0);
  await page.evaluate(() => window.lesson.getState().open());
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await page.locator('.onboarding-resume, .onboarding-lesson').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS onboarding: login/settings avoidance for active and paused help, dismissible reminder, persisted skip and settings resume, minimized skip despite save failure with draft retained; collection create/open, retry without duplicate, inline learning toggle, real canvas/editor actions, preparation, generation completion, completed status, missing project, save failure.');
} catch (error) {
  await mkdir('.tmp', {recursive:true});
  await page.screenshot({path:'.tmp/onboarding-failure.png'});
  console.error(await page.evaluate(() => ({ lesson:window.lesson.getState(), text:document.body.innerText.slice(-4000), calls:window.calls.slice(-12) })));
  console.error(errors);
  throw error;
} finally { await browser.close(); await server.close(); }
