import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

const rows = [
  ['第N屏', '/', '篇章标题', '文案/二级标题', '收束', '小字点缀'],
  ['1', '品牌海报', '留贝shellike', 'KEEPTHE SEACRET 藏一片海', '东方雅韵 | 原创贝壳礼 | 独一无二', ''],
  ['2', '首饰效果照片特写', '「一珀紫心」', '', '', ''],
  ['3', '写螺', '潮汐孕育的一抹幽紫', '贝壳图鉴\n\n名称｜雪山宝螺\n学名｜Monetaria caputserpentis\n区域｜印度洋-太平洋珊瑚礁区', '', ''],
  ['4', '根据产品调整', '挑一', '不是复制品，是万里挑一\n\n壹|量寸\n贰|辨色\n叁|验形\n肆|入选', '', ''],
  ['5', '根据产品调整', '无二', '「一珀紫心」\n珀色为壳，紫意藏心', '“西望瑶池降王母， 东来紫气满函关。”\n取宝螺如珀的温润，承祥瑞之色', '贝壳美学\n\n自然纯粹'],
  ['6', '贝壳、水晶铸吊坠特写', '天生紫韵，静藏灵光', '八边形框1-贝壳：约20mm\n八边形框2-水晶：天然紫水晶约8mm', '', ''],
  ['7', '单链条展示', '/', '八边形框1-链条：316L低敏钛钢\n八边形框2-调节扣：45+5+5cm延长链，三档可调\n八边形框3-细节链接处：龙虾扣与铭\n八边形框4-细节S线条链接：取于留贝徽标里似山似水的意象，层峦叠嶂，海浪一片', '', ''],
  ['8', '根据产品调整', '案前', '朝来暮往，不事张扬，不失雅意。', '', ''],
  ['9', '根据产品调整', '远游', '轻巧随行，与山水同乐。', '', ''],
  ['10', '根据产品调整', '赴宴', '赴一席良宴，明艳恰到好处。', '', ''],
  ['11', '根据产品调整', '闲居', '日子寻常，亦有清欢。', '', ''],
  ['12', '通用', '老茧', '是手作的落款。', '洗、晾、挑、磨、配、穿，不以繁复为名，把耐心留在细节里。', ''],
  ['13', '通用', '火眼', '千枚过眼，只取合意。', '认真，是最慢的捷径。每一枚，都是承诺本身。', ''],
];
const markdownRow = row => '| ' + row.map(text => text.replaceAll('|', '\\|').replaceAll('\n', '<br>')).join(' | ') + ' |';
const markdown = [markdownRow(rows[0]), '| --- | --- | --- | --- | --- | --- |', ...rows.slice(1).map(markdownRow)].join('\n');
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1627, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1627/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const s = window.snapshot();
    s.nodes = [{ ...s.nodes[0], id: 'table', kind: 'note', role: null, assetId: null, x: 50, y: 50, width: 400, height: 250,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ id: 'anchor', content_type: 'text', text: '', bold: false, italic: false, align: 'left' }]] }) }];
    s.view = { ...s.view, zoom: 1, panX: 50, panY: 50 }; sessionStorage.setItem('reference-fixture', JSON.stringify(s));
  });
  await page.reload();
  await page.getByRole('textbox', { name: '第 1 行第 1 列', exact: true }).focus();
  await page.evaluate(text => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press(`${primaryModifier}+v`);
  await page.waitForFunction(() => JSON.parse(window.snapshot().nodes[0].payloadJson).cells.length === 14);
  assert.deepEqual(await page.evaluate(() => JSON.parse(window.snapshot().nodes[0].payloadJson).cells.map(row => row.map(cell => cell.text))), rows);
  await page.evaluate(() => window.save()); await page.reload();
  await page.locator('[data-canvas-node-id="table"]').waitFor();
  const result = await page.evaluate(async expected => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController, CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode, compileAgentPrompt, compileGenerationPrompt } = await import('/src/lib/canvasWorkflow.ts');
    const { readCanvasNote, canvasNoteValue, emptyCanvasCell } = await import('/src/lib/canvasNotes.ts');
    const { canvasContentInput } = await import('/src/lib/canvasContentInput.ts');
    const { workflowLoopRows, workflowLoopOutputs } = await import('/src/lib/workflowLoop.ts');
    const { parseTextTable } = await import('/src/lib/contentTable.ts');
    const { useStore } = await import('/src/store.ts');
    const check = (value, message) => { if (!value) throw Error(message); };
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const base = window.snapshot().nodes[0], original = readCanvasNote(base);
    const output = canvasNoteValue(original, '*text');
    check(equal(output.table.rows, expected) && equal(JSON.parse(output.text).rows, expected), 'whole read is a lossless table');
    check(equal(parseTextTable(output.text), expected), 'serialized output is accepted as the same table input');
    const single = canvasNoteValue(original, original.cells[5][4].id);
    check(equal(single.table.rows, [[expected[5][4]]]), 'single cell is a 1x1 subtable');
    const blank = { schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ ...emptyCanvasCell(), id: 'root' }]] };
    for (const id of ['relay', 'result']) await api.projectCanvasNodeCreate({ ...base, id, x: 1000, payloadJson: JSON.stringify(blank) });
    let controller = canvasWorkflowController('p'); await controller.load();
    await controller.bindTextInput('relay', undefined, { canvasNodeId: 'table', cellId: '*text' }, 'text');
    const relay = readCanvasNote(window.snapshot().nodes.find(node => node.id === 'relay'));
    check(equal(relay.cells.map(row => row.map(cell => cell.text)), expected), 'card-to-card delivery retains exact grid');
    const input = { canvasNodeId: 'relay', cellId: '*text' };
    const agent = { ...newWorkflowNode('agent', 1300, 0, ''), id: 'table-agent', prompt: '逐格返回此表，不改内容', inputs: { text: [input] } };
    let requests = [], ready = true;
    api.agentDsWorkflowStart = async (requestId, instruction, source, purpose, images, scope, provider, transport) => {
      const data = JSON.parse(source)['引用文本 1'];
      check(data.format === 'bowerbird-table' && equal(data.rows, expected), 'actual Agent IPC receives the 14x6 matrix');
      requests.push({ requestId, transport }); return { autoDelivered: true };
    };
    api.agentDsWorkflowResult = async requestId => ready ? { schemaVersion: 1, requestId, text: JSON.stringify({ format: 'bowerbird-table', rows: expected }) } : null;
    useStore.setState({ cloudAuth: null, cloudEntitlement: null });
    await controller.edit([...controller.document.nodes, agent]);
    await controller.bindTextInput('result', undefined, { nodeId: agent.id, portId: 'text' }, 'text');
    const checkResult = () => {
      const note = readCanvasNote(window.snapshot().nodes.find(node => node.id === 'result'));
      check(equal(note.cells.slice(-14).map(row => row.map(cell => cell.text)), expected), 'Agent result returns exact table');
    };
    await controller.start(agent.id, true); check(controller.document.run.status === 'done', JSON.stringify(controller.issue)); checkResult();
    await controller.edit(controller.document.nodes.map(node => node.id === agent.id ? { ...node, agentTransport: 'codex-cli' } : node));
    await controller.start(agent.id, true); check(controller.document.run.status === 'done', JSON.stringify(controller.issue)); checkResult();
    check(requests.length === 2 && requests[1].transport === 'codex-cli', 'both local transports share the table contract');
    const cloud = { ...agent, agentTransport: 'cloud', prompt: '读取 @[table]', promptReferences: [{ id: 'table', input, type: 'text', label: '表格' }] };
    check(equal(JSON.parse(compileAgentPrompt(cloud, { text: [output] }).source)['引用文本 1'].rows, expected), 'Cloud source also preserves grid');
    const generation = { ...newWorkflowNode('generation', 0, 0, 'codex'), prompt: '@[table]', inputs: { text: [input] }, promptReferences: cloud.promptReferences };
    check(equal(JSON.parse(compileGenerationPrompt(generation, { text: [output] }).prompt).rows, expected), 'generation keeps table delimiters');
    const loop = { ...newWorkflowNode('loop', 0, 0, ''), loopMode: 'rows', inputs: { text: [{ canvasNodeId: base.id, cellId: '*text' }] } };
    const items = workflowLoopRows(loop, [loop], [base]);
    check(items.length === 14 && equal(workflowLoopOutputs(items[5], 5).text.table.rows, [expected[5]]), 'loop slices physical rows without splitting multiline cells');
    const mixed = { ...blank, cells: [[{ ...emptyCanvasCell(), id: 't', text: '参考 @图片1', image_refs: [{ asset_id: 'b', token: '@图片1' }] },
      { ...emptyCanvasCell(), id: 'i', content_type: 'image', text: '@图片1', image_refs: [{ asset_id: 'a', token: '@图片1' }] }]] };
    const mixedOutput = canvasNoteValue(mixed, '*text');
    const mixedCopy = canvasContentInput(blank, { nodeId: 'x', cellId: 'root', append: true }, mixedOutput).note;
    check(equal(canvasNoteValue(mixedCopy, '*text').table, mixedOutput.table), 'mixed table roundtrip preserves image positions');
    const mixedSource = compileAgentPrompt(agent, { text: [mixedOutput] });
    check(equal(mixedSource.assetIds, ['b', 'a']) && equal(JSON.parse(mixedSource.source)['引用文本 1'].rows, [['参考 @图片1', '@图片2']]), 'table image tokens map to actual attachments');
    const producedLoop = { ...loop, inputs: { text: [{ nodeId: 'mixed-source', portId: 'text' }] } };
    const producedItems = workflowLoopRows(producedLoop, [{ ...agent, id: 'mixed-source', outputs: { text: mixedOutput } }], []);
    check(equal(producedItems[0].assetIds, mixedOutput.assetIds) && equal(producedItems[0].table, mixedOutput.table), 'produced and native mixed rows share the same projection');
    let cloudImagesBlocked = false;
    try { compileAgentPrompt(cloud, { text: [mixedOutput] }); } catch { cloudImagesBlocked = true; }
    check(cloudImagesBlocked, 'Cloud cannot silently discard table images');
    const scalar = canvasContentInput(blank, { nodeId: 'x', cellId: 'root' }, single).note;
    check(scalar.cells[0][0].text === expected[5][4], '1x1 input writes raw cell value');
    let blocked = false;
    try { canvasContentInput(blank, { nodeId: 'x', cellId: 'root' }, output); } catch { blocked = true; }
    check(blocked, 'multi-cell table never silently flattens into a single fixed cell');
    // Recover a paused delivery without issuing another model request.
    ready = false;
    api.agentDsWorkflowStart = async requestId => { requests.push({ requestId }); return { autoDelivered: false }; };
    await controller.start(agent.id, true); check(controller.document.run.status === 'waiting', 'waiting persisted');
    const count = requests.length; ready = true;
    controller = new CanvasWorkflowController('p'); await controller.load(); await controller.continue();
    check(controller.document.run.status === 'done' && requests.length === count, 'reload does not resubmit'); checkResult();
    window.save();
    return { rows: expected.length, columns: expected[0].length, requests: requests.length };
  }, rows);
  assert.equal(result.rows, 14); assert.equal(result.columns, 6); assert.deepEqual(errors, []);
  console.log('table roundtrip passed: 13-screen brief + header, native Markdown paste, reload, card relay, Agent DS/Codex IPC, Cloud source, generation, row loop, images and recovery', result);
} finally { await browser.close(); await server.close(); }
