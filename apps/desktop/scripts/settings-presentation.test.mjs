import test from 'node:test';
import assert from 'node:assert/strict';
import { userErrorMessage } from '../src/lib/userError.ts';
import { creditTransactionView } from '../src/lib/creditHistory.ts';

const tx = (kind, amount, service = 'image_hd', meta) => ({ kind, amount, service, meta, created_at: '2026-10-24T02:00:00Z' });
test('credit history shows purpose and actual balance changes, omitting zero-value bookkeeping', () => {
  assert.equal(creditTransactionView(tx('hold', -20)).title, '图片生成 · 高清');
  assert.equal(creditTransactionView(tx('confirm', 0)), null);
  assert.equal(creditTransactionView(tx('confirm', 5)).title, '图片生成 · 高清 · 积分退回');
  assert.equal(creditTransactionView(tx('rollback', 20)).title, '图片生成 · 高清 · 积分退回');
  assert.equal(creditTransactionView(tx('refund', -100)).title, '订单退款 · 积分收回');
  assert.equal(creditTransactionView(tx('refund', -100)).amount, '−100 Bcoin');
  assert.equal(creditTransactionView(tx('expire', -200)).title, '积分到期');
  assert.equal(creditTransactionView(tx('grant', 200)).title, '积分到账');
  const rows = [tx('hold', -20), tx('confirm', 5), tx('confirm', 0)].map(creditTransactionView).filter(Boolean);
  assert.deepEqual(rows.map(row => row.amount), ['−20 Bcoin', '+5 Bcoin']);
  assert.doesNotMatch(JSON.stringify(rows), /预留|结算|不再|余额不变|description/);
  assert.equal(creditTransactionView(tx('hold', NaN)).amount, '金额待确认');
});
test('known services and agent records use Chinese; unknown values never leak machine labels', () => {
  assert.equal(creditTransactionView(tx('hold', -20, 'image_layer_decompose')).title, '图片分层');
  assert.equal(creditTransactionView(tx('hold', -3, 'replication_video_analysis')).title, '参考视频分析');
  assert.equal(creditTransactionView(tx('hold', -1, 'chat_deepseek')).title, 'AI 对话');
  const view = creditTransactionView(tx('rollback', 10, 'agent_v2', { entity_type: 'agent_run', final_status: 'failed', actual_credits: 99 }));
  assert.equal(view.title, '智能创作 · 积分退回');
  assert.equal(view.amount, '+10 Bcoin', 'task cost metadata is not a balance change');
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
