import test from 'node:test';
import assert from 'node:assert/strict';
import { userErrorMessage } from '../src/lib/userError.ts';
import { creditTransactionView } from '../src/lib/creditHistory.ts';

const tx = (kind, amount, service = 'image_hd', meta) => ({ kind, amount, service, meta, created_at: '2026-10-24T02:00:00Z' });
test('reserved credits, settlement and refunds are never presented as double charges', () => {
  assert.equal(creditTransactionView(tx('hold', -20)).title, '预留积分');
  assert.equal(creditTransactionView(tx('confirm', 0)).amount, '余额不变');
  assert.equal(creditTransactionView(tx('confirm', 5)).title, '多余预留返还');
  assert.equal(creditTransactionView(tx('rollback', 20)).title, '积分退回');
  assert.equal(creditTransactionView(tx('refund', -100)).title, '退款回收积分');
  assert.equal(creditTransactionView(tx('refund', -100)).amount, '−100 Bcoin');
});
test('known services and agent status use Chinese; unknown values never leak machine labels', () => {
  assert.equal(creditTransactionView(tx('hold', -20, 'image_layer_decompose')).usage, '图片分层');
  assert.equal(creditTransactionView(tx('confirm', 0, 'replication_video_analysis')).usage, '参考视频分析');
  const view = creditTransactionView(tx('confirm', 0, 'agent_v2', { entity_type: 'agent_run', final_status: 'failed' }));
  assert.equal(view.status, '任务失败');
  assert.equal(view.usage, '智能创作任务');
  const unknown = creditTransactionView({ ...tx('future_kind', 2, 'future_service'), created_at: 'bad' });
  assert.equal(unknown.title, '积分变动');
  assert.equal(unknown.time, '时间暂不可用');
  assert.doesNotMatch(JSON.stringify(unknown), /future_kind|future_service|Invalid Date/);
});
test('shortcut conflicts explain recovery without Rust debug internals', () => {
  for (const raw of ['HotKey already registered: HotKey { mods: Modifiers(0x0), key: F1, id: 160 }', '快捷键无法注册，可能已被其他程序占用：HotKey { key: F1 }']) {
    assert.match(userErrorMessage(raw), /换一个组合键/);
    assert.doesNotMatch(userErrorMessage(raw), /HotKey|Modifiers|160|\{/);
  }
});
test('technical errors use safe Chinese fallbacks while clear validation stays useful', () => {
  for (const raw of ['failed: C:\\Users\\Private\\file', '保存失败：internal_error', '请求失败 {"secret":"hidden"}', new Error('TypeError: invalid state'), { detail: 'raw' }]) {
    assert.equal(userErrorMessage(raw, '保存未完成，请重试。'), '保存未完成，请重试。');
  }
  assert.match(userErrorMessage('error sending request for url https://secret.test'), /检查网络/);
  assert.equal(userErrorMessage('兑换码无效、已过期或已被使用'), '兑换码无效、已过期或已被使用');
  assert.match(userErrorMessage('permission denied'), /权限/);
});
