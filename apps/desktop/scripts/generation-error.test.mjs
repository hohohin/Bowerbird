import test from 'node:test';
import assert from 'node:assert/strict';
import { generationErrorMessage, userErrorMessage } from '../src/lib/userError.ts';

test('generation failures explain the actual cause without exposing provider diagnostics', () => {
  const cases = [
    ["codex: codex 未生成图片 | You've hit your usage limit.", 'codex', /ChatGPT.*额度已用完/],
    ['即梦视频生成失败：ExceedConcurrencyLimit\n上游诊断：{"private":"secret"}', 'jimeng', /即梦同时生成的任务数已达上限/],
    ['即梦视频生成失败：AigcComplianceConfirmationRequired\n上游诊断：{}', 'jimeng', /即梦.*授权.*即梦网页/],
    [{ error: { code: 'insufficient_credits', message: 'balance unavailable' } }, 'bowerbird-cloud', /Bcoin.*不足/],
    ['insufficient_credits', 'jimeng', /即梦.*积分不足/],
    ['方舟请求受限，请稍后重试（方舟错误码：RequestLimitExceeded）', 'bowerbird-cloud', /服务当前繁忙/],
    ['provider_burst: 方舟请求过快', 'bowerbird-cloud', /请求过于频繁/],
    ['方舟拒绝了生成参数（方舟错误码：InvalidParameter）', 'bowerbird-cloud', /生成参数不被.*支持.*检查/],
    ['参考图无法被方舟读取，请检查格式、尺寸与宽高比（方舟错误码：InvalidImageFormat；请求 ID：secret）', 'bowerbird-cloud', /参考图无法读取.*格式、尺寸和宽高比/],
    ['提示词未通过方舟安全审核（方舟错误码：InputTextSensitiveContentDetected）', 'bowerbird-cloud', /提示词.*审核.*调整文字/],
    ['方舟视频任务未成功，冻结积分将退回 [code: InputImageSensitiveContentDetected]', 'bowerbird-cloud', /参考图.*审核.*更换参考图/],
    ['content_moderation: 生成结果未通过方舟安全审核', 'bowerbird-cloud', /生成结果.*审核.*调整/],
    ['codex 未生成图片 | completed without generated_images at C:\\private', 'codex', /没有生成图片.*调整生成要求/],
    ['Seedream 未返回图片', 'bowerbird-cloud', /没有生成图片.*调整生成要求/],
    ['视频参考文件不存在：C:\\private\\reference.mp4', 'jimeng', /参考文件.*移动或删除.*重新选择/],
    ['方舟视频仅支持 480p / 720p / 1080p', 'bowerbird-cloud', /分辨率.*480p.*720p.*1080p/],
    ['每条参考视频不能超过 200 MiB', 'bowerbird-cloud', /200 MiB.*压缩或裁短/],
    ['每条参考视频须为 2–30 秒', 'jimeng', /2–30 秒.*裁剪/],
    ['参考视频总时长不得超过 30 秒', 'jimeng', /30 秒.*减少或裁剪/],
    ['app 重启中断，codex 会话不可恢复', 'codex', /应用重启.*中断.*当前会话中重试/],
    ['model_not_configured: GPT Image 服务暂未配置 API key', 'bowerbird-cloud', /生成方式暂时不可用.*切换/],
    ['dreamina 退出 exit code: 1：unauthorized', 'jimeng', /即梦登录已失效.*设置重新登录/],
    ['dreamina 退出 exit code: 1：please login', 'jimeng', /即梦登录已失效.*设置重新登录/],
    ['启动 dreamina 失败: program not found (os error 2)', 'jimeng', /启动本机生成工具.*设置检查/],
  ];
  for (const [raw, provider, expected] of cases) {
    const display = generationErrorMessage(raw, { provider });
    assert.match(display, expected, JSON.stringify(raw));
    assert.doesNotMatch(display, /ExceedConcurrency|AigcCompliance|InputImageSensitive|code:|API|HTTP|generated_images|secret|private|https?:|C:\\/);
    assert.equal(userErrorMessage(display), display, 'safe text survives notification boundaries');
  }
});

test('unknown outcome takes precedence over nested provider errors and never suggests a new generation', () => {
  for (const raw of [
    '请求已提交生成服务，但 Worker 与上游或控制面连接中断，结果状态暂时无法确认',
    'outcome_unknown: provider_failed HTTP 502',
    '视频提交结果未知，请等待核对；不会自动重新生成',
    '未拿到 submit_id，无法续查',
    '视频提交未返回 submit_id；请到即梦核对任务，避免重复提交',
    'dreamina 提交超时（180s）',
    '视频结果查询暂时中断，远端生成状态尚未确认，可稍后取回原任务，无需重新生成。最后错误：context deadline exceeded',
    '原视频任务状态尚无法确认，不会重新生成：HTTP 502 [code: provider_failed]',
    '轮询超时，远端仍在生成',
  ]) {
    const display = generationErrorMessage(raw);
    assert.match(display, /请勿重复提交|避免重复提交/);
    assert.doesNotMatch(display, /稍后重试|调整.*重试/);
  }
  for (const raw of ['HTTP 504', 'error sending request for url https://private.test', 'provider_timeout', 'HTTP 503']) {
    assert.match(generationErrorMessage(raw), /请勿重复提交/);
  }
});

test('honest fallback, helpful validation and raw diagnostics stay intact', () => {
  const error = { message: 'unknown_internal_failure https://private.test?token=secret' };
  const original = structuredClone(error);
  assert.match(generationErrorMessage(error), /暂时无法确定具体原因.*复制会话诊断信息/);
  assert.deepEqual(error, original);
  assert.equal(generationErrorMessage('需要 Pro 订阅，请前往账号开通。'), '需要 Pro 订阅，请前往账号开通。');
  assert.equal(generationErrorMessage('HTTP 429', { provider: 'jimeng' }), '操作过于频繁，请稍后再试。');
  assert.doesNotMatch(generationErrorMessage('ExceedConcurrencyLimit', { provider: 'jimeng' }), /积分|额度|充值/);
  assert.match(generationErrorMessage('invalid_reference_image: upstream detail'), /参考图无法读取/);
  assert.match(generationErrorMessage('No space left on device'), /磁盘空间不足/);
  assert.equal(generationErrorMessage('需要 Pro 订阅，请前往账号开通。 [code: plan_required]'), '需要 Pro 订阅，请前往账号开通。');
  assert.equal(generationErrorMessage('cloud: 视频产物已超过保留期限；用量和结算记录仍保留 [code: artifact_expired]'), '视频产物已超过保留期限；用量和结算记录仍保留');
  assert.match(generationErrorMessage('读取失败 C:\\private\\file [code: unknown_error]'), /暂时无法确定具体原因/);
  assert.match(generationErrorMessage('视频任务成功但未下载到视频文件；保留 submit_id 可取回'), /视频已生成.*取回原视频.*无需重新生成/);
});
