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
  await tooltip.getByText('暂无反推数据', { exact: true }).first().waitFor();
  assert.match(await tooltip.innerText(), /暂无反推数据/);
  assert.doesNotMatch(await tooltip.innerText(), /旧记录|不应当作为反推|当前手动编辑/);
  await page.screenshot({ path: '.tmp/workflow/describe-existing.png' });
  await page.mouse.move(1500, 900);
  await page.evaluate(() => window.c.start('describe', true));
  assert.deepEqual(await page.evaluate(() => window.describeCalls), ['existing', 'a']);
  assert.equal(await page.evaluate(() => window.c.document.run.status), 'done');
  assert.equal(await card.getByRole('button', { name: /^输出：/ }).count(), 1);
  await card.getByRole('button', { name: '输出：提示词', exact: true }).waitFor();
  assert.match(await page.evaluate(() => window.c.document.nodes[0].outputs.text.text), /新反推 existing[\s\S]*新反推 a/);
  assert.equal(await page.evaluate(() => window.c.document.run.steps.describe.describeJobIds.length), 2);

  // All-cached inputs work without an available inference engine.
  await page.evaluate(async () => { const { useStore } = await import('/src/store.ts'); useStore.setState({ defaultUnderstandProvider: 'auto', cloudEntitlement: null }); await window.c.start('describe', true); });
  assert.equal(await page.evaluate(() => window.c.document.run.status), 'done');
  assert.deepEqual(await page.evaluate(() => window.describeCalls), ['existing', 'a']);
  await checkbox.check();
  await page.evaluate(async () => { const { useStore } = await import('/src/store.ts'); useStore.setState({ defaultUnderstandProvider: 'codex' }); await window.c.start('describe', true); });
  assert.deepEqual(await page.evaluate(() => window.describeCalls), ['existing', 'a', 'existing', 'a']);
  assert.doesNotMatch(await page.evaluate(() => window.c.document.nodes[0].outputs.text.text), /当前手动编辑/);
  await card.getByRole('button', { name: '查看已有反推' }).hover();
  await tooltip.getByText('构图：新反推 existing').waitFor();
  await page.reload(); await checkbox.waitFor();
  assert.equal(await checkbox.isChecked(), true);
  await checkbox.uncheck();
  // A persisted card remains usable even if image history is deleted or unavailable.
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { useStore } = await import('/src/store.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    api.listAnalysesByAsset = async () => { throw Error('must not read image history for cache'); };
    api.describeAsset = async () => { throw Error('must not submit cached card'); };
    useStore.setState({ defaultUnderstandProvider: 'auto', cloudEntitlement: null });
    await c.start('describe', true);
    if (c.document.run.status !== 'done') throw Error('persisted cache was not reused');
  });
  await card.getByRole('button', { name: '查看已有反推' }).hover();
  await tooltip.getByText('构图：新反推 existing').waitFor();
  await page.mouse.move(1500, 900);

  const isolated = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { useStore } = await import('/src/store.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode, invalidateWorkflow } = await import('/src/lib/canvasWorkflow.ts');
    const { captureCanvasClipboard, cloneCanvasClipboard } = await import('/src/lib/canvasClipboard.ts');
    const c = canvasWorkflowController('p');
    const check = (condition, message) => { if (!condition) throw Error(message); };
    const calls = [], records = { existing: [{ id: 'historic', kind: 'caption', payload: JSON.stringify({ text: '图片原有历史' }) }] };
    api.listAnalysesByAsset = async id => records[id] ?? [];
    let releaseFirst;
    api.describeAsset = async (assetId, instruction, provider, jobId) => {
      check(Object.values(c.document.run.steps).some(step => step.describeJobIds?.includes(jobId)), 'task identity persisted');
      calls.push({ assetId, instruction });
      // Both cards must start before the first one completes; B finishes first.
      if (calls.length === 1) await new Promise(resolve => { releaseFirst = resolve; });
      else if (calls.length === 2) releaseFirst();
      const record = { id: jobId, kind: 'caption', payload: JSON.stringify({ sections: [{ title: '结果', body: instruction + ':' + assetId }] }) };
      records[assetId] = [record, ...(records[assetId] ?? [])]; return jobId;
    };
    useStore.setState({ defaultUnderstandProvider: 'codex' });
    const trigger = { ...newWorkflowNode('trigger', 0, 0, ''), id: 'trigger' };
    const card = (id, prompt, x) => ({ ...newWorkflowNode('instruction', x, 60, 'codex'), id, prompt,
      inputs: { image: [{ assetId: 'existing' }], signal: [{ nodeId: 'trigger', portId: 'signal' }] } });
    await c.edit([trigger, card('first', '提取构图', 400), card('second', '提取色彩', 800)]);
    await c.start('trigger');
    check(c.document.run.status === 'done' && calls.length === 2, 'new cards must each submit despite image history');
    const first = () => c.document.nodes.find(node => node.id === 'first');
    const second = () => c.document.nodes.find(node => node.id === 'second');
    check(first().outputs.text.text === '结果：提取构图:existing', 'first card has its own result');
    check(second().outputs.text.text === '结果：提取色彩:existing', 'second card has its own result');
    check(records.existing.length === 3 && records.existing.some(record => record.id === 'historic'), 'image history retained and appended');
    records.existing = [{ id: 'external', kind: 'caption', payload: JSON.stringify({ text: '外部反推' }) }];
    await c.start('trigger');
    check(calls.length === 2 && first().outputs.text.text.includes('提取构图') && second().outputs.text.text.includes('提取色彩'), 'reruns remain independent of image latest');

    // A newly added image submits once; old images retain the card's own result.
    await c.edit(invalidateWorkflow(c.document.nodes.map(node => node.id === 'first' ? { ...node, inputs: { ...node.inputs, image: [{ assetId: 'a' }, { assetId: 'existing' }] } } : node), 'first'));
    await c.start('first', true);
    check(calls.length === 3 && calls[2].assetId === 'a', 'mixed batch submits missing card cache only');
    check(first().outputs.text.text.indexOf('提取构图:a') < first().outputs.text.text.indexOf('提取构图:existing'), 'results follow current input order');

    await c.edit(invalidateWorkflow(c.document.nodes.map(node => node.id === 'first' ? { ...node, prompt: '提取文字' } : node), 'first'));
    await c.start('first', true);
    check(calls.length === 5 && first().outputs.text.text.includes('提取文字') && !first().outputs.text.text.includes('提取构图'), 'changed instruction submits all inputs');
    check(second().outputs.text.text === '结果：提取色彩:existing', 'other card output unchanged');
    await c.edit(c.document.nodes.map(node => node.id === 'first' ? { ...node, inputs: { ...node.inputs, image: [{ assetId: 'a' }] } } : node));
    await c.start('first', true);
    check(calls.length === 5 && !first().outputs.text.text.includes('existing'), 'removed image cannot leak into output');

    const saved = JSON.stringify(first().describeCache);
    await c.edit(c.document.nodes.map(node => node.id === 'first' ? { ...node, overwriteDescribe: true } : node));
    api.describeAsset = async () => { throw Error('mock provider failure'); };
    await c.start('first', true);
    check(c.document.run.status === 'failed' && JSON.stringify(first().describeCache) === saved, 'failed overwrite retains prior card data');
    await c.edit(c.document.nodes.map(node => node.id === 'first' ? { ...node, overwriteDescribe: false } : node));
    await c.start('first', true);
    check(c.document.run.status === 'done' && JSON.stringify(first().describeCache) === saved, 'retry can reuse retained data');
    const clipboard = captureCanvasClipboard('p', new Set(['first']), [], [], [], c.document.nodes);
    check(!cloneCanvasClipboard(clipboard, 'p', 0, 0).workflow[0].describeCache, 'new copied card does not inherit runtime cache');
    return calls;
  });
  assert.equal(isolated.length, 5);

  const parsed = await page.evaluate(async () => {
    const { workflowCaptionSections } = await import('/src/lib/workflowDescribe.ts');
    return [workflowCaptionSections('{bad'), workflowCaptionSections(JSON.stringify({ sections: [{ title: 'bad', body: 4 }] })), workflowCaptionSections(JSON.stringify({ text: '旧版完整正文\n第二行' }))];
  });
  assert.deepEqual(parsed, [[], [], [{ title: '提示词', body: '旧版完整正文\n第二行' }]]);
  console.log('describe cache: image history ignored, per-card parallel isolation, mixed inputs, instruction changes, offline/reload reuse, overwrite/failure, clipboard isolation, preview and payload compatibility passed');
} finally { await browser.close(); await server.close(); }
