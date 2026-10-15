import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1658, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1658/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  console.log(await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController, canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode, workflowInputValues } = await import('/src/lib/canvasWorkflow.ts');
    const { cloudAgentProfilePrompt } = await import('/src/lib/workflowAgentProfile.ts');
    const { useStore } = await import('/src/store.ts');
    const check = (ok, why) => { if (!ok) throw Error(why); };
    const profile = { id: 'profile', name: '蓝色系列', version: 2, status: 'confirmed', summary: '蓝色留白', sourceAssetIds: [], sourceCount: 0, sourceScopeHash: 'frozen', rules: [
      { category: 'palette', value: '使用蓝色', polarity: 'must' },
      { category: 'layout', value: '宽松留白', polarity: 'prefer' },
      { category: 'mood', value: '杂乱', polarity: 'avoid' },
    ], contentThemes: [{ value: '茶具主题' }], conflicts: [], candidateDirections: [] };
    const spec = () => ({ ...newWorkflowNode('visual-profile', 150, 150, ''), id: 'spec', profileId: profile.id, outputs: { 'visual-profile': { type: 'visual-profile', profileId: profile.id, version: 2 } } });
    const agent = transport => ({ ...newWorkflowNode('agent', 650, 150, ''), id: 'agent', agentTransport: transport, prompt: '本次用红色，写海报文案', inputs: { 'visual-profile': [{ nodeId: 'spec', portId: 'visual-profile' }] } });
    const requests = new Map(), replies = new Set();
    let c, deliveries = 0, reads = 0, images = 0, legacy = false, failReply = false, generate = true, lastSelection;
    api.visualProfileGet = async () => { reads++; return structuredClone(profile); };
    api.visualProfileList = async () => [profile];
    api.agentDsWorkflowStart = async (...args) => {
      deliveries++; lastSelection = args[10];
      check(lastSelection?.profileId === c.document.run.steps.agent.agentInput.visualProfile?.id, 'selection matches frozen snapshot before submission');
      if (legacy) c.document.run.steps.agent.localDsGenerationMode = undefined;
      requests.set(args[0], { id: crypto.randomUUID(), prompt: '画海报', images: [] });
      return { autoDelivered: true, path: 'synthetic' };
    };
    api.agentDsWorkflowGenerationRequest = async id => generate && !replies.has(id) ? requests.get(id) : null;
    api.agentDsWorkflowGenerationResponse = async id => { if (failReply) { failReply = false; throw Error('模拟回复中断'); } replies.add(id); };
    api.agentDsWorkflowResult = async id => ({ schemaVersion: 1, requestId: id, text: '海报文案' });
    api.agentDsWorkflowProgress = async () => [];
    api.agentDsWorkflowGenerationJob = async () => ({ status: 'done', images: ['/tmp/output.png'] });
    api.codexCreateImage = async args => { images++; check(args.visualProfileId === 'profile', 'legacy generation inherits profile'); };
    useStore.setState({ defaultProvider: 'jimeng', cloudAuth: { logged_in: true, user_id: 'test' }, cloudEntitlement: { user_id: 'test', is_test_account: true, balances: { daily: 100, sub: 0, topup: 0 }, policy: { can_use_byo: true, can_use_visual_profiles: true, can_use_agent_runs: true, max_parallel_agent_runs: 4, allowed_agent_skills: ['bowerbird-unified-agent'], agent_budget_options: [1] } },
      startGeneration: async (...args) => { images++; check(args[8] === 'profile', 'ordinary generation inherits profile'); return { accepted: true }; } });
    const setup = async transport => {
      c = new CanvasWorkflowController('profile-' + crypto.randomUUID()); await c.load();
      const a = agent(transport), nodes = [a, spec()];
      if (transport === 'cloud') {
        const input = { nodeId: 'source', portId: 'text' };
        a.inputs.text = [input]; a.prompt += '，改写 @[original]';
        a.promptReferences = [{ id: 'original', type: 'text', input, label: '原文' }];
        nodes.push({ ...newWorkflowNode('text', 0, 0, ''), id: 'source', outputs: { text: { type: 'text', text: '夏日产品介绍' } } });
      }
      await c.edit(nodes);
    };
    for (const transport of ['codex-cli', 'local-ds']) for (const mode of [false, true]) {
      legacy = mode; await setup(transport); await c.start('agent', true);
      check(c.document.run.status === 'done', JSON.stringify(c.issue));
      check(lastSelection.version === 2 && c.document.run.steps.agent.agentInput.visualProfile.name === '蓝色系列', 'exact version frozen');
    }
    legacy = false; await setup('codex-cli'); failReply = true; await c.start('agent', true);
    check(c.document.run.status === 'waiting', 'interruption parks request');
    const before = [deliveries, reads, images]; profile.status = 'archived'; profile.rules[0].value = '后来改动';
    c = new CanvasWorkflowController(c.projectId); await c.load(); await c.continue();
    check(c.document.run.status === 'done' && JSON.stringify(before) === JSON.stringify([deliveries, reads, images]), 'recovery uses original request without profile fetch or model/image resubmission');
    check(c.document.run.steps.agent.agentInput.visualProfile.rules[0].value === '使用蓝色', 'history keeps original rules');
    generate = false;
    for (const invalid of [{ status: 'draft', version: 2 }, { status: 'confirmed', version: 3 }, { status: 'archived', version: 2 }]) {
      Object.assign(profile, invalid); await setup('codex-cli'); const count = deliveries; await c.start('agent', true);
      check(c.document.run.status !== 'done' && deliveries === count, 'invalid profile blocks before model call');
    }
    Object.assign(profile, { status: 'confirmed', version: 2 }); profile.rules[0].value = '使用蓝色';
    await setup('codex-cli'); await c.start('agent', true);
    await c.edit(c.document.nodes.map(node => node.id === 'agent' ? { ...node, inputs: {} } : node)); await c.start('agent', true);
    check(c.document.run.status === 'done' && lastSelection === undefined && c.document.run.steps.agent.agentInput.visualProfile === null, 'disconnect clears selection on next run');
    let cloudCalls = 0, cloudInput;
    api.cloudAgentStart = async args => { cloudCalls++; cloudInput = args; return { runId: 'cloud-test' }; };
    api.cloudAgentGet = async () => ({ runId: 'cloud-test', status: 'succeeded', snapshot: { events: [{ type: 'text.result', display_payload: { schemaVersion: 1, text: '云端文案' } }] } });
    useStore.setState({ openCloudAgentRun: () => {} });
    await setup('cloud'); await c.start('agent', true);
    check(c.document.run.status === 'done' && cloudCalls === 1, JSON.stringify(c.issue));
    for (const text of ['使用蓝色', '宽松留白', '必须避免：mood=杂乱', '以本次要求为准', '只读']) check(cloudInput.intentPrompt.includes(text), 'cloud instruction includes ' + text);
    check(!cloudInput.intentPrompt.includes('茶具主题') && !cloudInput.textRewrite.source.includes('使用蓝色') && !cloudInput.visualProfileId, 'rules distinct from source; existing cloud text protocol');
    check(cloudAgentProfilePrompt('原要求', null) === '原要求', 'no profile preserves original cloud task');
    profile.rules[0].value = '蓝'.repeat(4000); await setup('cloud'); await c.start('agent', true);
    check(cloudCalls === 1 && c.document.run.status !== 'done', 'oversized instructions fail before cloud submission'); profile.rules[0].value = '使用蓝色';
    const entitlement = useStore.getState().cloudEntitlement;
    useStore.setState({ cloudEntitlement: { ...entitlement, policy: { ...entitlement.policy, can_use_visual_profiles: false } } });
    await setup('cloud'); await c.start('agent', true);
    check(cloudCalls === 1 && c.document.run.status !== 'done', 'existing visual-profile entitlement still applies');
    useStore.setState({ cloudEntitlement: entitlement });
    const duplicate = agent('codex-cli'); duplicate.inputs['visual-profile'].push({ nodeId: 'spec', portId: 'visual-profile' });
    let rejected = false; try { workflowInputValues([duplicate, spec()], duplicate); } catch { rejected = true; } check(rejected, 'single-profile socket');
    for (const node of window.snapshot().nodes) if (node.id !== 'old') await api.projectCanvasNodeRemove(node.id);
    window.emitChange();
    c = canvasWorkflowController('p'); await c.load(); await c.edit([{ ...agent('codex-cli'), inputs: {} }, spec()]);
    window.profileTestRun = async () => { await c.start('agent', true); window.save(); };
    return { deliveries, images, cloudCalls, recovery: 'frozen', invalidProfiles: 'blocked' };
  }));
  assert.deepEqual(errors, []);
  const agent = page.locator('.workflow-card.is-agent'), profile = page.locator('.workflow-card.is-visual-profile');
  await page.getByRole('button', { name: '收起画板素材库', exact: true }).click();
  await page.getByRole('button', { name: '适应内容', exact: true }).click();
  await profile.getByLabel('输出：视觉规范', { exact: true }).click();
  await agent.getByLabel('输入：视觉规范', { exact: true }).click();
  await page.evaluate(async () => { const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts'); const a = canvasWorkflowController('p').document.nodes.find(n => n.id === 'agent'); if (a.inputs['visual-profile'][0].nodeId !== 'spec') throw Error('wire missing'); await window.profileTestRun(); });
  await agent.getByRole('button', { name: '查看 Agent 详情' }).click();
  const detail = page.getByRole('region', { name: '本次视觉规范' });
  await detail.waitFor(); assert.match(await detail.innerText(), /蓝色系列.*v2/); assert.match(await detail.innerText(), /使用蓝色/);
  await page.reload();
  await page.evaluate(async () => { const { api } = await import('/src/lib/api.ts'); api.agentDsWorkflowProgress = async () => []; });
  await page.locator('.workflow-card.is-agent').getByRole('button', { name: '查看 Agent 详情' }).click();
  await page.getByRole('region', { name: '本次视觉规范' }).waitFor();
  assert.match(await page.getByRole('region', { name: '本次视觉规范' }).innerText(), /使用蓝色/);
  assert.deepEqual(errors, []);
  console.log('PASS Agent visual profile: socket, routing, all local transports/generation modes, Cloud rules, immutable recovery, invalid versions, disconnect and detail reload');
} catch (error) { console.error(errors); await page.screenshot({ path: '/tmp/agent-profile-test.png' }); throw error; }
finally { await browser.close(); await server.close(); }
