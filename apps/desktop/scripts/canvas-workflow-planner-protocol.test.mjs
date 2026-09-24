import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1607, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:1607/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const result = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { newWorkflowNode, workflowOrder } = await import('/src/lib/canvasWorkflow.ts');
    const { buildWorkflowPlan, canResumeWorkflowPlanning, planningSnapshotKey, samePlanningContext } = await import('/src/lib/workflowPlanner.ts');
    const { WorkflowPlannerRuntime } = await import('/src/lib/workflowPlannerRuntime.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    let checks = 0;
    const check = (value, message) => { checks++; if (!value) throw Error(message); };
    const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
    const owner = { ...newWorkflowNode('planner', 0, 0, 'codex'), id: 'assistant', prompt: '按四张版式替换产品，填入提供的文案' };
    const source = (id, extra = {}) => ({ id, type: 'image', input: { assetId: id }, label: id, ...extra });
    const sources = [source('source1'), ...[1, 2, 3, 4].map(i => source(`source1_cell${i}`, { parentId: 'source1' })), source('source2'), source('source3')];
    const spec = { schemaVersion: 2, summary: '分别保留四页版式，替换产品，填入原文案',
      sourceUses: [{ source: 'source1', role: 'layout', mode: 'each' }, { source: 'source2', role: 'subject', mode: 'shared' }, { source: 'source3', role: 'copy', mode: 'shared' }],
      nodes: [{ id: 'copy', kind: 'instruction', action: 'describe', prompt: '逐字提取文案，不改写', inputs: { image: ['source3.image'] } },
        ...[1, 2, 3, 4].map(i => ({ id: `page${i}`, kind: 'generation', prompt: `保留 {{source1_cell${i}.image}} 的版式，产品为 {{source2.image}}，忠实填入 {{copy.text}}。`, ratio: '9:16' }))],
      outputs: [1, 2, 3, 4].map(i => ({ node: `page${i}`, label: `第${i}页`, forSource: `source1_cell${i}` })) };
    const build = plan => buildWorkflowPlan(JSON.stringify(plan), owner, sources, [owner]);
    const built = build(spec);
    check(built.nodes.length === 6 && built.nodes[0].kind === 'trigger', 'compiler creates one trigger plus five useful work cards');
    check(workflowOrder(built.nodes, built.nodes[0].id).length === 6, 'all dependency branches run through existing scheduler');
    check(built.nodes.slice(2).every(node => node.inputs.image.length === 2 && node.inputs.text.length === 1 && node.promptReferences.length === 3), 'prompt alone compiles all typed data edges and references');
    check(built.summary.includes('交付 4 份') && built.summary.includes('逐份处理'), 'reviewable source roles and output counts');
    const bad = [
      [p => { p.nodes.push({ id: 'unused', kind: 'instruction', inputs: { image: ['source2.image'] } }); }, 'unused'],
      [p => { p.nodes.pop(); p.outputs.pop(); }, 'source1_cell4'],
      [p => { p.nodes[1].prompt = p.nodes[1].prompt.replace('{{source1_cell1.image}}', '{{source1.image}}'); }, 'source1_cell1'],
      [p => { p.nodes[1].prompt = p.nodes[1].prompt.replace('{{source2.image}}', '紫心宝螺'); }, '产品'],
      [p => { p.nodes[1].prompt = p.nodes[1].prompt.replace('{{copy.text}}', '自编文案'); }, '文案'],
      [p => { p.sourceUses.pop(); }, 'source3'],
      [p => { p.outputs.push(p.outputs[0]); }, '不同'],
      [p => { p.nodes[1].inputs = { image: ['source2.image'] }; }, '重复'],
      [p => { p.edges = []; }, '字段'],
      [p => { p.nodes[1].prompt += '{{unknown.image}}'; }, '未知'],
      [p => { p.nodes[0].inputs = { image: ['page1.image'] }; }, '来源'],
    ];
    for (const [mutate, expected] of bad) {
      const copy = structuredClone(spec); mutate(copy); let error = '';
      try { build(copy); } catch (reason) { error = String(reason); }
      check(error.includes(expected), `invalid spec rejected (${expected}): ${error}`);
    }
    const repeated = structuredClone(spec); repeated.nodes[1].prompt += '再次核对 {{source2.image}}';
    check(build(repeated).nodes[2].inputs.image.length === 2, 'repeated mentions do not duplicate edges');
    const realDefects = structuredClone(spec);
    realDefects.nodes.push({ id: 'profile', kind: 'visual-profile', prompt: '按照 {{copy.text}} 制定规范', inputs: { image: ['source2.image'] } });
    let diagnostics = ''; try { build(realDefects); } catch (error) { diagnostics = String(error); }
    check(diagnostics.includes('不支持占位符') && diagnostics.includes('未用于任何最终交付'), 'one validation reports both defects from the actual second proposal');
    realDefects.nodes[0].inputs = undefined;
    realDefects.nodes[1].inputs = { image: ['source1_cell1.image'] };
    realDefects.nodes[1].prompt += '{{原图}}';
    try { build(realDefects); } catch (error) { diagnostics = String(error); }
    check(['缺少图片来源', '移除重复 inputs', '原图', '不支持占位符', '未用于任何最终交付'].every(issue => diagnostics.includes(issue)), 'independent card errors are returned together instead of using one repair revision each');

    const simple = { schemaVersion: 2, summary: '一张海报', sourceUses: [], nodes: [{ id: 'draw', kind: 'generation', prompt: '春日海报' }], outputs: [{ node: 'draw', label: '海报' }] };
    const text = JSON.stringify(simple);
    let reply = null, feedback = [], sent = 0, failFeedback = false;
    api.agentDsWorkflowStart = async () => { sent++; return { path: 'pending', autoDelivered: false }; };
    api.agentDsWorkflowResult = async requestId => reply && { requestId, ...reply };
    api.agentDsWorkflowFeedback = async (requestId, revision, text, error) => {
      if (failFeedback) throw Error('feedback disk busy');
      const digest = await hash(text); feedback.push({ requestId, revision, text, error, digest }); return digest;
    };
    const create = async name => {
      const host = new CanvasWorkflowController(name); await host.load(); await host.edit([owner]); await host.planner.start(owner.id); return host;
    };
    const state = host => host.document.nodes[0].planning;
    const collect = async host => { try { await host.planner.collect(owner.id); } catch {} };
    const proposal = (text, revision = 1) => ({ schemaVersion: 2, phase: 'proposal', revision, text });
    const commit = async (text, revision = 1) => ({ schemaVersion: 2, phase: 'commit', revision, text, digest: await hash(text) });
    const c = await create('protocol-repair');
    const broken = JSON.stringify({ ...simple, nodes: [...simple.nodes, { id: 'unused', kind: 'generation', prompt: '无用支线' }] });
    reply = proposal(broken); await collect(c);
    check(state(c).status === 'waiting' && feedback.at(-1).error.includes('unused') && c.document.nodes.length === 1, 'invalid first draft reports concrete feedback without terminal failure');
    reply = proposal(text, 2); await collect(c);
    check(state(c).status === 'waiting' && !feedback.at(-1).error && c.document.nodes.length === 1, 'valid revision is a draft until commit');
    const restored = new CanvasWorkflowController('protocol-repair'); await restored.load();
    check(state(restored).proposal.digest === await hash(text), 'validated revision survives reload');
    reply = await commit(text, 2); await collect(restored); await collect(restored);
    check(state(restored).status === 'applied' && restored.document.nodes.length === 3 && sent === 1, 'commit applies once after reload without resubmission');
    check(!restored.document.run, 'compiler never executes paid tasks');

    const premature = await create('protocol-premature'); reply = await commit(text); await collect(premature);
    check(state(premature).status === 'failed' && premature.document.nodes.length === 1, 'first visible final file cannot bypass validation');
    const changed = await create('protocol-mutated'); reply = proposal(text); await collect(changed);
    reply = await commit(text.replace('春日', '夏日')); await collect(changed);
    check(state(changed).status === 'failed' && changed.document.nodes.length === 1, 'commit body and digest must match validated content');
    const immutable = await create('protocol-immutable'); reply = proposal(broken); await collect(immutable);
    const originalProposal = structuredClone(state(immutable).proposal);
    reply = proposal(text); await collect(immutable);
    check(state(immutable).status === 'waiting' && feedback.at(-1).error.includes('revision:2'), 'overwritten draft receives repair guidance instead of terminating request');
    check(JSON.stringify(state(immutable).proposal) === JSON.stringify(originalProposal), 'rejected overwrite cannot replace validated content');
    const restoredOverwrite = new CanvasWorkflowController('protocol-immutable'); await restoredOverwrite.load();
    reply = proposal(text, 2); await collect(restoredOverwrite); reply = await commit(text, 2); await collect(restoredOverwrite);
    check(state(restoredOverwrite).status === 'applied', 'revision 2 is accepted after overwrite feedback and reload');
    const overwriteCommit = await create('protocol-overwrite-commit'); reply = proposal(broken); await collect(overwriteCommit);
    reply = proposal(text); await collect(overwriteCommit); reply = await commit(text); await collect(overwriteCommit);
    check(state(overwriteCommit).status === 'failed' && overwriteCommit.document.nodes.length === 1, 'rejected overwrite cannot be committed using its feedback digest');
    const oldFailure = await create('protocol-old-overwrite'); reply = proposal(broken); await collect(oldFailure);
    await oldFailure.edit(oldFailure.document.nodes.map(node => ({ ...node, planning: { ...node.planning, status: 'failed', error: 'Error: 同一草稿版本被改写，请递增 revision 后重新提交' } })));
    check(canResumeWorkflowPlanning(state(oldFailure)), 'persisted failure from previous receiver exposes retrieval');
    reply = proposal(text, 2); const sendsBeforeRecovery = sent; await collect(oldFailure);
    check(state(oldFailure).status === 'waiting' && state(oldFailure).proposal.revision === 2 && sent === sendsBeforeRecovery, 'actual old failure resumes revision 2 on same request without resubmission');
    reply = await commit(text, 2); await collect(oldFailure);
    check(state(oldFailure).status === 'applied', 'recovered request still requires validated final commit');
    const skipped = await create('protocol-skipped'); reply = proposal(text, 3); await collect(skipped);
    check(state(skipped).status === 'waiting' && !state(skipped).proposal && feedback.at(-1).error.includes('revision:1'), 'skipped revision gets feedback without consuming a validation slot');
    reply = proposal(text); await collect(skipped); reply = await commit(text); await collect(skipped);
    check(state(skipped).status === 'applied', 'agent can recover from skipped revision');
    const bounded = await create('protocol-bounded');
    for (let revision = 1; revision <= 3; revision++) { reply = proposal(broken, revision); await collect(bounded); }
    check(state(bounded).status === 'failed' && feedback.at(-1).revision === 3 && bounded.document.nodes.length === 1, 'repair budget ends after three invalid proposals');
    check(!canResumeWorkflowPlanning(state(bounded)), 'exhausted repair budget is not silently reset by retrieval');
    const cancelled = await create('protocol-cancel'); reply = proposal(text); await collect(cancelled);
    await cancelled.planner.cancel(owner.id); reply = await commit(text); await collect(cancelled);
    check(state(cancelled).status === 'cancelled' && cancelled.document.nodes.length === 1, 'cancel ignores late committed files');
    const stale = await create('protocol-context'); reply = proposal(text); await collect(stale);
    await stale.edit(stale.document.nodes.map(node => ({ ...node, prompt: '新的需求' }))); reply = await commit(text); await collect(stale);
    check(state(stale).status === 'failed' && stale.document.nodes.length === 1, 'commit rechecks current requirements');
    const transient = await create('protocol-feedback'); reply = proposal(text); failFeedback = true; await collect(transient);
    check(state(transient).status === 'waiting' && transient.document.nodes.length === 1, 'feedback I/O failure remains recoverable');
    failFeedback = false; await collect(transient); reply = await commit(text); await collect(transient);
    check(state(transient).status === 'applied', 'retry resumes same validated draft');
    const saving = await create('protocol-save'); reply = proposal(text); await collect(saving);
    reply = await commit(text); window.failWorkflowSave = true; await collect(saving); window.failWorkflowSave = false;
    check(!!saving.error && saving.document.nodes.length === 3 && state(saving).status === 'applied', 'failed atomic save retains batch and applied identity');
    await saving.retrySave(); await collect(saving);
    check(!saving.error && saving.document.nodes.length === 3, 'retry save cannot duplicate cards');
    const legacy = await create('protocol-legacy');
    await legacy.edit(legacy.document.nodes.map(node => ({ ...node, planning: { ...node.planning, protocolVersion: undefined, status: 'failed', error: 'missing c3.text' } })));
    reply = { schemaVersion: 1, text: JSON.stringify({ summary: '修订后的旧方案', nodes: [{ id: 'start', kind: 'trigger' }, { id: 'draw', kind: 'generation', prompt: '海报' }], edges: [{ from: 'start', output: 'signal', to: 'draw', input: 'signal' }] }) };
    const before = sent; await collect(legacy);
    check(state(legacy).status === 'applied' && sent === before, 'legacy failed request retrieves corrected reply without a new model call');
    check(feedback.every(item => item.requestId && item.digest.length === 64), 'feedback is correlated and content addressed');
    const race = new CanvasWorkflowController('protocol-delivery-race'); await race.load(); await race.edit([owner]);
    let delivered;
    api.agentDsWorkflowStart = () => new Promise(resolve => { delivered = resolve; });
    const starting = race.planner.start(owner.id);
    while (!delivered) await new Promise(resolve => setTimeout(resolve, 10));
    reply = proposal(text); await collect(race);
    delivered({ path: 'pending', autoDelivered: false }); await starting;
    check(state(race).proposal?.digest === await hash(text), 'late delivery receipt cannot erase a validated proposal');
    reply = await commit(text); await collect(race);
    check(state(race).status === 'applied', 'validated proposal still commits after late delivery receipt');
    api.agentDsWorkflowStart = async () => { sent++; return { path: 'pending', autoDelivered: false }; };
    const racingFeedback = await create('protocol-feedback-race');
    const readReply = api.agentDsWorkflowResult, writeFeedback = api.agentDsWorkflowFeedback;
    let firstRead = true, firstFeedback = true;
    reply = proposal(broken);
    api.agentDsWorkflowResult = async id => { if (firstRead) { firstRead = false; throw Error('result temporarily unavailable'); } return readReply(id); };
    api.agentDsWorkflowFeedback = async (...args) => {
      if (firstFeedback) { firstFeedback = false; reply = proposal(text, 2); throw Error('编排草稿已变化，请重新取回'); }
      const digest = await writeFeedback(...args); reply = await commit(text, 2); return digest;
    };
    const sentBeforeRace = sent; await racingFeedback.planner.collect(owner.id, true);
    check(state(racingFeedback).status === 'applied' && sent === sentBeforeRace, 'automatic receiver survives read failure and proposal replacement during feedback without manual retry or redelivery');
    api.agentDsWorkflowResult = readReply; api.agentDsWorkflowFeedback = writeFeedback;
    const roundTrip = await create('protocol-rust-json'); await roundTrip.planner.cancel(owner.id);
    await roundTrip.edit([{ ...owner, inputs: { image: [{ assetId: 'existing', assetNodeId: 'old' }], text: [] } }]);
    await roundTrip.planner.start(owner.id);
    const persistedOwner = roundTrip.document.nodes[0];
    persistedOwner.planning.contextKey = JSON.stringify([persistedOwner.prompt, persistedOwner.provider, persistedOwner.inputs]);
    // Simulate serde_json::Value serialization, preserving the old unsorted contextKey string.
    await roundTrip.edit(JSON.parse(planningSnapshotKey(roundTrip.document.nodes)));
    const restoredJson = new CanvasWorkflowController('protocol-rust-json'); await restoredJson.load();
    const withSource = { ...simple, sourceUses: [{ source: 'source1', role: 'subject', mode: 'shared' }], nodes: [{ id: 'draw', kind: 'generation', prompt: '产品参考 {{source1.image}}' }] };
    const sourceText = JSON.stringify(withSource);
    reply = proposal(sourceText); await collect(restoredJson);
    check(state(restoredJson).status === 'waiting' && !state(restoredJson).proposal.error, 'Rust JSON key ordering and legacy context string do not invalidate unchanged inputs or source snapshots');
    reply = await commit(sourceText); await collect(restoredJson);
    check(state(restoredJson).status === 'applied', 'restored source-bound request commits after real serialization boundary');
    check(!samePlanningContext('[{"a":1}]', '[{"a":2}]') && !samePlanningContext('[1,2]', '[2,1]') && !samePlanningContext('broken', 'broken'), 'canonical comparison still rejects changed values, source order and malformed snapshots');
    return { checks, feedback: feedback.length };
  });
  assert.ok(result.checks >= 30);
  console.log('declarative planner + two-phase protocol:', result);
} finally { await browser.close(); await server.close(); }
