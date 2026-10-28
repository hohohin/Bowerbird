import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: '.tmp/workflow-pipe-recovery-vite', server: { host: '127.0.0.1', port: 1693, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1693/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  console.log(await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode, compileGenerationPrompt, generationInputNode, workflowInputValues } = await import('/src/lib/canvasWorkflow.ts');
    const { useStore } = await import('/src/store.ts');
    const check = (condition, message) => { if (!condition) throw Error(message); };
    let submissions = 0;
    useStore.setState({ startGeneration: async () => { submissions++; throw Error('recovery must not submit'); } });
    const queried = [];
    api.agentDsWorkflowGenerationJob = async (jobId, turnKey) => { queried.push([jobId, turnKey]); return { status: 'running', images: [] }; };
    api.recentGenSessions = async () => [{ id: 'legacy-job', status: 'done', turns: [{ turn_key: 'legacy-turn', images: ['saved.png'] }] }];
    api.localAgentFindAssetId = async () => 'existing';
    const sparse = id => {
      const inputs = [{ assetId: 'a', slot: 1 }, { assetId: 'c', slot: 3 }];
      return { ...newWorkflowNode('generation', 0, 0, 'codex'), id, inputs: { image: inputs }, prompt: '@[third]',
        promptReferences: [{ id: 'third', type: 'image', label: '图片来源 3', slot: 3, input: inputs[1] }] };
    };
    for (const mode of ['receipt', 'legacy']) {
      const projectId = `pipe-recovery-${mode}`, draw = sparse('draw'), idle = sparse('idle');
      const locked = { ...sparse('locked'), kind: 'agent', prompt: '@[third] @[output]', promptReferences: [
        ...sparse('locked').promptReferences, { id: 'output', direction: 'output', type: 'image', slot: 7, label: '输出位置', input: { nodeId: 'writer' } },
      ] };
      const run = { id: `run-${mode}`, startId: 'draw', threadId: 'thread', order: ['draw'], status: mode === 'receipt' ? 'running' : 'waiting',
        ...(mode === 'receipt' ? { lockedNodeIds: ['draw', 'locked'] } : {}),
        steps: { draw: { status: mode === 'receipt' ? 'running' : 'waiting', jobId: `${mode === 'receipt' ? 'receipt' : 'legacy'}-job`, turnKey: `${mode === 'receipt' ? 'receipt' : 'legacy'}-turn`, ...(mode === 'receipt' ? { generationSubmission: 'pending' } : {}) } } };
      const plannerInput = { assetId: 'c' };
      const planner = { ...newWorkflowNode('planner', 0, 0, 'codex'), id: 'planner', inputs: { image: [{ assetId: 'a' }, plannerInput] },
        prompt: '@[old-source]', promptReferences: [{ id: 'old-source', type: 'image', label: '图片 3.1', assetId: 'c', input: plannerInput }],
        planning: { requestId: 'old-plan', status: 'waiting', contextKey: 'old-context', sources: [] } };
      sessionStorage.setItem(`workflow-${projectId}`, JSON.stringify({ revision: 1, document: { schema_version: 1, nodes: [draw, idle, locked, planner], runs: [run], run } }));
      let controller = new CanvasWorkflowController(projectId); await controller.load();
      check(controller.ready && !controller.error, controller.error);
      const current = controller.document.nodes.find(node => node.id === 'draw');
      check(current.inputs.image.map(input => input.slot).join() === '1,2', 'in-flight inputs migrate to contiguous numbers');
      check(current.promptReferences[0].slot === 2 && current.promptReferences[0].input.assetId === 'c', 'in-flight reference retains the submitted source when slot 3 becomes position 2');
      check(compileGenerationPrompt(current, workflowInputValues([], generationInputNode(current))).assetIds.join() === 'c', 'recovery compiles the original material');
      check(controller.document.nodes.find(node => node.id === 'idle').promptReferences[0].slot === 3, 'idle cards follow current pipe positions without preserving removed slot identities');
      if (mode === 'receipt') {
        const restored = controller.document.nodes.find(node => node.id === 'locked');
        check(restored.promptReferences[0].slot === 2, 'locked dependencies retain in-flight source meanings');
        check(restored.promptReferences[1].slot === 7 && restored.promptReferences[1].input.nodeId === 'writer', 'Agent output references are not input pipes');
      }
      const restoredPlanner = controller.document.nodes.find(node => node.id === 'planner');
      check(restoredPlanner.promptReferences[0].input.assetId === 'c', 'legacy planner source identity is unchanged by workflow-run migration');
      await controller.continue();
      check(controller.document.run.status === 'done', `recovery failed: ${JSON.stringify(controller.issue ?? controller.document.run)}`);
      const output = controller.document.nodes.find(node => node.id === 'draw').outputs.image;
      check(mode === 'receipt' ? output.nodeIds?.[0] === 'gen-prompt:receipt-job:receipt-turn:0' : output.assetIds?.[0] === 'existing', 'original generation receipt or pixels recovered');
      controller = new CanvasWorkflowController(projectId); await controller.load(); await controller.continue();
      check(controller.document.nodes.find(node => node.id === 'draw').promptReferences[0].slot === 2, 'saved migration remains stable on reload');
    }
    check(submissions === 0 && JSON.stringify(queried) === JSON.stringify([['receipt-job', 'receipt-turn']]), 'recover only the original task without resubmission');
    return 'PASS sparse legacy pipe recovery: running/waiting saves, explicit/fallback locks, original receipt/pixels, idle semantics, output references and reload without resubmission';
  }));
  assert.deepEqual(errors, []);
} finally { await browser.close(); await server.close(); }
