// Only reviewed product messages may pass through. Upstream errors can include
// response bodies, deployment settings, paths or credentials even when Chinese.
const knownMessages = new Map([
  ["登录状态已变化，请重新登录", "登录状态已变化，请重新登录。"],
  ["账号已切换，已隐藏本次结果", "账号已切换，已隐藏本次结果。"],
  ["此账号没有后台管理权限", "此账号没有后台管理权限，请使用管理员账号登录。"],
  ["此账号没有兑换码管理权限", "此账号没有兑换码管理权限，请使用管理员账号登录。"],
  ["请填写批次名称、1–1000 的数量和未来两年内的兑换截止时间", "请填写批次名称、1–1000 的数量和未来两年内的兑换截止时间。"],
  ["用户不存在，请刷新列表", "用户不存在，请刷新列表。"],
  ["该码已被兑换，无法停用；用户权益未改变", "该码已被兑换，无法停用；用户权益未改变。"],
  ["兑换码不存在", "兑换码不存在，请刷新清单后重试。"],
  ["用户筛选条件不正确", "请检查用户筛选条件后重试。"],
  ["筛选条件不正确", "请检查筛选条件后重试。"],
  ["Prompt 不能为空", "请先填写想要创作的内容。"],
  ["Prompt 不能超过 8000 个字符", "创作描述最多支持 8000 个字，请缩短后重试。"],
  ["最多支持 8 张参考图", "最多支持 8 张参考图，请减少图片后重试。"],
  ["包含未知参考图", "部分参考图已不可用，请重新选择。"],
  ["参考图格式无效", "无法读取这张参考图，请换一张图片。"],
  ["参考图过大", "参考图太大，请缩小图片后重试。"],
  ["今日试用名额已用完，请明天再来", "今日体验名额已用完，请明天再来。"],
]);

export function userErrorMessage(error, fallback = "操作未完成，请稍后重试。") {
  const detail = error?.error ?? error;
  const message = typeof detail === "string" ? detail : typeof detail?.message === "string" ? detail.message : "";
  const code = typeof detail?.code === "string" ? detail.code : "";
  const status = Number(error?.status ?? detail?.status);
  const known = knownMessages.get(message.replace(/[。\s]+$/, ""));
  if (known) return known;
  if (error?.name === "AbortError" || error?.name === "TimeoutError" || status === 504)
    return "等待时间较长，暂未确认结果。请稍后刷新查看。";
  if (status === 429 || /rate.limit|too.many.requests|over_.*rate_limit/i.test(code))
    return "操作过于频繁，请稍后再试。";
  if (status === 401 || /session_expired|bad_jwt|invalid_credentials|otp_expired/.test(code))
    return "登录已失效，请重新登录后再试。";
  if (status === 403) return "当前账号无法进行此操作，请确认账号权限。";
  if (status === 402 || code === "insufficient_credits") return "积分不足，请充值后再试。";
  if (/email_address_invalid|validation_failed/.test(code)) return "请检查邮箱地址后重试。";
  if (error instanceof TypeError || /network|failed to fetch|fetch failed|load failed/i.test(message))
    return "暂时无法连接服务，请检查网络后重试。";
  return fallback;
}

export function reportUserError(error, fallback) {
  console.warn("Bowerbird operation failed", error);
  return userErrorMessage(error, fallback);
}
