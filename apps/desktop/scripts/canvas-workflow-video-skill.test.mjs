import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { placeWorkflowCard } from './fixtures/canvas-reference/place-card.mjs';
const server = await createServer({ configFile: false, cacheDir: '.tmp/video-skill-vite', root: process.cwd(), server: { host: '127.0.0.1', port: 1684, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
try {
  await page.goto('http://127.0.0.1:1684/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await placeWorkflowCard(page, '新增 Agent 卡片');
  await page.getByRole('combobox', { name: 'Agent 执行引擎' }).click();
  await page.getByRole('option', { name: 'Codex CLI', exact: true }).click();
  await page.getByRole('combobox', { name: 'Agent 制作能力' }).click();
  await page.getByRole('option', { name: '视频制作 · HyperFrames', exact: true }).click();
  await page.reload();
  await page.getByRole('combobox', { name: 'Agent 制作能力' }).waitFor();
  assert.match(await page.getByRole('combobox', { name: 'Agent 制作能力' }).textContent(), /HyperFrames/);
  await mkdir('.tmp/video-skill', { recursive: true });
  await page.screenshot({ path: '.tmp/video-skill/card.png' });
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode, workflowOutputs } = await import('/src/lib/canvasWorkflow.ts');
    const { automaticInputMedia } = await import('/src/lib/workflowAutoConnect.ts');
    const { videoFrameInputValues } = await import('/src/lib/workflowVideoFrames.ts');
    const { captureWorkflowTemplate } = await import('/src/lib/workflowTemplates.ts');
    const { useStore } = await import('/src/store.ts');
    const check = (value, message) => { if (!value) throw Error(message); };
    useStore.setState({ cloudAuth: null, cloudEntitlement: null });
    const asset = { ...(await api.getAssetsByIds(['a']))[0], id: 'movie', ext: 'mp4', store_path: 'C:/isolated/result.mp4', duration: 2 };
    const originals = [
      { ...asset, id: 'input-video', store_path: 'C:/isolated/source.mp4' },
      { ...asset, id: 'input-audio', ext: 'mp3', store_path: 'C:/isolated/music.mp3' },
    ];
    const readAssets = api.getAssetsByIds;
    api.getAssetsByIds = async ids => (await Promise.all(ids.map(async id => originals.find(asset => asset.id === id) ?? (await readAssets([id]))[0]))).filter(Boolean);
    const calls = [], results = new Map(), cancelled = [];
    let hold = false, failure = false;
    api.agentDsWorkflowGenerationRequest = async () => null;
    api.agentDsWorkflowCancel = async id => { cancelled.push(id); };
    api.agentDsWorkflowStart = async (...args) => {
      calls.push(args);
      check(args[7] === 'codex-cli', 'video capability uses existing Codex transport');
      if (args[3] === 'agent-text') {
        results.set(args[0], { schemaVersion: 1, requestId: args[0], text: '原有图文处理', images: ['image.png'] });
      } else {
        check(args[3] === 'agent-video' && args[4].join() === originals.map(asset => asset.store_path).join(), 'original video and audio reach video purpose');
        results.set(args[0], failure ? { schemaVersion: 1, requestId: args[0], error: '视频渲染失败' }
          : { schemaVersion: 1, requestId: args[0], text: '成片已完成', videos: ['result.mp4'], projectPath: 'C:/isolated/project' });
      }
      return { autoDelivered: true, path: 'isolated' };
    };
    api.agentDsWorkflowResult = async id => hold ? null : results.get(id);
    api.agentDsWorkflowIngestImages = async id => results.get(id).videos ? [asset] : readAssets(['a']);
    api.cloudAgentStart = async () => { throw Error('must not create a cloud task'); };
    const controller = new CanvasWorkflowController('video-skill'); await controller.load();
    const agent = { ...newWorkflowNode('agent', 0, 0, ''), id: 'video-agent', agentTransport: 'codex-cli', skill: 'hyperframes', prompt: '制作两秒标题动画',
      inputs: { image: originals.map(asset => ({ assetId: asset.id })) } };
    check(workflowOutputs(agent).some(port => port.label === '返回视频'), 'video output declared');
    let templateError;
    try { captureWorkflowTemplate([agent], new Set([agent.id]), '视频模板'); } catch (error) { templateError = error.message; }
    check(templateError?.includes('视频制作'), 'template export cannot silently lose the video skill');
    check(automaticInputMedia(agent).join() === 'image,video,audio', 'video skill accepts original media');
    check(videoFrameInputValues(agent, { image: [{ type: 'image', assetIds: ['movie'] }] }, []).length === 0, 'video references do not become last frames');
    await controller.edit([agent]); await controller.start(agent.id, true);
    check(controller.document.run.status === 'done', `video task completed: ${controller.issue?.message}`);
    const requestId = calls[0][0];
    check(controller.document.run.steps[agent.id].videoProjectPath === 'C:/isolated/project', 'editable project retained');
    check(window.snapshot().nodes.filter(node => node.id === `workflow-video:${requestId}`).length === 1, 'one video placed on canvas');
    const saved = structuredClone(controller.document);
    saved.nodes[0].skill = 'image-edit'; saved.nodes[0].agentTransport = 'cloud';
    saved.run.status = 'running'; saved.run.steps[agent.id].status = 'running';
    saved.runs = saved.runs.map(run => run.id === saved.run.id ? saved.run : run);
    sessionStorage.setItem('workflow-video-skill-recovery', JSON.stringify({ revision: 1, document: saved }));
    const recovered = new CanvasWorkflowController('video-skill-recovery'); await recovered.load(); await recovered.continue();
    check(calls.length === 1 && recovered.document.run.status === 'done', 'recovery only retrieves original request');
    check(window.snapshot().nodes.filter(node => node.id === `workflow-video:${requestId}`).length === 1, 'recovery does not duplicate canvas output');
    await controller.start(agent.id, true);
    check(calls.length === 2 && calls[0][5].nodeId === calls[1][5].nodeId && calls[1][8] === false, 'follow-up retains card project and session');
    failure = true; await controller.start(agent.id, true);
    check(controller.document.run.status === 'failed' && controller.issue.message.includes('视频渲染失败'), 'failed render does not produce a successful task');
    failure = false; hold = true;
    const running = controller.start(agent.id, true);
    while (calls.length < 4) await new Promise(resolve => setTimeout(resolve, 10));
    await controller.stop(); await running; hold = false;
    check(cancelled.includes(calls[3][0]) && controller.document.run.status === 'stopped', 'stop cancels the exact video request');
    check(!window.snapshot().nodes.some(node => node.id === `workflow-video:${calls[3][0]}`), 'stopped request creates no video card');
    const ordinary = new CanvasWorkflowController('video-skill-text-regression'); await ordinary.load();
    await ordinary.edit([{ ...agent, id: 'ordinary-agent', skill: 'image-edit', inputs: {}, prompt: '分析并返回图文' }]);
    await ordinary.start('ordinary-agent', true);
    const step = ordinary.document.run.steps['ordinary-agent'];
    check(ordinary.document.run.status === 'done' && !step.videoProjectPath && !step.localAgentSkill, 'ordinary Codex keeps its original protocol');
    check(ordinary.document.nodes[0].outputs.text.text === '原有图文处理' && ordinary.document.nodes[0].outputs.image.assetIds[0] === 'a', 'ordinary text and image delivery unchanged');
  });
  await page.getByRole('combobox', { name: 'Agent 执行引擎' }).click();
  await page.getByRole('option', { name: 'Cloud DSH · 文本改写', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Agent 制作能力' }).count(), 0);
  console.log('PASS video skill selection, original media, delivery, recovery and follow-up');
} finally { await browser.close(); await server.close(); }
