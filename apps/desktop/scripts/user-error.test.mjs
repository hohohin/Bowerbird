import test from 'node:test';
import assert from 'node:assert/strict';
import { userErrorMessage } from '../src/lib/userError.ts';
import { cloudAgentStatusLabel } from '../src/lib/cloudAgent.ts';

const fallback = '素材未保存，请稍后重试。';
test('unknown and mixed-language diagnostics never reach the presentation', () => {
  const raw = [
    '保存失败：TypeError: Cannot read properties of undefined',
    '读取失败：no such table: asset_refs', '生成失败：upstream returned empty response',
    '任务失败：requestId=private-id', '状态异常：CannotOpen',
    '保存失败：C:\\Users\\Private\\file.png', '保存失败：C:/Users/Private/file.png',
    '读取失败：/Users/private/library/file', '读取失败：/var/tmp/private/file',
    '读取失败：/用户/小明/图片/原图.png', '找不到目录：/素材/临时/', '找不到目录（/素材/临时/）',
    '无法保存：\\\\server\\private\\file', '请求异常：https://example.test/private?token=secret',
    '请求异常：example.test/private', '服务报错 {"token":"secret"}',
    '生成失败：HTTP 418', '错误：0x80070057', '任务：a4a301d1-b2ae-4040-8d5d-4e76a0101111',
    'os error 50', 'os error 1123',
    '出错了\n at privateFunction (bundle.js:1:2)', '异常：' + '详情'.repeat(160),
    new Error('panic at sqlite'), null, undefined, 17, { detail: 'hidden' },
  ];
  for (const error of raw) assert.equal(userErrorMessage(error, fallback), fallback, String(error));
});

test('recognized failures explain a cause and a recovery action', () => {
  const examples = [
    ['HotKey already registered: HotKey { key: F1, id: 160 }', /换一个组合键/],
    ['permission denied C:\\private', /权限/], ['No space left on device', /释放空间/],
    ['No such file or directory', /重新选择文件/], ['os error 32', /其他应用/],
    ['SQLITE_BUSY: database is locked', /资料库正忙/], ['SQLITE_CORRUPT', /联系支持/],
    ['HTTP 401', /重新登录/], [{ code: 'session_expired' }, /重新登录/], [{ error: { code: 'insufficient_credits' } }, /补充积分/],
    [{ error: { code: 'content_policy_violation', message: 'secret details' } }, /调整文字或参考素材/],
    ['HTTP 429', /稍后再试/], ['Error sending request for url https://private.test', /检查网络/],
    ['HTTP 503 service unavailable', /服务暂时不可用/],
  ];
  for (const [error, expected] of examples) {
    const display = userErrorMessage(error, fallback);
    assert.match(display, expected);
    assert.doesNotMatch(display, /HotKey|SQLITE|HTTP|https:|secret|private|160/);
    assert.equal(userErrorMessage(display), display, 'safe presentation must survive the notification boundary');
  }
});

test('ambiguous responses never encourage submitting a second paid task', () => {
  for (const raw of ['timeout', 'Failed to fetch', 'HTTP 502', { code: 'ETIMEDOUT' }]) {
    assert.match(userErrorMessage(raw), /请勿重复提交/);
  }
});

test('clear Chinese validations and product names remain useful', () => {
  for (const message of ['文件名不能为空', '兑换码无效、已过期或已被使用', '需要 Pro 订阅，请前往账号开通。', '请使用 PNG 或 WebP 图片。', '请更换 Ctrl + F2 快捷键。', 'Agent 结果尚未保存，请稍后查看。']) {
    assert.equal(userErrorMessage(message, fallback), message);
  }
  assert.equal(userErrorMessage('cloud: 兑换码无效'), '兑换码无效');
  assert.equal(userErrorMessage({ message: '名称不能为空' }), '名称不能为空');
  assert.equal(userErrorMessage('{"error":{"message":"名称不能为空"}}'), '名称不能为空');
  const disk = '安装磁盘空间不足：需空闲 56.9 GB，可用 10 GB，还差 46.9 GB，请清理或更换位置。';
  assert.equal(userErrorMessage(disk), disk);
  assert.equal(userErrorMessage('请先安装 Python 和 tar，再配置 ComfyUI。'), '请先安装 Python 和 tar，再配置 ComfyUI。');
});

test('fallbacks cannot accidentally reintroduce diagnostics', () => {
  assert.equal(userErrorMessage('unexpected', '保存失败：internal_error'), '操作未完成，请稍后重试。');
  assert.equal(userErrorMessage('unexpected', '保存失败：/用户/小明/图片/原图.png'), '操作未完成，请稍后重试。');
  assert.equal(userErrorMessage('unexpected', fallback), fallback);
});

test('a future task status is presented without exposing its protocol code', () => {
  assert.equal(cloudAgentStatusLabel('future_internal_stage'), '正在确认任务状态');
  assert.equal(cloudAgentStatusLabel('awaiting_approval'), '等待你批准计划');
});
