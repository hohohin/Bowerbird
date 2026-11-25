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
    const firstSave = new Promise(resolve => { release = resolve; });
    api.canvasWorkflowAuthorize = async () => { events.push('authorize'); throw Error('运行工作流卡片需要 Pro'); };
    api.canvasWorkflowSave = async (_project, revision, document) => {
      events.push('save');
      if (!revision) await firstSave;
      saves.push(structuredClone(document));
      return revision + 1;
    };
    const node = { ...newWorkflowNode('generation', 0, 0, 'generate'), generation: { media: 'video', videoOptions: { kind: 'frames2video', duration: 4, model_version: 'seedance2.5', video_resolution: '720p' } } };
    const before = controller.document;
    const first = controller.edit([node]);
    const immediate = controller.document !== before && controller.document.nodes[0]?.generation.videoOptions.kind === 'frames2video';
    if (!immediate) { release(); await first; return { immediate }; }
    const latest = controller.document.nodes[0];
    const second = controller.edit([{ ...latest, generation: { ...latest.generation, videoOptions: { ...latest.generation.videoOptions, duration: 8 } } }]);
    await Promise.resolve();
    const beforeFirstSave = [...events];
    release(); await Promise.all([first, second]);
    await controller.edit([{ ...controller.document.nodes[0], prompt: '可直接编辑的提示词' }]);
    return { immediate, beforeFirstSave, events, error: controller.error, prompt: controller.document.nodes[0].prompt,
      saves: saves.map(doc => doc.nodes[0].generation.videoOptions) };
  });
  assert.equal(result.immediate, true, 'editing must publish the optimistic snapshot synchronously for subsequent edits and undo');
  assert.deepEqual(result.beforeFirstSave, ['save']);
  assert.deepEqual(result.events, ['save', 'save', 'save']);
  assert.deepEqual(result.saves.map(value => [value.kind, value.duration]), [['frames2video', 4], ['frames2video', 8], ['frames2video', 8]]);
  assert.equal(result.error, '');
  assert.equal(result.prompt, '可直接编辑的提示词');
  console.log('PASS edits publish immediately and serialize saves without Pro authorization');
} finally { await browser.close(); await server.close(); }
