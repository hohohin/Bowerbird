import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1648, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:1648/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  console.log(await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { useStore } = await import('/src/store.ts');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const read = id => JSON.parse(window.snapshot().nodes.find(n => n.id === id).payloadJson).cells.flat();
    const base = window.snapshot().nodes[0];
    const make = async id => api.projectCanvasNodeCreate({ ...base, id, kind: 'note', assetId: null, role: null,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ id: 'root', text: '手写保留' }]] }) });
    await make('receiver'); await make('single');
    let answer = '第一轮', images = ['existing'], submitted = 0;
    api.agentDsWorkflowStart = async () => { submitted++; return { autoDelivered: true, path: 'isolated' }; };
    api.agentDsWorkflowResult = async requestId => ({ schemaVersion: 1, requestId, text: answer, images: ['out.png'] });
    api.agentDsWorkflowIngestImages = async () => api.getAssetsByIds(images);
    useStore.setState({ cloudAuth: null, cloudEntitlement: null });
    const c = new CanvasWorkflowController('append'); await c.load();
    const agent = { ...newWorkflowNode('agent', 0, 0, ''), id: 'agent', prompt: '返回图文' };
    await c.edit([agent]);
    await c.bindTextInput('receiver', undefined, { nodeId: 'agent', portId: 'text' }, 'text');
    await c.bindTextInput('receiver', undefined, { nodeId: 'agent', portId: 'image' }, 'image');
    await c.bindTextInput('single', 'root', { nodeId: 'agent', portId: 'text' }, 'text');
    await c.start('agent', true);
    check(c.document.run.status === 'done', JSON.stringify(c.issue));
    const first = structuredClone(read('receiver'));
    answer = '第二轮'; await c.start('agent', true);
    check(first.every(cell => JSON.stringify(read('receiver').find(n => n.id === cell.id)) === JSON.stringify(cell)), 'main input must retain the previous text and image cells');
    check(read('receiver').filter(cell => cell.text === answer).length === 1 && read('receiver').filter(cell => cell.image_refs?.length).length === 2, 'each run appends text and image, even identical images');
    check(read('single').length === 1 && read('single')[0].text === answer, 'cell input always overwrites only its cell');

    // A write may reach storage before its caller sees an error. Retrying must not append twice.
    const update = api.projectCanvasNoteUpdate;
    let fail = true;
    api.projectCanvasNoteUpdate = async (id, payload) => {
      const result = await update(id, payload);
      if (id === 'receiver' && fail) { fail = false; throw Error('写入成功后中断'); }
      return result;
    };
    answer = '恢复轮'; await c.start('agent', true);
    check(c.document.run.status === 'waiting', 'delivery failure waits');
    const count = submitted;
    const resumed = new CanvasWorkflowController('append'); await resumed.load(); await resumed.continue();
    check(resumed.document.run.status === 'done' && submitted === count, 'reload retries delivery without Agent resubmission');
    check(read('receiver').filter(cell => cell.text === answer).length === 1, 'successful write followed by error does not append duplicate content');
    api.projectCanvasNoteUpdate = update;

    // Structured tables are appended as independent blocks, then plain text keeps both tables.
    answer = JSON.stringify({ format: 'bowerbird-table', columns: ['列'], rows: [['数据']] });
    await resumed.start('agent', true); await resumed.start('agent', true);
    answer = '表后文字'; await resumed.start('agent', true);
    check(read('receiver').filter(cell => cell.text === '列').length === 2 && read('receiver').filter(cell => cell.text === '数据').length === 2, 'table reruns and text after table preserve earlier blocks');

    // Two loop items have separate delivery steps and must retain both results.
    await make('loop-source');
    const source = JSON.parse(window.snapshot().nodes.find(n => n.id === 'loop-source').payloadJson);
    source.cells = [[{ id: 'one', text: '一' }], [{ id: 'two', text: '二' }]];
    await update('loop-source', JSON.stringify(source));
    const loop = { ...newWorkflowNode('loop', 0, 0, ''), id: 'loop', loopMode: 'rows', inputs: { text: [{ canvasNodeId: 'loop-source', cellId: '*text' }] } };
    await resumed.edit([...resumed.document.nodes.map(n => n.id === 'agent' ? { ...n, inputs: { text: [{ nodeId: 'loop', portId: 'text' }] } } : n), loop]);
    const beforeLoop = submitted;
    let failLoop = true;
    api.projectCanvasNoteUpdate = async (id, payload) => {
      if (id === 'receiver' && submitted === beforeLoop + 2 && failLoop) { failLoop = false; throw Error('新行写入前中断'); }
      return update(id, payload);
    };
    answer = '循环结果'; await resumed.start('loop');
    check(resumed.document.run.status === 'waiting' && resumed.document.run.loop.completed.length === 1, 'second loop item pauses before materializing new rows');
    const loopRetry = new CanvasWorkflowController('append'); await loopRetry.load(); await loopRetry.retryLoop(loopRetry.document.run.id);
    check(loopRetry.document.run.status === 'done' && loopRetry.document.run.loop.completed.length === 2 && submitted === beforeLoop + 2, JSON.stringify(loopRetry.issue));
    check(read('receiver').filter(cell => cell.text === answer).length === 2, 'loop items append separately');

    const main = loopRetry.document.nodes.find(n => n.textTarget?.nodeId === 'receiver' && !n.textTarget.image);
    const fixedId = main.textTarget.cellId;
    await loopRetry.bindTextInput('receiver', fixedId, { nodeId: 'agent', portId: 'text' }, 'text');
    check(loopRetry.document.nodes.find(n => n.id === main.id).textTarget.append === false, 'explicitly connecting the main anchor as a cell switches to fixed-cell semantics');
    answer = '指定格更新'; await loopRetry.start('agent', true);
    check(read('receiver').find(cell => cell.id === fixedId).text === answer && read('receiver').filter(cell => cell.text === '循环结果').length === 1, 'converted cell overwrites without removing earlier loop content');
    return 'PASS main inputs append text/images/tables per run and loop item; fixed cell overwrites; reload retry is idempotent';
  }));
} finally { await browser.close(); await server.close(); }
