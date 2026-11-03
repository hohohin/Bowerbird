import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, cacheDir: '.tmp/workflow-auto-video/vite', server: { host: '127.0.0.1', port: 1796, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
try {
  await page.goto('http://127.0.0.1:1796/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const checks = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode, workflowReferenceToken } = await import('/src/lib/canvasWorkflow.ts');
    const { useStore } = await import('/src/store.ts');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const assets = ['a', 'b', 'v', 'audio'].map(id => ({ id, name: id, store_path: `/tmp/${id}.${id === 'v' ? 'mp4' : id === 'audio' ? 'mp3' : 'png'}`, duration: id === 'v' ? 5 : null }));
    api.getAssetsByIds = async ids => ids.map(id => assets.find(asset => asset.id === id)).filter(Boolean);
    api.localAgentFindAssetId = async () => 'v';
    let active;
    const calls = [];
    useStore.setState({ startGeneration: async (...args) => {
      calls.push(args);
      const identity = args[12];
      check(active.document.run.steps.gen.jobId === identity.jobId, 'identity persisted before submission');
      useStore.setState({ genJobs: { [identity.jobId]: { turns: [{ turnKey: identity.turnKey, images: ['/tmp/v.mp4'] }] } } });
      return { accepted: true, jobId: identity.jobId };
    } });
    const setup = async (kind, refs, channel = 'jimeng', unused = []) => {
      active = new CanvasWorkflowController(`auto-video-${crypto.randomUUID()}`); await active.load();
      const promptReferences = [...refs, ...unused].map((assetId, i) => ({ id: `ref${i}`, label: `参考 ${i + 1}`, type: 'image', input: { assetId } }));
      const node = { ...newWorkflowNode('generation', 0, 0, 'codex'), id: 'gen', ratio: '2:3',
        prompt: `镜头推进 ${promptReferences.slice(0, refs.length).map(ref => workflowReferenceToken(ref.id)).join(' ')}`,
        inputs: { image: [...refs, ...unused].map(assetId => ({ assetId })) }, promptReferences,
        generation: { media: 'video', videoChannel: channel, ratio: '9:16', videoOptions: { kind, model_version: 'seedance2.5', duration: 8, video_resolution: '1080p' } } };
      await active.edit([node]); return node;
    };
    let count = 0;
    for (const channel of ['jimeng', 'cloud']) {
      for (const [stored, refs, expected] of [
        ['image2video', [], 'text2video'],
        ['multimodal2video', ['a'], 'image2video'],
        ['text2video', ['b', 'a'], 'multimodal2video'],
        ['image2video', ['v'], 'multimodal2video'],
        ['text2video', ['audio'], 'multimodal2video'],
        ['frames2video', ['b', 'a'], 'frames2video'],
      ]) {
        await setup(stored, refs, channel); await active.start('gen', true);
        check(active.document.run.status === 'done', `${channel} ${stored} -> ${expected}: ${JSON.stringify(active.issue)}`);
        const args = calls.at(-1);
        check(args[11].videoOptions.kind === expected, `${stored} with ${refs} submits ${expected}`);
        check(args[3] === (channel === 'cloud' ? 'bowerbird-cloud-video_seedance25_1080p' : 'jimeng'), 'channel and resolution preserved');
        check(args[2] === '9:16' && args[11].videoOptions.duration === 8, 'other options preserved');
        check(JSON.stringify(args[1].map(asset => asset.id)) === JSON.stringify(refs), 'actual prompt reference order preserved');
        count++;
      }
    }
    await setup('text2video', ['a'], 'jimeng', ['b']); await active.start('gen', true);
    check(active.document.run.status === 'done' && calls.at(-1)[11].videoOptions.kind === 'image2video', 'unreferenced connections do not change mode'); count++;
    const beforeInvalid = calls.length;
    for (const [kind, refs] of [['frames2video', ['a']], ['frames2video', ['audio']]]) {
      await setup(kind, refs); await active.start('gen', true);
      check(active.document.run.status === 'failed' && !active.document.run.steps.gen.jobId, 'unsupported inputs rejected before submission identity'); count++;
    }
    check(calls.length === beforeInvalid, 'invalid explicit frames and unsupported audio never submit');
    return count;
  });
  assert.equal(checks, 15);
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode, workflowReferenceToken } = await import('/src/lib/canvasWorkflow.ts');
    window.previewVideo = async (refs, unused = [], frames = false, tail = false) => {
      const promptReferences = [...refs, ...unused].map((assetId, i) => ({ id: `ref${i}`, label: `参考 ${i + 1}`, type: 'image', input: { assetId, ...(tail ? { assetNodeId: 'old' } : {}) } }));
      await canvasWorkflowController('p').edit([{ ...newWorkflowNode('generation', 400, 100, 'codex'), id: 'preview-video',
        prompt: `镜头推进 ${promptReferences.slice(0, refs.length).map(ref => workflowReferenceToken(ref.id)).join(' ')}`,
        inputs: { image: promptReferences.map(ref => ref.input) }, promptReferences,
        generation: { media: 'video', videoChannel: 'cloud', ratio: '9:16', videoOptions: { kind: frames ? 'frames2video' : 'text2video', model_version: 'seedance2.5', duration: 8, video_resolution: '720p' } } }]);
    };
  });
  const card = page.locator('[data-workflow-card="preview-video"]');
  for (const [refs, unused, frames, tail, expected] of [
    [[], [], false, false, '自动识别：文生视频'],
    [['a'], ['b'], false, false, '自动识别：单图生视频'],
    [['a', 'b'], [], false, false, '自动识别：多参考'],
    [['v'], [], false, false, '自动识别：多参考'],
    [['v'], [], false, true, '自动识别：单图生视频'],
    [['a', 'b'], [], true, false, '按参考顺序使用首帧、尾帧'],
  ]) {
    await page.evaluate(args => window.previewVideo(...args), [refs, unused, frames, tail]);
    await page.waitForFunction(expected => document.querySelector('[data-workflow-card="preview-video"] [aria-label="视频生成模式"]')?.title === expected, expected);
    assert.equal(await card.getByLabel('视频生成模式').getAttribute('title'), expected);
    assert.equal(await card.getByLabel('视频比例', { exact: true }).count(), expected === '自动识别：文生视频' || expected === '自动识别：多参考' ? 1 : 0);
  }
  console.log('PASS workflow automatic video modes, actual references, explicit frames, unsupported media and live controls', checks + 6);
} finally { await browser.close(); await server.close(); }
