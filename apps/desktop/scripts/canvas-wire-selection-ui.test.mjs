import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1658, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1900, height: 1200 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const card = id => page.locator(`[data-workflow-card="${id}"]`);
const native = id => page.locator(`[data-canvas-node-id="${id}"]`);
const stroke = locator => locator.evaluate(element => getComputedStyle(element).stroke);
const clear = () => page.locator('.canvas-stage').click({ position: { x: 1200, y: 950 } });
async function select(locator) {
  await clear();
  await locator.click({ modifiers: [modifier] });
}
try {
  await page.goto('http://127.0.0.1:1658/scripts/fixtures/canvas-reference/preview.html');
  await native('old').waitFor();
  await page.evaluate(async () => {
    const s = window.snapshot(), base = s.nodes[0];
    const note = (id, x, y) => ({ ...base, id, kind: 'note', assetId: null, role: null, x, y, width: 350, height: 210,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', cells: [[{ id: `${id}-cell`, text: '连线验收' }]] }) });
    const session = (id, job, turn, x, y, createdAt) => ({ ...base, id, kind: 'prompt', assetId: null, role: null, x, y, width: 260, height: 180, createdAt,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: job, turn_key: turn, text: '普通会话', provider: 'codex', status: 'done' }) });
    s.nodes = [{ ...base, x: 50, y: 80 }, { ...base, id: 'duplicate', x: 50, y: 340 },
      note('table', 850, 650), note('result', 1300, 650),
      session('session-one', 'normal-job', 'one', 1250, 80, 1), session('session-two', 'normal-job', 'two', 1250, 350, 2),
      session('generated-session', 'generated-job', 'one', 0, 0, 1),
      { ...base, id: 'generated-image', assetId: 'a', role: 'output', x: 1700, y: 650,
        payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: '生成图片', width: 190, height: 150 }, execution: { job_id: 'generated-job', turn_key: 'one' } }) },
      ...['b', 'c'].map(assetId => ({ ...base, id: `group-${assetId}`, assetId, x: 1700, y: 1000 }))];
    s.groups = [{ id: 'group', projectId: 'p', name: '素材组', role: null, x: 1700, y: 1000, width: 190, height: 180, zIndex: 1, createdAt: 1, updatedAt: 1 }];
    s.groupItems = ['b', 'c'].map((id, ordinal) => ({ projectId: 'p', groupId: 'group', nodeId: `group-${id}`, ordinal }));
    s.edges = [{ id: 'native-input', projectId: 'p', threadId: 't', fromNodeId: 'old', toNodeId: 'session-two', kind: 'input', ordinal: 0, createdAt: 1 },
      { id: 'group-edge', projectId: 'p', threadId: 't', fromNodeId: 'group-b', toNodeId: 'session-two', kind: 'branch', ordinal: 1, createdAt: 1 }];
    s.view = { ...s.view, zoom: 0.6, panX: 50, panY: 60 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(s));
    const { newWorkflowNode, emptyWorkflow } = await import('/src/lib/canvasWorkflow.ts');
    const node = (id, kind, x, y, extra = {}) => ({ ...newWorkflowNode(kind, x, y, 'codex'), id, ...extra });
    const document = emptyWorkflow();
    document.nodes = [node('source', 'instruction', 450, 80, { resultNodeIds: ['result'], resultGroupId: 'group' }),
      node('consumer', 'generation', 850, 80, { sessionNodeIds: ['generated-session'], inputs: {
        text: [{ nodeId: 'source', portId: 'text' }], image: [{ assetId: 'existing', assetNodeId: 'old' }],
        signal: [{ nodeId: 'trigger', portId: 'signal' }], 'visual-profile': [{ nodeId: 'profile', portId: 'visual-profile' }],
      } }), node('profile', 'visual-profile', 450, 580, { inputs: { image: [{ groupId: 'group' }] } }), node('trigger', 'trigger', 50, 650),
      node('unrelated', 'instruction', 450, 1100), node('agent', 'agent', 1700, 80, { sessionNodeIds: ['session-two'] }),
      node('writer', 'text', 0, 0, { textTarget: { nodeId: 'table', cellId: 'table-cell' }, inputs: { text: [{ nodeId: 'source', portId: 'text' }] } }),
      node('session-reader', 'instruction', 1300, 1100, { inputs: { image: [{ canvasNodeId: 'session-two', cellId: 'image' }] } })];
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 0, document }));
  });
  await page.reload(); await card('consumer').waitFor();
  const input = page.locator('[data-workflow-target="consumer"].is-image');
  const text = page.locator('[data-workflow-target="consumer"].is-text');
  const writer = page.locator('[data-workflow-target="writer"]');
  const signal = page.locator('[data-workflow-target="consumer"].is-signal');
  const profile = page.locator('[data-workflow-target="consumer"].is-visual-profile');
  const output = page.locator('[data-workflow-generated-link="generated-image"]');
  const sessionLink = page.locator('[data-workflow-session-link="session-two"]');
  const sessionInput = page.locator('[data-workflow-target="session-reader"]');
  const nativeEdge = page.locator('.canvas-graph-edges path.is-input');
  const groupEdge = page.locator('.canvas-graph-edges path.is-branch');
  const groupInput = page.locator('[data-workflow-target="profile"].is-image');
  const groupOutput = page.locator('[data-workflow-product-link="group"]');
  await writer.waitFor();
  await mkdir('.tmp/wire-selection', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await clear();
    const muted = theme === 'light' ? 'rgb(217, 210, 200)' : 'rgb(52, 49, 49)';
    for (const line of [input, text, writer, signal, profile, output, sessionLink, sessionInput, nativeEdge, groupEdge, groupInput, groupOutput]) assert.equal(await stroke(line), muted);
    await page.screenshot({ path: `.tmp/wire-selection/${theme}-muted.png` });
    await select(native('duplicate'));
    assert.equal(await stroke(input), muted, 'another placement of the same image is unrelated');
    await select(native('old'));
    assert.equal(await stroke(input), 'rgb(101, 183, 164)');
    assert.notEqual(await stroke(nativeEdge), muted);
    assert.equal(await stroke(text), muted);
    await select(card('consumer').locator('header strong'));
    assert.equal(await stroke(text), 'rgb(181, 140, 232)');
    assert.equal(await stroke(signal), 'rgb(185, 136, 62)');
    assert.equal(await stroke(profile), 'rgb(200, 148, 66)');
    assert.equal(await stroke(output), 'rgb(101, 183, 164)');
    assert.equal(await stroke(writer), muted);
    await page.screenshot({ path: `.tmp/wire-selection/${theme}-selected.png` });
    await select(card('source').locator('header strong'));
    assert.equal(await stroke(text), 'rgb(181, 140, 232)');
    assert.equal(await stroke(writer), 'rgb(181, 140, 232)');
    await select(native('table').locator('.canvas-text-handle'));
    assert.equal(await stroke(writer), 'rgb(181, 140, 232)', 'hidden writer follows its visible content card');
    await select(native('generated-image'));
    assert.equal(await stroke(output), 'rgb(101, 183, 164)', 'generated image highlights its upstream wire');
    await select(native('group'));
    for (const line of [groupInput, groupOutput]) assert.equal(await stroke(line), 'rgb(101, 183, 164)', 'group highlights both input and product connections');
    assert.equal(await stroke(groupEdge), 'rgba(167, 139, 250, 0.72)', 'native edge follows its grouped material anchor');
    await select(native('session-one').locator('.canvas-prompt-content'));
    assert.equal(await stroke(sessionLink), 'rgb(101, 183, 164)', 'unified image output follows the visible conversation anchor');
    assert.equal(await stroke(sessionInput), 'rgb(101, 183, 164)', 'old turn input follows the same anchor');
    assert.notEqual(await stroke(nativeEdge), muted);
    await select(card('unrelated').locator('header strong'));
    for (const line of [input, text, writer, output, sessionLink, nativeEdge]) assert.equal(await stroke(line), muted);
    await card('source').getByRole('button', { name: '输出：提示词', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.notEqual(await stroke(page.locator('.workflow-wires .is-draft')), muted, 'in-progress connection remains visible');
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
  console.log('PASS subdued wires in both themes; endpoint selection, exact image instances, hidden content writer, merged session aliases, generated outputs, native edges, deselection and draft preview.');
} finally { await browser.close(); await server.close(); }
