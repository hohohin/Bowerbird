import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/workflow-permissions/vite', server: { host: '127.0.0.1', port: 18325, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:18325/scripts/fixtures/canvas-reference/preview.html');
  const result = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const controller = new CanvasWorkflowController('permissions-test');
    controller.ready = true;
    const saves = [], events = [];
    let release;
    const authorization = new Promise(resolve => { release = resolve; });
    api.canvasWorkflowAuthorize = async () => { events.push('authorize'); await authorization; };
    api.canvasWorkflowSave = async (_project, revision, document) => { events.push('save'); saves.push(structuredClone(document)); return revision + 1; };
    const node = { ...newWorkflowNode('generation', 0, 0, 'generate'), generation: { media: 'video', videoOptions: { kind: 'frames2video', duration: 4, model_version: 'seedance2.5', video_resolution: '720p' } } };
    const before = controller.document;
    const first = controller.edit([node]);
    const immediate = controller.document !== before && controller.document.nodes[0]?.generation.videoOptions.kind === 'frames2video';
    if (!immediate) { release(); await first; return { immediate }; }
    const latest = controller.document.nodes[0];
    const second = controller.edit([{ ...latest, generation: { ...latest.generation, videoOptions: { ...latest.generation.videoOptions, duration: 8 } } }]);
    await Promise.resolve();
    const beforeAuthorization = saves.length;
    release(); await Promise.all([first, second]);
    api.canvasWorkflowAuthorize = async () => { throw new Error('工作流卡片的创建、编辑和运行需要 Pro；已有结果仍可查看和导出'); };
    let rejected = false;
    try { await controller.edit([{ ...controller.document.nodes[0], prompt: 'rejected edit' }]); } catch { rejected = true; }
    return { immediate, beforeAuthorization, events, rejected, error: controller.error, prompt: controller.document.nodes[0].prompt, saves: saves.map(doc => doc.nodes[0].generation.videoOptions) };
  });
  assert.equal(result.immediate, true, 'editing must publish the optimistic snapshot synchronously for subsequent edits and undo');
  assert.equal(result.beforeAuthorization, 0, 'no save before Pro authorization');
  assert.deepEqual(result.events, ['authorize', 'save', 'authorize', 'save']);
  assert.deepEqual(result.saves.map(value => [value.kind, value.duration]), [['frames2video', 4], ['frames2video', 8]]);
  assert.equal(result.rejected, true);
  assert.equal(result.error, "", "a definitive denial clears the save error");
  assert.notEqual(result.prompt, "rejected edit", "the persisted prompt is restored");
  console.log('PASS delayed Pro authorization preserves edits and undo snapshots; denied edits never reach storage');
} finally { await browser.close(); await server.close(); }
