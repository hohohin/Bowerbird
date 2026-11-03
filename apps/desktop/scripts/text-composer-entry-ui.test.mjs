import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ cacheDir: '.tmp/text-composer-live-vite', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const coverage = process.env.BOWERBIRD_TEXT_COVERAGE === '1';
const coverageChunks = [];
if (coverage) await page.coverage.startJSCoverage({ resetOnNavigation: false });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/fixture/text-reference.png*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#698c91"/></svg>' }));
const button = name => page.getByRole('button', { name, exact: true });
const base = `${server.resolvedUrls.local[0]}scripts/fixtures/text-composer-live/preview.html`;
async function checkpointCoverage() {
  if (!coverage) return;
  coverageChunks.push(...await page.coverage.stopJSCoverage());
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
}
try {
  await page.goto(base);
  const composer = page.locator('.creation-dock .ProseMirror');
  await composer.fill('原始提示词');
  assert.equal(await button('放大编辑文本').count(), 1, 'shared CreationBoard must expose expand action');
    await button('放大编辑文本').click();
    const body = page.getByRole('textbox', { name: '文档正文', exact: true });
    await body.waitFor(); assert.match(await body.innerText(), /原始提示词/);
    await button('源码').click();
    const source = page.getByRole('textbox', { name: 'Markdown 源码', exact: true });
    const markdown = '# 新标题\n\n**保留加粗**\n\n- 第一镜\n- 第二镜\n\n<img data-bowerbird-asset="text-reference" data-caption="参考" />\n';
    await source.fill(markdown);
    await button('返回').click();
    assert.equal(await composer.innerText(), '原始提示词', 'return preserves original composer');
    await button('放大编辑文本').click(); await button('源码').click();
    assert.equal(await source.inputValue(), markdown, 'closed expanded draft restored');
    await button('返回').click();
    await page.evaluate(() => window.remountComposer());
    await composer.click();
    await button('放大编辑文本').click(); await button('源码').click();
    assert.equal(await source.inputValue(), markdown, 'remounted shared composer restores expanded draft');
    await button('添加到生成对话框').click(); await page.waitForFunction(() => !document.querySelector('.text-workspace'));
    assert.match(await composer.innerText(), /# 新标题/); assert.match(await composer.innerText(), /\*\*保留加粗\*\*/);
    assert.equal(await composer.locator('[data-type="image"], .board-chip-image').count() > 0 || await composer.locator('[data-asset-id]').count() > 0, true, 'real PM contains image reference');
    assert.equal(await page.evaluate(() => window.started.length), 0, 'explicit add never generates');
    await button('放大编辑文本').click(); await body.waitFor();
    assert.equal(await body.locator('h1').innerText(), '新标题'); assert.equal(await body.locator('strong').innerText(), '保留加粗'); assert.equal(await body.locator('figure').count(), 1, 'image round trip retains document media');
    await button('源码').click(); await source.fill(markdown + '\n慢请求\n');
    await page.evaluate(() => { window.slowTextRefs = true; });
    await button('添加到生成对话框').click(); await page.waitForFunction(() => !!window.releaseTextRefs);
    await button('返回').click();
    await page.evaluate(() => { window.slowTextRefs = false; window.releaseTextRefs(); });
    await page.waitForTimeout(160); assert.doesNotMatch(await composer.innerText(), /慢请求/, 'closing prevents delayed add');
    await button('放大编辑文本').click(); await button('源码').click();
    await source.fill('普通文字 @图片2 应保留。\n\n<img data-bowerbird-asset="alias-a" data-caption="" />\n\n<img data-bowerbird-asset="alias-b" data-caption="" />\n');
    await button('添加到生成对话框').click(); await page.waitForFunction(() => !document.querySelector('.text-workspace'));
    assert.match(await composer.innerText(), /普通文字 @图片2 应保留。/, 'ordinary alias-looking text remains literal');
    assert.deepEqual(await composer.locator('[data-asset-id]').evaluateAll(items => items.map(item => item.getAttribute('data-asset-id'))), ['alias-a', 'alias-b'], 'PM chips preserve identity and order without interpreting literal aliases');
    await button('放大编辑文本').click(); await button('源码').click();
    const aliasedRoundTrip = await source.inputValue();
    assert.deepEqual([...aliasedRoundTrip.matchAll(/data-bowerbird-asset="([^"]+)"/g)].map(match => match[1]), ['alias-a', 'alias-b'], 'real references preserve identity and order despite colliding asset names');
    assert.match(aliasedRoundTrip, /普通文字 @图片2 应保留。/);
    await button('返回').click();
    await composer.fill('存储恢复时的原文');
    await button('放大编辑文本').click(); await button('源码').click(); await source.fill('# 应恢复的缓存草稿\n'); await button('返回').click();
    const [draftKey, draftJson] = await page.evaluate(() => Object.entries(sessionStorage).find(([key, value]) => key.startsWith('bowerbird.text-workspace.') && value.includes('应恢复的缓存草稿')));
    const storedDraft = JSON.parse(draftJson);
    await page.waitForFunction(() => localStorage.getItem('bowerbird.libraryComposer.draft.v1')?.includes('存储恢复时的原文'));
    const invalidDrafts = [
      '{broken JSON',
      JSON.stringify(42),
      JSON.stringify({ markdown: '旧结构' }),
      JSON.stringify({ ...storedDraft, document: { title: 42, markdown: '错误字段' } }),
      JSON.stringify({ ...storedDraft, document: { title: '旧标题', markdown: 42 } }),
      JSON.stringify({ ...storedDraft, sourceDoc: 'stale composer' }),
    ];
    for (const cached of [...invalidDrafts, draftJson]) {
      await page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), { key: draftKey, value: cached });
      await checkpointCoverage(); await page.reload();
      await composer.waitFor(); await composer.click();
      assert.equal(await composer.innerText(), '存储恢复时的原文');
      await button('放大编辑文本').click(); await button('源码').click();
      assert.equal(await source.inputValue(), cached === draftJson ? '# 应恢复的缓存草稿\n' : '存储恢复时的原文', 'only a valid matching draft can replace the expanded document');
      await button('返回').click();
    }
    await checkpointCoverage();
    await page.goto(base + '?conversation');
    await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
    await page.evaluate(() => {
      window.sent = [];
      const job = { id: 'text-continue', projectId: 'p', threadId: 't', provider: 'jimeng', sessionId: 'session', conversationId: 'conversation', running: false, streaming: '', refAssets: [], lastRatio: '1:1', lastPrompt: '原始绘画', turns: [{ id: 1, prompt: '原始绘画', promptRaw: '原始绘画', images: [], provider: 'jimeng' }] };
      window.store.setState({ genJobs: { [job.id]: job }, genJobOrder: [job.id], activeJobId: job.id, activeSessionKind: 'generation', genPanelOpen: true, boardOpen: false, genEditing: null, activeGenProvider: 'codex', dreaminaHealth: { ok: true }, cloudEntitlement: { plan: 'pro', policy: { can_use_byo: true }, balances: { daily: 100, sub: 0, topup: 0 } }, sendGenRevise: async (...args) => { window.sent.push(args); } });
    });
    const inspector = page.locator('[data-project-inspector="generation"]');
    await inspector.getByRole('button', { name: /^继续对话/ }).click();
    const inline = inspector.locator('[data-generation-composer="inline"]');
    await inline.locator('.ProseMirror').fill('继续对话原文');
    await inline.getByRole('button', { name: '放大编辑文本', exact: true }).click(); await body.waitFor();
    await button('源码').click(); await source.fill('## 继续对话长文\n\n**强调镜头**\n');
    await button('添加到生成对话框').click(); await page.waitForFunction(() => !document.querySelector('.text-workspace'));
    assert.match(await inline.locator('.ProseMirror').innerText(), /## 继续对话长文/);
    assert.equal(await page.evaluate(() => window.sent.length), 0, 'continuation add never sends');
    await mkdir('.tmp/text-composer-live', { recursive: true }); await page.screenshot({ path: '.tmp/text-composer-live/continuation.png' });
    assert.deepEqual(errors, []);
    console.log('PASS shared CreationBoard and GenerationPanel: expand, PM/image/Markdown round trip, retained draft, late cancellation, no automatic generation');
} catch (error) { await mkdir('.tmp/text-composer-live', { recursive: true }); await page.screenshot({ path: '.tmp/text-composer-live/failure.png' }); console.error({ errors, calls: await page.evaluate(() => window.textCalls?.slice(-5)) }); throw error; }
finally {
  if (coverage) {
    const entries = [...coverageChunks, ...await page.coverage.stopJSCoverage()].filter(entry => /\/src\/(?:components\/(?:TextWorkspace|TextPlateEditor|useTextWorkspace)\.tsx|lib\/(?:textWorkspaceSave|documentComposer)\.ts)(?:\?|$)/.test(entry.url));
    await mkdir('../../.tmp/text-workspace-implementation/quality-editor', { recursive: true });
    await writeFile('../../.tmp/text-workspace-implementation/quality-editor/composer-v8.json', JSON.stringify(entries));
  }
  await browser.close(); await server.close();
}
