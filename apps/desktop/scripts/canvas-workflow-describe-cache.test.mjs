import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1592, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
try {
  await page.goto('http://127.0.0.1:1592/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => { const s = window.snapshot(); s.nodes = s.nodes.filter(n => n.id !== 'far'); sessionStorage.setItem('reference-fixture', JSON.stringify(s)); });
  await page.reload(); await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { useStore } = await import('/src/store.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    window.describeCalls = []; window.records = { existing: [
      { id: 'unrelated', kind: 'keywords', payload: JSON.stringify({ sections: [{ title: '标签', body: '不应当作为反推' }] }) },
      { id: 'latest', kind: 'caption', payload: JSON.stringify({ sections: [{ title: '构图', body: '当前手动编辑的内容' }] }) },
      { id: 'older', kind: 'caption', payload: JSON.stringify({ text: '旧记录' }) },
    ] };
    api.listAnalysesByAsset = async id => window.records[id] ?? [];
    api.describeAsset = async (id, prompt, provider, jobId) => {
      const c = canvasWorkflowController('p');
      if (!c.document.run.steps.describe.describeJobIds.includes(jobId)) throw new Error('missing saved job identity');
      window.describeCalls.push(id);
      const analysis = { id: 'fresh-' + id, kind: 'caption', payload: JSON.stringify({ sections: [{ title: '构图', body: '新反推 ' + id }] }) };
      window.records[id] = [analysis, ...(window.records[id] ?? [])]; return analysis.id;
    };
    useStore.setState({ defaultUnderstandProvider: 'codex' });
    const c = canvasWorkflowController('p'); await c.load();
    await c.edit([{ ...newWorkflowNode('instruction', 400, 60, 'codex'), id: 'describe', action: 'describe', inputs: { image: [{ assetId: 'existing' }, { assetId: 'a' }] } }]);
    window.c = c;
  });
  const card = page.locator('[data-workflow-card="describe"]');
  const checkbox = card.getByRole('checkbox', { name: '覆盖已有反推' });
  assert.equal(await checkbox.isChecked(), false);
  await page.getByRole('button', { name: '适应内容', exact: true }).click();
  await card.getByRole('button', { name: '查看已有反推' }).hover();
  const tooltip = page.getByRole('tooltip', { name: '已有反推数据' });
  await tooltip.getByText('构图：当前手动编辑的内容').waitFor();
  assert.match(await tooltip.innerText(), /暂无反推数据/);
  assert.doesNotMatch(await tooltip.innerText(), /旧记录|不应当作为反推/);
  await page.screenshot({ path: '.tmp/workflow/describe-existing.png' });
  await page.mouse.move(1500, 900);
  await page.evaluate(() => window.c.start('describe', true));
  assert.deepEqual(await page.evaluate(() => window.describeCalls), ['a']);
  assert.equal(await page.evaluate(() => window.c.document.run.status), 'done');
  assert.equal(await card.getByRole('button', { name: /^输出：/ }).count(), 1);
  await card.getByRole('button', { name: '输出：提示词', exact: true }).waitFor();
  assert.match(await page.evaluate(() => window.c.document.nodes[0].outputs.text.text), /当前手动编辑的内容[\s\S]*新反推 a/);
  assert.equal(await page.evaluate(() => window.c.document.run.steps.describe.describeJobIds.length), 1);

  // All-cached inputs work without an available inference engine.
  await page.evaluate(async () => { const { useStore } = await import('/src/store.ts'); useStore.setState({ defaultUnderstandProvider: 'auto', cloudEntitlement: null }); await window.c.start('describe', true); });
  assert.equal(await page.evaluate(() => window.c.document.run.status), 'done');
  assert.deepEqual(await page.evaluate(() => window.describeCalls), ['a']);
  await checkbox.check();
  await page.evaluate(async () => { const { useStore } = await import('/src/store.ts'); useStore.setState({ defaultUnderstandProvider: 'codex' }); await window.c.start('describe', true); });
  assert.deepEqual(await page.evaluate(() => window.describeCalls), ['a', 'existing', 'a']);
  assert.doesNotMatch(await page.evaluate(() => window.c.document.nodes[0].outputs.text.text), /当前手动编辑/);
  await card.getByRole('button', { name: '查看已有反推' }).hover();
  await tooltip.getByText('构图：新反推 existing').waitFor();
  await page.reload(); await checkbox.waitFor();
  assert.equal(await checkbox.isChecked(), true);

  const parsed = await page.evaluate(async () => {
    const { workflowCaptionSections } = await import('/src/lib/workflowDescribe.ts');
    return [workflowCaptionSections('{bad'), workflowCaptionSections(JSON.stringify({ sections: [{ title: 'bad', body: 4 }] })), workflowCaptionSections(JSON.stringify({ text: '旧版完整正文\n第二行' }))];
  });
  assert.deepEqual(parsed, [[], [], [{ title: '提示词', body: '旧版完整正文\n第二行' }]]);
  console.log('describe cache: default reuse, mixed batch, offline reuse, explicit overwrite, latest caption selection, hover/refresh, persistence and legacy/malformed payloads passed');
} finally { await browser.close(); await server.close(); }
