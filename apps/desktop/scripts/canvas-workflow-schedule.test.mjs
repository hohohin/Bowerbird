import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

await mkdir('.tmp/workflow-schedule', { recursive: true });
const server = await createServer({ configFile: false, cacheDir: '.tmp/workflow-schedule/vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, server: { host: '127.0.0.1', port: 1697, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
try {
  await page.goto('http://127.0.0.1:1697/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const result = await page.evaluate(async () => {
    const { CanvasWorkflowController, canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { cloneCanvasClipboard } = await import('/src/lib/canvasClipboard.ts');
    const { api } = await import('/src/lib/api.ts');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('workflow did not settle'); };
    const originalNow = Date.now;
    let now = Date.now() + 3600000;
    Date.now = () => now;
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'tester' }, cloudEntitlement: { user_id: 'tester', tier: 'pro', offline_state: 'fresh', is_test_account: true, balances: { daily: 0, sub: 0, topup: 0 }, policy: { can_use_cloud: true, can_use_byo: true }, generation_services: [] } });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const video = { id: 'timer-video', name: '合成视频', store_path: '/synthetic-timer.mp4', ext: 'mp4', width: 672, height: 1216, duration: 8 };
    let calls = 0, deny = false, failSave = false;
    const snapshots = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'canvas_workflow_authorize' && deny) throw new Error('工作流运行需要 Pro');
      if (command === 'canvas_workflow_save') {
        if (failSave) throw new Error('模拟保存失败');
        snapshots.push(structuredClone(args.document));
      }
      if (command === 'comfy_video_environment') return { phase: 'ready', endpoint: 'http://127.0.0.1:8000', message: '合成环境' };
      if (command === 'comfy_video') { if (args.action === 'start') calls++; return { status: 'done', asset: video }; }
      if (command === 'get_assets_by_ids') return [...await invoke(command, args), ...(args.assetIds.includes(video.id) ? [video] : [])];
      return invoke(command, args);
    };
    const controllers = [];
    const make = async (project, delta = 60000) => {
      const c = project === 'p' ? canvasWorkflowController(project) : new CanvasWorkflowController(project);
      controllers.push(c); await c.load();
      const trigger = { ...newWorkflowNode('trigger', 110, 140, 'codex'), id: 'timer', triggerCount: 3,
        triggerSchedule: { id: crypto.randomUUID(), at: now + delta, status: 'armed' } };
      const child = { ...newWorkflowNode('comfy-video', 520, 140, 'codex'), id: 'child', prompt: '合成测试', inputs: { 'first-frame': [{ assetId: 'existing' }], signal: [{ nodeId: 'timer', portId: 'signal' }] } };
      await c.edit([trigger, child]); return c;
    };
    try {
      const c = await make('timed');
      await c.checkScheduledTriggers(); check(calls === 0 && c.document.run === null, 'future appointment must not run early');
      const before = structuredClone(c.document.nodes);
      now += 60000;
      await Promise.all([c.checkScheduledTriggers(), c.checkScheduledTriggers(), c.checkScheduledTriggers()]);
      await until(() => c.document.run?.status === 'done');
      check(calls === 1 && c.document.nodes[0].triggerSchedule.status === 'fired', 'one due event starts exactly one downstream request');
      check(c.document.nodes[0].triggerCount === 3, 'timer does not consume completion-loop quota');
      const checkpoint = snapshots.find(doc => doc.run?.scheduleId === before[0].triggerSchedule.id);
      check(checkpoint?.nodes[0].triggerSchedule.status === 'fired' && checkpoint.run.steps.child.status === 'pending', 'run and appointment are durable before provider submission');
      await c.edit(before); await c.checkScheduledTriggers(); check(calls === 1 && c.document.nodes[0].triggerSchedule.status === 'fired', 'undo does not rearm a consumed appointment');
      const reloaded = new CanvasWorkflowController('timed'); controllers.push(reloaded); await reloaded.load(); await reloaded.checkScheduledTriggers();
      check(calls === 1, 'restored consumed appointment does not submit again');

      const cancelled = await make('cancelled');
      await cancelled.edit(cancelled.document.nodes.map(node => ({ ...node, triggerSchedule: undefined })));
      now += 60000; await cancelled.checkScheduledTriggers(); check(calls === 1, 'cancelled appointment never runs');
      const deleted = await make('deleted'); await deleted.edit([]); now += 60000; await deleted.checkScheduledTriggers(); check(calls === 1, 'deleted trigger never runs');

      const cold = await make('cold'); cold.setTriggerTimersEnabled(false);
      const coldDoc = structuredClone(cold.document); coldDoc.nodes[0].triggerSchedule.at = originalNow() - 3600000;
      await api.canvasWorkflowSave('cold', cold.revision, coldDoc);
      const restarted = new CanvasWorkflowController('cold'); controllers.push(restarted); await restarted.load(); await restarted.checkScheduledTriggers();
      check(calls === 1 && restarted.document.nodes[0].triggerSchedule.status === 'missed', 'closed-app deadline is marked missed, not replayed');

      const future = await make('future'); future.setTriggerTimersEnabled(false);
      const restored = new CanvasWorkflowController('future'); controllers.push(restored); await restored.load(); now += 60000;
      await restored.checkScheduledTriggers(); await until(() => restored.document.run?.status === 'done'); check(calls === 2, 'future persisted appointment survives reload');

      const locked = await make('locked');
      const busy = { id: 'busy', startId: 'child', threadId: 'busy-thread', order: ['child'], status: 'waiting', lockedNodeIds: ['child'], writeNodeIds: ['child'], steps: { child: { status: 'waiting' } } };
      await locked.save({ ...locked.document, runs: [busy], run: busy }); now += 60000;
      await locked.checkScheduledTriggers(); check(calls === 2 && locked.document.nodes[0].triggerSchedule.status === 'armed', 'conflicting flow leaves schedule pending');
      await locked.stop('busy'); await locked.checkScheduledTriggers(); await until(() => locked.document.run?.status === 'done'); check(calls === 3, 'pending schedule starts after lock released');

      const invalid = await make('invalid'); deny = true; now += 60000;
      await invalid.checkScheduledTriggers(); deny = false; await invalid.checkScheduledTriggers();
      check(calls === 3 && invalid.document.nodes[0].triggerSchedule.status === 'failed', 'authorization failure does not retry automatically');
      const badReload = new CanvasWorkflowController('invalid'); controllers.push(badReload); await badReload.load(); await badReload.checkScheduledTriggers(); check(calls === 3, 'failed appointment stays stopped after reload');

      const unsaved = await make('unsaved'); failSave = true; now += 60000; await unsaved.checkScheduledTriggers(); failSave = false;
      check(calls === 3 && unsaved.error, 'failed checkpoint never submits provider request');

      const copy = await make('copy');
      const clipboard = { schema_version: 1, projectId: 'copy', nodes: [], groups: [], items: [], workflow: copy.document.nodes, selection: ['timer', 'child'] };
      check(cloneCanvasClipboard(clipboard, 'p', 0, 0).workflow.every(node => !node.triggerSchedule), 'copy is not automatically armed');
      copy.setTriggerTimersEnabled(false);

      const background = await make('background'); background.setTriggerTimersEnabled(false);
      const archived = await make('archived'); archived.setTriggerTimersEnabled(false);
      const removed = await make('removed'); removed.setTriggerTimersEnabled(false);
      const { WorkflowScheduleCoordinator } = await import('/src/components/WorkflowScheduleCoordinator.tsx');
      const { default: React } = await import('/.tmp/workflow-schedule/vite/deps/react.js');
      const { default: { createRoot } } = await import('/.tmp/workflow-schedule/vite/deps/react-dom_client.js');
      const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
      const projects = window.store.getState().projects;
      window.store.setState({ projects: [...projects, { id: 'background', archived_at: null }, { id: 'removed', archived_at: null }, { id: 'archived', archived_at: 1 }] });
      root.render(React.createElement(WorkflowScheduleCoordinator));
      const observer = canvasWorkflowController('background');
      const removedObserver = canvasWorkflowController('removed');
      controllers.push(observer, removedObserver);
      await until(() => observer.ready && removedObserver.ready);
      window.store.setState({ projects: [...projects, { id: 'background', archived_at: null }, { id: 'archived', archived_at: 1 }] });
      await until(() => !removedObserver.triggerTimersEnabled);
      now += 60000;
      // Exercise the real timeout with the canvas still displaying project p.
      await until(() => observer.document.run?.status === 'done');
      check(calls === 4 && !canvasWorkflowController('archived').ready && removedObserver.document.run === null,
        `background project restores and fires, archived and removed projects do not: ${JSON.stringify({ calls, archived: canvasWorkflowController('archived').ready, removed: removedObserver.document.run })}`);
      // Use the real event listener and project controller, with a synthetic native claim and provider.
      const bridge = window.__TAURI_INTERNALS__.invoke;
      const receipts = new Map(), claimed = new Set();
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'local_chat_claim_card_run') {
          if (claimed.has(args.actionId)) return null;
          claimed.add(args.actionId);
          return ['background', 'child'];
        }
        if (command === 'plugin:event|emit' && args.event.startsWith('local-chat://run-result-')) receipts.set(args.event, args.payload);
        return bridge(command, args);
      };
      const startCard = action => bridge('plugin:event|emit', { event: 'local-chat://start-card', payload: action });
      await Promise.all([startCard('accepted'), startCard('accepted')]);
      await until(() => receipts.get('local-chat://run-result-accepted') === true && observer.document.run.status === 'done');
      check(calls === 5, 'a replayed Agent request submits the target exactly once');
      deny = true;
      await startCard('denied');
      await until(() => receipts.get('local-chat://run-result-denied') === false);
      check(calls === 5, 'failed authorization is reported without submitting');
      deny = false;
      window.__TAURI_INTERNALS__.invoke = bridge;
      root.unmount(); host.remove(); window.store.setState({ projects });

      const ui = await make('p');
      Date.now = originalNow;
      ui.setTriggerTimersEnabled(false);
      await ui.edit(ui.document.nodes.map(node => ({ ...node, triggerSchedule: undefined })));
      window.scheduleController = ui;
      return { calls, checkpoint: !!checkpoint };
    } finally { Date.now = originalNow; controllers.forEach(c => c.setTriggerTimersEnabled(false)); }
  });
  assert.deepEqual(result, { calls: 5, checkpoint: true });
  const dailyResult = await page.evaluate(async () => {
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { nextDailyTrigger } = await import('/src/lib/workflowTriggerSchedule.ts');
    const { api } = await import('/src/lib/api.ts');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('daily workflow did not settle'); };
    const originalNow = Date.now, invoke = window.__TAURI_INTERNALS__.invoke;
    let now = new Date(2030, 0, 1, 20, 59).getTime(), calls = 0, deny = false;
    Date.now = () => now;
    const checkpoints = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'canvas_workflow_authorize' && deny) throw new Error('工作流运行需要 Pro');
      if (command === 'comfy_video' && args.action === 'start') calls++;
      if (command === 'canvas_workflow_save') {
        // Match the native atomic-claim contract, including recovery of missed daily dates.
        const previous = JSON.parse(sessionStorage.getItem(`workflow-${args.projectId}`) || '{"document":{"nodes":[],"runs":[]}}').document;
        const oldRuns = previous.runs ?? (previous.run ? [previous.run] : []);
        for (const run of args.document.runs ?? (args.document.run ? [args.document.run] : [])) {
          if (!run.scheduleId || !['running', 'waiting'].includes(run.status) || oldRuns.some(old => old.id === run.id)) continue;
          const before = previous.nodes.find(node => node.id === run.startId)?.triggerSchedule;
          const after = args.document.nodes.find(node => node.id === run.startId)?.triggerSchedule;
          check(before?.dailyAt && run.scheduleId === `${before.id}@${before.at}` && after.id === before.id && after.dailyAt === before.dailyAt && after.status === 'armed' && after.at > before.at,
            'daily occurrence must be claimed from the persisted appointment and advanced atomically');
        }
        checkpoints.push(structuredClone(args.document));
      }
      return invoke(command, args);
    };
    const controllers = [];
    const make = async project => {
      const c = new CanvasWorkflowController(project); controllers.push(c); await c.load();
      const trigger = { ...newWorkflowNode('trigger', 0, 0, 'codex'), id: 'daily', triggerSchedule: { id: crypto.randomUUID(), dailyAt: '21:00', at: nextDailyTrigger('21:00', now), status: 'armed' } };
      const child = { ...newWorkflowNode('comfy-video', 500, 0, 'codex'), id: 'child', prompt: '合成测试', inputs: { 'first-frame': [{ assetId: 'existing' }], signal: [{ nodeId: 'daily', portId: 'signal' }] } };
      await c.edit([trigger, child]); return c;
    };
    try {
      const c = await make('daily-p'); const before = structuredClone(c.document.nodes);
      await c.checkScheduledTriggers(); check(calls === 0, 'daily trigger does not run early');
      now = new Date(2030, 0, 1, 21).getTime();
      await Promise.all([c.checkScheduledTriggers(), c.checkScheduledTriggers()]);
      await until(() => c.document.run?.status === 'done');
      check(calls === 1 && c.document.nodes[0].triggerSchedule.at === new Date(2030, 0, 2, 21).getTime(), 'day one arms tomorrow at 21:00');
      await c.edit(before); await c.checkScheduledTriggers();
      check(calls === 1 && c.document.nodes[0].triggerSchedule.status === 'armed', 'undo keeps the next daily occurrence');
      c.setTriggerTimersEnabled(false);
      const restored = new CanvasWorkflowController('daily-p'); controllers.push(restored); await restored.load();
      now = new Date(2030, 0, 2, 21).getTime(); await restored.checkScheduledTriggers();
      await until(() => restored.document.run?.status === 'done' && restored.document.runs.length === 2);
      check(calls === 2 && new Set(restored.document.runs.map(run => run.scheduleId)).size === 2, 'day two runs once under a distinct occurrence identity');
      now = new Date(2030, 0, 3, 21).getTime(); deny = true; await restored.checkScheduledTriggers(); deny = false;
      await restored.checkScheduledTriggers();
      check(calls === 2 && restored.document.nodes[0].triggerSchedule.at === new Date(2030, 0, 4, 21).getTime(), 'validation failure skips today without disabling tomorrow or retrying');
      now = new Date(2030, 0, 4, 21).getTime(); await restored.checkScheduledTriggers();
      await until(() => restored.document.run?.status === 'done' && restored.document.runs.length === 3);
      check(calls === 3, 'daily schedule continues after a prior failed occurrence');
      restored.setTriggerTimersEnabled(false);

      const cold = await make('daily-cold'); cold.setTriggerTimersEnabled(false);
      const old = structuredClone(cold.document); old.nodes[0].triggerSchedule.at = originalNow() - 86400000 * 3;
      await api.canvasWorkflowSave('daily-cold', cold.revision, old);
      const restarted = new CanvasWorkflowController('daily-cold'); controllers.push(restarted); await restarted.load();
      await restarted.checkScheduledTriggers(); check(calls === 3, 'restart does not catch up missed days');
      const next = new Date(2030, 0, 5, 21).getTime();
      check(restarted.document.nodes[0].triggerSchedule.at === next && JSON.parse(sessionStorage.getItem('workflow-daily-cold')).document.nodes[0].triggerSchedule.at === next,
        'restart persists the next occurrence before claiming it');
      now = next; await restarted.checkScheduledTriggers(); await until(() => restarted.document.run?.status === 'done');
      check(calls === 4, 'restarted daily schedule fires at the next 21:00');
      check(checkpoints.some(doc => doc.run?.scheduleId && doc.run.steps.child.status === 'pending' && doc.nodes[0].triggerSchedule.status === 'armed'), 'next appointment and pending run share a checkpoint');
      return calls;
    } finally { Date.now = originalNow; window.__TAURI_INTERNALS__.invoke = invoke; controllers.forEach(c => c.setTriggerTimersEnabled(false)); }
  });
  assert.equal(dailyResult, 4);
  // The real workflow layer owns the control and durable edit, not a UI-only mock.
  const trigger = page.locator('[data-workflow-card="timer"]');
  const modes = trigger.getByRole('combobox', { name: '触发方式' });
  const selectMode = async name => {
    await modes.click();
    assert.equal(await page.getByRole('listbox', { name: '触发方式' }).getByRole('option').count(), 4);
    await page.getByRole('option', { name, exact: true }).click();
  };
  const schedule = trigger.locator('.workflow-trigger-schedule');
  assert.equal(await modes.innerText(), '手动点击');
  assert.equal(await schedule.count(), 0);
  assert.equal(await trigger.getByLabel('剩余触发次数').count(), 0);
  assert.equal(await trigger.locator('.workflow-port.is-input').count(), 0);
  const compact = await trigger.boundingBox();
  assert.ok(compact.width < 180 && compact.height < 110, 'manual control gate stays compact at the fixture 90% zoom');
  await modes.press('Enter');
  await page.getByRole('listbox', { name: '触发方式' }).screenshot({ path: '.tmp/workflow-schedule/mode-menu.png' });
  await modes.press('Escape');
  assert.equal(await modes.getAttribute('aria-expanded'), 'false');
  assert.ok(await modes.evaluate(element => element === document.activeElement), 'closing the mode menu keeps keyboard focus');
  await trigger.screenshot({ path: '.tmp/workflow-schedule/manual.png' });
  await trigger.getByRole('button', { name: '触发下游', exact: true }).click();
  await page.waitForFunction(() => window.scheduleController.document.run?.status === 'done');
  await selectMode('上游完成');
  await trigger.getByLabel('剩余触发次数').waitFor();
  assert.equal(await trigger.getByRole('button', { name: '触发下游', exact: true }).count(), 0);
  assert.equal(await schedule.count(), 0);
  await trigger.screenshot({ path: '.tmp/workflow-schedule/completion.png' });
  const ports = await trigger.evaluate(card => {
    const rect = card.getBoundingClientRect();
    return ['input', 'output'].map(side => {
      const button = card.querySelector(`.workflow-port.is-${side}`), icon = button.querySelector('i').getBoundingClientRect();
      const x = icon.x + icon.width / 2, y = icon.y + icon.height / 2;
      return { offset: Math.abs(x - (side === 'input' ? rect.left : rect.right)), verticalOffset: Math.abs(y - rect.top - 46 * rect.width / 196), clickable: button.contains(document.elementFromPoint(x, y)) };
    });
  });
  assert.ok(ports.every(port => port.offset < 2 && port.verticalOffset < 2 && port.clickable), 'compact control gate preserves clickable sockets at both wire anchors');
  const completionCalls = await page.evaluate(async () => {
    const c = window.scheduleController, invoke = window.__TAURI_INTERNALS__.invoke;
    let calls = 0;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => { if (command === 'comfy_video' && args.action === 'start') calls++; return invoke(command, args); };
    try {
      await c.edit(c.document.nodes.map(node => node.id === 'timer' ? { ...node, triggerCount: 1, inputs: { completion: [{ nodeId: 'child', portId: 'image' }] } } : node));
      await c.start('child', true);
      for (let i = 0; i < 200 && (calls < 2 || c.document.runs.some(run => run.status === 'running')); i++) await new Promise(resolve => setTimeout(resolve, 10));
      return { calls, count: c.document.nodes[0].triggerCount };
    } finally { window.__TAURI_INTERNALS__.invoke = invoke; }
  });
  assert.deepEqual(completionCalls, { calls: 2, count: 0 }, 'upstream success triggers downstream once in completion mode');
  await selectMode('手动点击');
  const manualCalls = await page.evaluate(async () => {
    const c = window.scheduleController, invoke = window.__TAURI_INTERNALS__.invoke;
    let calls = 0;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => { if (command === 'comfy_video' && args.action === 'start') calls++; return invoke(command, args); };
    try {
      await c.edit(c.document.nodes.map(node => node.id === 'timer' ? { ...node, triggerCount: 1 } : node));
      await c.start('child', true);
      return { calls, count: c.document.nodes[0].triggerCount, retained: c.document.nodes[0].inputs.completion.length };
    } finally { window.__TAURI_INTERNALS__.invoke = invoke; }
  });
  assert.deepEqual(manualCalls, { calls: 1, count: 1, retained: 1 }, 'manual mode retains completion wiring without consuming it');
  await selectMode('一次定时');
  await schedule.getByRole('button', { name: '设置', exact: true }).click();
  await schedule.getByLabel('定时执行时间').fill('2020-01-01T12:00');
  await schedule.getByRole('button', { name: '确定', exact: true }).click();
  await schedule.getByRole('alert').filter({ hasText: '请选择未来的日期和时间' }).waitFor();
  await schedule.getByLabel('定时执行时间').fill('2029-01-02T12:34');
  await trigger.screenshot({ path: '.tmp/workflow-schedule/time-editor.png' });
  await schedule.getByRole('button', { name: '确定', exact: true }).click();
  await schedule.getByText('待触发', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.scheduleController.document.nodes[0].triggerSchedule.at), new Date('2029-01-02T12:34').getTime());
  await trigger.screenshot({ path: '.tmp/workflow-schedule/once.png' });
  await selectMode('每天定时');
  await page.waitForFunction(() => !window.scheduleController.document.nodes[0].triggerSchedule);
  await schedule.getByRole('button', { name: '设置', exact: true }).click();
  await schedule.getByLabel('定时执行时间').fill('21:00');
  await schedule.getByRole('button', { name: '确定', exact: true }).click();
  await schedule.locator('time[aria-label="每天 21:00"]').waitFor();
  assert.equal(await page.evaluate(() => window.scheduleController.document.nodes[0].triggerSchedule.dailyAt), '21:00');
  await selectMode('一次定时');
  await page.waitForFunction(() => !window.scheduleController.document.nodes[0].triggerSchedule);
  await schedule.getByRole('button', { name: '设置', exact: true }).click();
  await schedule.getByLabel('定时执行时间').fill('2029-01-02T12:34');
  await schedule.getByRole('button', { name: '确定', exact: true }).click();
  assert.equal(await page.evaluate(() => window.scheduleController.document.nodes[0].triggerSchedule.dailyAt), undefined);
  await selectMode('每天定时');
  await schedule.getByRole('button', { name: '设置', exact: true }).click();
  await schedule.getByLabel('定时执行时间').fill('21:00');
  await schedule.getByRole('button', { name: '确定', exact: true }).click();
  await schedule.screenshot({ path: '.tmp/workflow-schedule/dark.png' });
  await page.locator('.workflow-card.is-trigger').screenshot({ path: '.tmp/workflow-schedule/card-dark.png' });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await schedule.screenshot({ path: '.tmp/workflow-schedule/light.png' });
  await page.locator('.workflow-card.is-trigger').screenshot({ path: '.tmp/workflow-schedule/card-light.png' });
  await trigger.getByRole('button', { name: '复制卡片', exact: true }).click();
  assert.equal(await page.evaluate(() => window.scheduleController.document.nodes.filter(node => node.kind === 'trigger' && node.triggerSchedule).length), 1);
  const original = page.locator('.workflow-trigger-schedule').filter({ has: page.getByText('待触发', { exact: true }) });
  await original.getByRole('button', { name: '取消定时', exact: true }).click();
  await page.waitForFunction(() => !window.scheduleController.document.nodes[0].triggerSchedule);
  assert.equal(await page.evaluate(() => window.scheduleController.document.nodes[0].triggerSchedule), undefined);
  assert.equal(await modes.innerText(), '每天定时');
  console.log('PASS four trigger modes: manual run, completion-only event consumption, inactive wiring, mode switch cancellation, daily/once scheduling, atomic checkpoint, missed days, locks, deletion, reload, failure, undo, copy and actual card UI');
} finally { await browser.close(); await server.close(); }
