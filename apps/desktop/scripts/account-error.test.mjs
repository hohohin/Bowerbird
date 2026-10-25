import test from 'node:test';
import assert from 'node:assert/strict';
import { accountErrorMessage } from '../src/lib/accountError.ts';

test('reported login error hides infrastructure and login parameters', () => {
  const raw = 'cloud: 连接微信登录服务失败: error sending request for url (https://private.supabase.co/functions/v1/wechat-login?state=dt_secret&code=private_code)';
  assert.equal(accountErrorMessage(raw), '暂时无法连接登录服务，请稍后重试。');
});

test('timeout and unavailable service have distinct recovery messages', () => {
  assert.equal(accountErrorMessage('cloud: 连接微信登录服务失败（请求超时）: operation timed out'), '登录服务响应超时，请稍后重试。');
  assert.equal(accountErrorMessage('微信登录暂时不可用（HTTP 503：internal stack trace）'), '登录服务暂时不可用，请稍后重试。');
});

test('actionable validation and throttling are preserved without server details', () => {
  assert.equal(accountErrorMessage('cloud: 请输入有效邮箱'), '请输入有效的邮箱地址。');
  assert.equal(accountErrorMessage('cloud: 登录邮件发送过于频繁，请 47 秒后重试'), '登录邮件发送过于频繁，请 47 秒后重试。');
  assert.equal(accountErrorMessage('登录邮件发送已触发 Supabase 限流；配置 SMTP'), '操作过于频繁，请稍后重试。');
});

test('callback errors do not echo externally supplied descriptions', () => {
  for (const raw of ['登录验证失败：https://secret.test/?token=secret', '登录未完成：<script>secret</script>', 'cloud: internal error C:\\Users\\private']) {
    assert.equal(accountErrorMessage(raw), '账号操作暂时未能完成，请稍后重试。');
  }
  assert.equal(accountErrorMessage('微信登录回调 state 不匹配'), '本次登录验证未通过，请重新发起登录。');
  assert.equal(accountErrorMessage('登录链接已过期或已被使用'), '本次登录已过期，请重新发起登录。');
  assert.equal(accountErrorMessage('登录已失效，请重新登录'), '登录状态已失效，请重新登录。');
});

test('browser and unknown failures remain user-facing for every input type', () => {
  assert.equal(accountErrorMessage(new Error('模拟浏览器打开失败 https://private.test')),
    '暂时无法打开浏览器，请确认已设置默认浏览器后重试。');
  for (const value of [null, undefined, {}, new Error('raw private error'), '']) {
    assert.equal(accountErrorMessage(value), '账号操作暂时未能完成，请稍后重试。');
  }
});
