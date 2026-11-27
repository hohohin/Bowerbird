import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const entry = 'scripts/fixtures/canvas-reference/preview.html';
const server = await createServer({
  cacheDir: '.tmp/wire-selection/vite',
  optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 1658, strictPort: true, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1900, height: 1200 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const card = id => page.locator(`[data-workflow-card="${id}"]`);
const native = id => page.locator(`[data-canvas-node-id="${id}"]`);
const stroke = locator => locator.evaluate(element => getComputedStyle(element).stroke);
const stage = page.locator('.canvas-stage');
const blank = { x: 1200, y: 950 };
const clear = () => stage.click({ position: blank });
const hoverPaths = stage.locator(':is(.workflow-wires, .canvas-graph-edges) > path.is-hovered');
async function assertHover(line, color) {
  assert.ok(await line.evaluate(element => element.classList.contains('is-hovered')), `${line} should be hovered`);
  assert.equal(await stroke(line), color);
}
async function select(locator) {
  await clear();
  await locator.click({ modifiers: [modifier] });
}
try {
  await page.goto(new URL(entry, server.resolvedUrls.local[0]).href);
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
      { ...base, id: 'generated-image', assetId: 'a', role: 'output', outputIsVideo: true, x: 1700, y: 650,
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
      node('consumer', 'generation', 850, 80, { generation: { media: 'video' }, sessionNodeIds: ['generated-session'],
        outputs: { image: { nodeIds: ['generated-session'], assetIds: ['a'] } }, inputs: {
        text: [{ nodeId: 'source', portId: 'text' }], image: [{ assetId: 'existing', assetNodeId: 'old' }],
        signal: [{ nodeId: 'trigger', portId: 'signal' }], 'visual-profile': [{ nodeId: 'profile', portId: 'visual-profile' }],
      } }), node('profile', 'visual-profile', 450, 580, { inputs: { image: [{ groupId: 'group' }] } }), node('trigger', 'trigger', 50, 650),
      node('unrelated', 'instruction', 450, 1100), node('agent', 'agent', 1700, 80, { sessionNodeIds: ['session-two'] }),
      node('writer', 'text', 0, 0, { textTarget: { nodeId: 'table', cellId: 'table-cell' }, inputs: { text: [{ nodeId: 'source', portId: 'text' }] } }),
      node('session-reader', 'instruction', 1300, 1100, { inputs: { image: [{ canvasNodeId: 'session-two', cellId: 'image' }] } }),
      node('result-reader', 'instruction', 2090, 650, { inputs: { image: [{ nodeId: 'consumer', portId: 'image' }] } })];
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
  const routed = page.locator('[data-workflow-target="result-reader"]');
  await writer.waitFor();
  await mkdir('.tmp/wire-selection', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await clear();
    const [muted, nativeMuted, nativeActive] = await stage.evaluate(element => {
      const probe = document.createElement('span');
      element.append(probe);
      const colors = ['var(--cs-muted)', 'var(--bb-line-strong)', 'rgb(var(--bb-blue-rgb) / 46%)'].map(value => {
        probe.style.color = value;
        return getComputedStyle(probe).color;
      });
      probe.remove();
      return colors;
    });
    const assertMuted = async () => {
      for (const line of [input, text, writer, signal, profile, output, sessionLink, sessionInput, groupInput, groupOutput, routed]) assert.equal(await stroke(line), muted, `${line}`);
      for (const line of [nativeEdge, groupEdge]) assert.equal(await stroke(line), nativeMuted, `${line}`);
    };
    await assertMuted();
    await page.screenshot({ path: `.tmp/wire-selection/${theme}-muted.png` });
    await native('old').hover();
    await assertHover(input, 'rgb(101, 183, 164)');
    await assertHover(nativeEdge, nativeActive);
    assert.equal(await stroke(text), muted);
    assert.deepEqual(await input.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.strokeWidth, style.opacity];
    }), ['1.7px', '1']);
    await native('duplicate').hover();
    assert.equal(await stroke(input), muted, 'hover only highlights the exact material instance');
    await card('consumer').locator('header strong').hover();
    await assertHover(text, 'rgb(181, 140, 232)');
    await assertHover(signal, 'rgb(185, 136, 62)');
    await assertHover(profile, 'rgb(200, 148, 66)');
    await assertHover(output, 'rgb(101, 183, 164)');
    await assertHover(routed, 'rgb(101, 183, 164)');
    assert.equal(await stroke(writer), muted);
    await card('source').locator('header strong').hover();
    await assertHover(text, 'rgb(181, 140, 232)');
    await assertHover(writer, 'rgb(181, 140, 232)');
    await native('table').locator('.canvas-text-handle').hover();
    await assertHover(writer, 'rgb(181, 140, 232)');
    await native('generated-image').hover();
    await assertHover(output, 'rgb(101, 183, 164)');
    await assertHover(routed, 'rgb(101, 183, 164)');
    await native('group').hover();
    await assertHover(groupInput, 'rgb(101, 183, 164)');
    await assertHover(groupOutput, 'rgb(101, 183, 164)');
    await assertHover(groupEdge, 'rgba(167, 139, 250, 0.72)');
    await native('session-one').locator('.canvas-prompt-content').hover();
    await assertHover(sessionLink, 'rgb(101, 183, 164)');
    await assertHover(sessionInput, 'rgb(101, 183, 164)');
    await assertHover(nativeEdge, nativeActive);
    for (const selector of ['[data-card-name="old"]', '[data-workflow-material="old"] .canvas-connection-handle']) {
      await page.locator(selector).hover();
      await assertHover(input, 'rgb(101, 183, 164)');
      await assertHover(nativeEdge, nativeActive);
    }
    await card('unrelated').locator('header strong').hover();
    assert.equal(await hoverPaths.count(), 0);
    await assertMuted();
    await native('old').hover();
    await stage.hover({ position: blank });
    assert.equal(await hoverPaths.count(), 0);
    await assertMuted();
    const oldBox = await native('old').boundingBox();
    await page.mouse.move(oldBox.x + 30, oldBox.y + 30);
    await assertHover(input, 'rgb(101, 183, 164)');
    await page.keyboard.down(modifier);
    await page.mouse.down();
    assert.equal(await hoverPaths.count(), 0, 'pointerdown clears hover while the pointer is still on a card');
    await page.mouse.move(oldBox.x + 31, oldBox.y + 30);
    assert.equal(await hoverPaths.count(), 0, 'pressed-pointer movement does not restore hover');
    await page.mouse.up();
    await page.keyboard.up(modifier);

    await select(native('duplicate'));
    assert.equal(await stroke(input), muted, 'another placement of the same image is unrelated');
    await select(native('old'));
    assert.equal(await stroke(input), 'rgb(101, 183, 164)');
    assert.notEqual(await stroke(nativeEdge), nativeMuted);
    assert.equal(await stroke(text), muted);
    await card('source').locator('header strong').hover();
    await assertHover(text, 'rgb(181, 140, 232)');
    await assertHover(writer, 'rgb(181, 140, 232)');
    assert.equal(await stroke(input), 'rgb(101, 183, 164)', 'selected wires stay highlighted alongside hovered wires');
    assert.equal(await stroke(nativeEdge), nativeActive);
    await stage.hover({ position: blank });
    assert.equal(await hoverPaths.count(), 0);
    assert.equal(await stroke(text), muted);
    assert.equal(await stroke(writer), muted);
    assert.equal(await stroke(input), 'rgb(101, 183, 164)');
    assert.equal(await stroke(nativeEdge), nativeActive);
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
    assert.notEqual(await stroke(nativeEdge), nativeMuted);
    await select(card('unrelated').locator('header strong'));
    for (const line of [input, text, writer, output, sessionLink]) assert.equal(await stroke(line), muted);
    assert.equal(await stroke(nativeEdge), nativeMuted);
    await card('trigger').getByRole('button', { name: '输出：触发', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.notEqual(await stroke(page.locator('.workflow-wires .is-draft')), muted, 'in-progress connection remains visible');
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
  console.log('PASS subdued wires and endpoint hover/selection in both themes: exact image instances, hidden content writer, merged session aliases, generated outputs and routing, native edges, pointer clearing and draft preview.');
} finally { await browser.close(); await server.close(); }
