import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1618, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
try {
  await page.goto('http://127.0.0.1:1618/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => { const snapshot = window.snapshot(); snapshot.nodes = snapshot.nodes.filter(node => node.id !== 'far'); sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot)); });
  await page.reload(); await page.locator('[data-canvas-node-id="old"]').waitFor();
  const result = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController, CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasContentInput } = await import('/src/lib/canvasContentInput.ts');
    const { agentResultValue } = await import('/src/lib/workflowAgentResult.ts');
    const { emptyCanvasCell } = await import('/src/lib/canvasNotes.ts');
    const { useStore } = await import('/src/store.ts');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const table = { format: 'bowerbird-table', title: '主框架', columns: ['屏次', '模块', '文案'], rows: [['1', '写螺', '紫心宝螺，天然釉光如珀。'], ['2', '挑一', '万贝过眼，只取一枚好紫。']] };
    let answer = JSON.stringify(table), submissions = 0, delivered = true;
    api.agentDsWorkflowStart = async () => { submissions++; return { autoDelivered: delivered, path: 'isolated' }; };
    api.agentDsWorkflowResult = async requestId => ({ schemaVersion: 1, requestId, text: answer });
    useStore.setState({ cloudAuth: null, cloudEntitlement: null });
    const c = canvasWorkflowController('p'); await c.load();
    const agent = { ...newWorkflowNode('agent', 20, 600, ''), id: 'table-agent', prompt: '返回主框架表格' };
    await c.edit([agent]); await c.start(agent.id, true);
    check(c.document.run.status === 'done', JSON.stringify(c.issue));
    const tableId = c.document.nodes[0].resultNodeIds[0];
    const read = id => JSON.parse(window.snapshot().nodes.find(n => n.id === id).payloadJson);
    const initial = read(tableId), ids = initial.cells.map(row => row.map(cell => cell.id));
    check(initial.cells.length === 3 && initial.cells[0].length === 3 && initial.cells[0].every(cell => cell.bold), 'real grid with bold headers');
    check(initial.cells[2][2].text === table.rows[1][2], 'cell text is exact');
    check(c.document.nodes[0].outputs.text.table.rows.length === 2, 'structured output persists alongside text fallback');

    const input = { canvasNodeId: tableId, cellId: ids[1][2] };
    const gen = { ...newWorkflowNode('generation', 1600, 600, 'codex'), id: 'table-consumer', prompt: '@[copy]', inputs: { text: [input] }, promptReferences: [{ id: 'copy', type: 'text', input, label: '主标题' }] };
    let generated = 0, expected = '新的单格文案';
    useStore.setState({ startGeneration: async (...args) => {
      generated++; check(args[0] === expected, 'consumer reads this run’s cell, not stale text');
      const identity = args[12]; useStore.setState(s => ({ genJobs: { ...s.genJobs, [identity.jobId]: { turns: [{ turnKey: identity.turnKey, images: ['existing.png'] }] } } }));
      return { accepted: true };
    } });
    api.localAgentFindAssetId = async () => 'existing';
    answer = JSON.stringify({ ...table, rows: [['1', '写螺', expected]] });
    await c.edit([...c.document.nodes, gen]); await c.start(agent.id);
    check(c.document.run.status === 'done' && generated === 1, JSON.stringify(c.issue));
    check(JSON.stringify(read(tableId).cells.map(row => row.map(cell => cell.id))) === JSON.stringify(ids), 'rerun preserves cell identity');
    check(read(tableId).cells[2].every(cell => cell.text === ''), 'shrinking output clears stale owned values');
    check(window.snapshot().nodes.filter(n => n.id.startsWith('workflow-agent:')).length === 1, 'rerun does not duplicate result cards');

    delivered = false; answer = JSON.stringify(table);
    await c.start(agent.id, true);
    check(c.document.run.status === 'waiting', 'undelivered request is recoverable');
    const count = submissions;
    const recovered = new CanvasWorkflowController('p'); await recovered.load(); await recovered.continue();
    check(recovered.document.run.status === 'done' && submissions === count, 'recovery queries original request');
    check(read(tableId).cells[2][2].text === table.rows[1][2], 'recovery writes same result card');
    // Use this controller after recovery to avoid a deliberately stale revision.
    delivered = true;
    const base = window.snapshot().nodes[0];
    const cell = (id, text) => ({ ...emptyCanvasCell(), id, text });
    for (const [id, cells] of [['target-table', [[cell('keep', '手写内容'), cell('neighbor', '不覆盖')]]], ['target-cell', [[cell('single', ''), cell('adjacent', '相邻保留')]]]]) {
      await api.projectCanvasNodeCreate({ ...base, id, kind: 'note', assetId: null, role: null, payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', member_ids: [], text: '', cells }) });
    }
    const source = { nodeId: agent.id, portId: 'text' };
    await recovered.bindTextInput('target-table', undefined, source, 'text');
    await recovered.bindTextInput('target-cell', 'single', source, 'text');
    let connected = read('target-table');
    check(connected.cells.length === 4 && connected.cells[1][0].text === '屏次' && connected.cells[3][2].text === table.rows[1][2], 'whole-card input expands into actual rows');
    check(connected.cells[0][0].text === '手写内容' && connected.cells[0][1].text === '不覆盖', 'other rows are preserved');
    check(read('target-cell').cells[0][0].text.includes('万贝过眼') && read('target-cell').cells[0][1].text === '相邻保留', 'explicit single-cell connection stays text');
    const writer = recovered.document.nodes.find(n => n.textTarget?.nodeId === 'target-table');
    const writerIds = [...writer.textTarget.cellIds];
    expected = table.rows[0][2];
    answer = JSON.stringify({ ...table, rows: [...table.rows, ['3', '无双', '每一枚紫，都有自己的深浅。']] });
    await recovered.start(agent.id);
    check(recovered.document.run.status === 'done', JSON.stringify(recovered.issue));
    connected = read('target-table');
    check(connected.cells.length === 8 && writerIds.every(id => connected.cells.flat().some(cell => cell.id === id)), 'new table appends while preserving the previous block');
    answer = '普通文字回答'; await recovered.start(agent.id, true);
    connected = read('target-table');
    check(connected.cells.length === 9 && connected.cells[8][0].text === answer && connected.cells[1][0].text === '屏次' && connected.cells[4][0].text === '屏次', 'text after tables appends and preserves both earlier tables');

    // Pure grid boundaries: occupied cells, another writer, and removed cells cannot be stolen.
    const note = { schema_version: 1, note_type: 'text', member_ids: [], text: '', cells: [[cell('root', ''), cell('occupied', 'keep')]] };
    const target = { nodeId: 'n', cellId: 'root', append: true };
    let rejected = 0;
    for (const [n, t, reserved] of [[note, target, []], [{ ...note, cells: [[cell('root', ''), cell('reserved', '')]] }, target, ['reserved']], [note, { ...target, cellIds: ['root', 'gone'], tableCellIds: [['root', 'gone']] }, []]]) {
      try { canvasContentInput(n, t, agentResultValue(JSON.stringify(table)), reserved); } catch { rejected++; }
    }
    check(rejected === 3 && note.cells[0][1].text === 'keep', 'unsafe writes reject without mutating original note');

    const stopped = new CanvasWorkflowController('table-stop'); await stopped.load();
    await stopped.edit([{ ...agent, id: 'stopped-agent' }]);
    let release;
    api.agentDsWorkflowResult = requestId => new Promise(resolve => { release = () => resolve({ schemaVersion: 1, requestId, text: JSON.stringify(table) }); });
    const running = stopped.start('stopped-agent', true);
    while (!release) await new Promise(resolve => setTimeout(resolve, 10));
    const stopping = stopped.stop(); release(); await Promise.all([running, stopping]);
    check(stopped.document.run.status === 'stopped' && !stopped.document.nodes[0].resultNodeIds?.length, 'late table after stop never creates a card');
    api.agentDsWorkflowResult = async requestId => ({ schemaVersion: 1, requestId, text: answer });

    answer = JSON.stringify({ ...table, rows: [['broken']] });
    const before = JSON.stringify(read('target-table'));
    await recovered.start(agent.id, true);
    check(recovered.document.run.status === 'failed' && JSON.stringify(read('target-table')) === before, 'invalid structured result does not alter the table');
    // Restore valid output for real rendered table and reload assertions.
    answer = JSON.stringify(table); await recovered.start(agent.id, true);
    window.save();
    return { tableId, submissions, generated };
  });
  await page.reload();
  const card = page.locator(`[data-canvas-node-id="${result.tableId}"]`);
  await card.waitFor();
  assert.equal(await card.getByRole('cell').count(), 12); // Growth preserves old cells, even after shrinking.
  await card.getByRole('textbox', { name: '第 2 行第 2 列', exact: true }).fill('手动编辑模块');
  await page.waitForFunction(id => JSON.parse(window.snapshot().nodes.find(n => n.id === id).payloadJson).cells[1][1].text === '手动编辑模块', result.tableId);
  const preview = page.locator('.workflow-text-result').filter({ hasText: '表格 · 2 行 × 3 列' });
  await preview.locator('summary').first().click();
  assert.equal(await preview.locator('table th').count(), 3);
  await page.getByRole('button', { name: '适应内容', exact: true }).click();
  await card.screenshot({ path: '.tmp/workflow/agent-table.png' });
  console.log('PASS Agent table parsing, real cells, stable reruns, single-cell consumer, recovery, connected targets, isolation and rendered reload', result);
} finally { await browser.close(); await server.close(); }
