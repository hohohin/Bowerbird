import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, transformWithEsbuild } from 'vite';

// Render synthetic saved nodes without IPC, accounts, providers or a user library.
const server = await createServer({ cacheDir: '.tmp/creative-status-vite', server: { middlewareMode: true, hmr: false, watch: null } });
try {
  const { CreativeTimeline } = await server.ssrLoadModule('/src/components/CreativeTimeline.tsx');
  const { cloudAgentStepLabel } = await server.ssrLoadModule('/src/lib/cloudAgent.ts');
  const raw = '读取失败：TypeError debug_payload at private.rs:42 /Users/private/data';
  const render = (kind, data) => {
    const node = { id: 'synthetic-node', kind, hiddenAt: null, createdAt: 1, payloadJson: JSON.stringify(data) };
    const before = JSON.stringify(node);
    const html = renderToStaticMarkup(React.createElement(CreativeTimeline, {
      nodes: [node], edges: [], selectedNodeId: node.id, onSelect() {}, onLocate() {},
    }));
    assert.equal(JSON.stringify(node), before, 'presentation must preserve the original recovery payload');
    return html;
  };

  assert.match(render('prompt', { text: '生成花瓶', status: 'failed' }), /生成失败/);
  assert.match(render('prompt', { text: '生成花瓶', status: 'done' }), /已完成/);
  const unknownPrompt = render('prompt', { text: '生成花瓶', status: 'future_private_status' });
  assert.match(unknownPrompt, /正在确认生成状态/);
  assert.doesNotMatch(unknownPrompt, /future_private_status/);

  const agent = render('agent_group', {
    status: 'failed', current_step: 'compose_plan', progress: 25,
    events: [
      { event_type: 'step.failed', step: 'private_step_id', summary: raw },
      { event_type: 'plan.proposed', step: 'compose_plan', summary: '保持花瓶形状，改成蓝色背景' },
    ],
  });
  assert.match(agent, /执行失败/);
  assert.match(agent, /制定计划/);
  assert.match(agent, /本次操作未完成，请查看任务结果。/);
  assert.match(agent, /保持花瓶形状，改成蓝色背景/);
  assert.doesNotMatch(agent, /step.failed|plan.proposed|compose_plan|private_step_id|TypeError|debug_payload|private\.rs|\/Users\/private/);

  const unknownAgent = render('agent_group', { status: 'future_private_status', current_step: 'future_private_step' });
  assert.match(unknownAgent, /正在确认任务状态/);
  assert.match(unknownAgent, /当前任务步骤/);
  assert.doesNotMatch(unknownAgent, /future_private|任务完成|执行失败/);
  assert.equal(cloudAgentStepLabel('diagnose_feedback'), '分析修改意见');

  const classification = await readFile('src/components/LocalClassificationDialog.tsx', 'utf8');
  const compile = dev => transformWithEsbuild(classification, 'LocalClassificationDialog.tsx', { loader: 'tsx', charset: 'utf8', minifySyntax: true, define: { 'import.meta.env.DEV': String(dev) } });
  assert.doesNotMatch((await compile(false)).code, /查看 Jev 原始返回/);
  assert.match((await compile(true)).code, /查看 Jev 原始返回/);
  console.log('PASS: saved statuses and steps use Chinese, failed event diagnostics are hidden, source payloads and authored summaries remain unchanged, raw classification details are development-only');
} finally {
  await server.close();
}
