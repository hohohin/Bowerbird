/** Account UI only: never render raw backend, browser, or OAuth error text. */
export function accountErrorMessage(error: unknown): string {
  const message = (typeof error === "string" ? error : error instanceof Error ? error.message : "")
    .replace(/^cloud:\s*/i, "").trim();

  if (message === "请输入有效邮箱") return "请输入有效的邮箱地址。";
  const retry = message.match(/^登录邮件发送过于频繁，请 (\d{1,5}) 秒后重试$/);
  if (retry) return `登录邮件发送过于频繁，请 ${retry[1]} 秒后重试。`;
  if (/过于频繁|限流|rate.?limit|HTTP 429/i.test(message)) {
    return "操作过于频繁，请稍后重试。";
  }
  if (/登录已失效|请先登录/.test(message)) return "登录状态已失效，请重新登录。";
  if (/过期|已被使用/.test(message)) return "本次登录已过期，请重新发起登录。";
  if (/不匹配|缺少 state|非 Bowerbird.*回调/.test(message)) {
    return "本次登录验证未通过，请重新发起登录。";
  }
  if (/未配置|Supabase URL 无效/.test(message)) {
    return "当前版本暂时无法使用登录服务，请更新到最新版本后重试。";
  }
  if (/浏览器.*失败|浏览器.*未能|shell.*open/i.test(message)) {
    return "暂时无法打开浏览器，请确认已设置默认浏览器后重试。";
  }
  if (/超时|timed?\s*out|timeout/i.test(message)) {
    return "登录服务响应超时，请稍后重试。";
  }
  if (/连接.*失败|连接未建立|无法连接|error sending request|failed to fetch/i.test(message)) {
    return "暂时无法连接登录服务，请稍后重试。";
  }
  if (/暂未开放|暂时不可用|HTTP 5\d\d/i.test(message)) {
    return "登录服务暂时不可用，请稍后重试。";
  }
  if (/微信登录|扫码登录|微信扫码/.test(message)) {
    return "微信登录未能完成，请重新点击扫码登录。";
  }
  if (/登录邮件|发送登录链接/.test(message)) {
    return "登录邮件暂时未能发送，请稍后重试。";
  }
  return "账号操作暂时未能完成，请稍后重试。";
}
