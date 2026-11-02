const DEFAULT_MESSAGE = "操作未完成，请稍后重试。";
// English product names, keys and file formats can be useful in a Chinese instruction.
// Everything else (including unfamiliar upstream prose) uses the caller's action-specific fallback.
const DISPLAY_WORDS = /^(?:Bowerbird|Bcoin|Pro|Studio|Cloud|Codex|ChatGPT|ComfyUI|Jev|Jimeng|Dreamina|Seedream|Seedance|GPT|OpenAI|Agent|CLI|API|DSH|MCP|FFmpeg|Python|tar|x64|Windows|macOS|Mac|Apple|Intel|NVIDIA|AMD|GPU|CPU|RAM|H3|F\d{1,2}|Ctrl|Control|Alt|Shift|Command|Cmd|Option|Esc|Escape|Enter|Tab|Space|Backspace|Delete|PNG|JPE?G|WebP|GIF|AVIF|HEIC|SVG|PDF|PSD|MP4|MOV|WebM|MKV|MP3|WAV|ZIP|JSON|UTF|Markdown|GB|MB|MiB|KB|TB|px|fps|\d{3,4}p|x)$/i;

function clearChineseMessage(message: string): boolean {
  return /[\u3400-\u9fff]/.test(message) && message.length <= 240
    && !/[\r\n\x00-\x1f{}<>]|https?:|file:|[a-z]:[\\/]|\\\\|(?:^|[\s：:（("'])\/(?:[^\s/]+\/)|\b[a-z0-9]+(?:_[a-z0-9]+)+\b|\b0x[\da-f]+\b|\b[\da-f]{8}-[\da-f-]{27,}\b|\b[a-z][a-z0-9-]*\.[a-z]{2,}(?:\b|\/)/i.test(message)
    && (message.match(/\b\d{3,4}p\b|[a-z][a-z0-9]*/gi) ?? []).every(word => DISPLAY_WORDS.test(word));
}

function errorText(error: unknown, depth = 0): string {
  if (depth > 4 || error == null) return "";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") {
    // HTTP clients sometimes reject with an encoded error envelope.
    if (error.trimStart().startsWith("{")) {
      try { return errorText(JSON.parse(error), depth + 1); } catch { /* Not an envelope. */ }
    }
    return error;
  }
  if (typeof error !== "object") return "";
  const value = error as Record<string, unknown>;
  const code = typeof value.code === "string" ? value.code : "";
  return [code, errorText(value.safe_message ?? value.message ?? value.error, depth + 1)].filter(Boolean).join(": ");
}

/** Presentation only: never replace raw errors used for recovery, branching or diagnostics. */
export function userErrorMessage(error: unknown, fallback = DEFAULT_MESSAGE): string {
  const message = errorText(error).trim();
  const safeFallback = clearChineseMessage(fallback) ? fallback : DEFAULT_MESSAGE;
  if (/HotKey.*already registered|快捷键.*(注册|占用)|hot.?key.*(register|occupied)/i.test(message)) {
    return "这个快捷键暂时无法使用，可能已被其他应用占用。请换一个组合键，或关闭占用它的应用后重试。";
  }
  if (/截图与贴图不能使用同一快捷键/.test(message)) return "截图和贴图需要使用不同的快捷键，请修改其中一个。";
  const clean = message.replace(/^(?:(?:cloud|codex|jimeng|io|db|media|error|other|not found):\s*)+/i, "");
  // Preserve an already actionable Chinese instruction, including capacity figures,
  // refund/stop confirmation and the recovery action chosen by that feature.
  if (clearChineseMessage(clean) && /请|可以|点击|仍|无需/.test(clean) && !/超时/.test(clean)) return clean;
  if (/clipboard.*(empty|not available|image)|剪贴板.*(没有|无图片|不包含)/i.test(message)) return "剪贴板中没有可用图片，请先复制一张图片再试。";
  if (/permission denied|access is denied|os error 5\b|拒绝访问/i.test(message)) return "没有完成操作所需的权限，请检查文件夹或系统权限后重试。";
  if (/disk full|no space left|os error 112\b|磁盘空间不足/i.test(message)) return "磁盘空间不足，请释放空间后重试。";
  if (/no such file|file not found|os error [23]\b|找不到指定的文件/i.test(message)) return "找不到所需文件，可能已被移动或删除。请重新选择文件。";
  if (/being used by another process|sharing violation|os error 32\b/i.test(message)) return "文件正被其他应用使用，请关闭占用它的应用后重试。";
  if (/database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(message)) return "资料库正忙，请稍候再试。";
  if (/database disk image is malformed|SQLITE_CORRUPT/i.test(message)) return "资料库暂时无法读取，请保留现有文件并联系支持。";
  if (/HTTP\s*401\b|invalid.?jwt|jwt.*expired|token.*expired|session_expired|refresh_token_not_found|not_authenticated/i.test(message)) return "登录已失效，请重新登录后继续。";
  if (/insufficient_(?:credits|balance)|credits?_insufficient|积分不足|Bcoin.*不足/i.test(message)) return "可用积分不足，请补充积分后继续。";
  if (/content_policy_violation|content_filter|safety_check_failed|内容.*未通过.*审核/i.test(message)) return "内容未通过审核，请调整文字或参考素材后再试。";
  if (/HTTP\s*429|too many requests|rate_limit(?:ed|_exceeded)?/i.test(message)) return "操作过于频繁，请稍后再试。";
  // A lost response does not prove a paid generation failed. Do not encourage duplicate submissions.
  if (/timed?\s*out|timeout|请求超时/i.test(message)) return "等待响应超时，请稍后查看状态。如已提交任务，请勿重复提交。";
  if (/failed to fetch|fetch failed|error sending request|connection (refused|reset)|network\s*error|ENOTFOUND|ECONNRESET|ERR_NETWORK/i.test(message)) return "暂时无法连接服务，请检查网络后再查看状态。如已提交任务，请勿重复提交。";
  if (/HTTP\s*50[0234]|service unavailable|bad gateway|internal server error/i.test(message)) return "服务暂时不可用，请稍后查看状态。如已提交任务，请勿重复提交。";
  return clearChineseMessage(clean) ? clean : safeFallback;
}

/** Generation-only presentation. Keep turn.error and persisted provider diagnostics unchanged. */
export function generationErrorMessage(error: unknown, context: { provider?: string } = {}): string {
  const message = errorText(error).trim();
  // Result uncertainty outranks any nested transport/provider failure: an original task may still exist.
  if (/视频任务成功但未下载到视频文件/.test(message)) return "视频已生成，但尚未下载到本机。请取回原视频，无需重新生成。";
  if (/未(?:拿到|返回) submit_id|未能确认.*提交|提交超时/.test(message)) {
    return "暂时无法确认任务是否已提交，请先查看生成服务中的原任务，避免重复提交。";
  }
  if (/结果查询暂时中断|状态尚(?:未|无法)确认/.test(message)) {
    return "暂时无法确认原任务的结果，请稍后查看或取回原任务，请勿重复提交。";
  }
  if (/outcome_unknown|结果(?:状态)?(?:暂时)?(?:无法确认|未知)|提交结果未知|远端仍在生成/.test(message)) {
    return "生成请求已提交，但暂时无法确认结果。请稍后查看或取回原任务，请勿重复提交。";
  }
  if (/ExceedConcurrencyLimit/i.test(message)) return "即梦同时生成的任务数已达上限，请等待已有任务完成后再试。";
  if (/AigcComplianceConfirmationRequired/i.test(message)) return "即梦需要先完成视频生成授权，请前往即梦网页完成授权后重试。";
  if (context.provider === "jimeng" && /\bunauthorized\b|please login/i.test(message)) return "即梦登录已失效，请到设置重新登录即梦后继续。";
  if (/启动 (?:codex|dreamina) 失败/i.test(message)) return "未能启动本机生成工具，请到设置检查对应生成方式是否已安装且可用。";
  if (/you(?:'|’)ve hit your usage limit|usage_limit_reached/i.test(message)) {
    return context.provider === "codex" || /codex/i.test(message)
      ? "当前 ChatGPT 账号的使用额度已用完，请等待额度恢复，或切换生成方式。"
      : "当前生成服务的使用额度已用完，请等待额度恢复，或切换生成方式。";
  }
  if (/insufficient_(?:credits|balance)|credits?_insufficient|积分不足|Bcoin.*不足/i.test(message)) {
    return context.provider === "jimeng"
      ? "即梦账号的可用积分不足，请在即梦补充积分，或切换生成方式。"
      : context.provider?.startsWith("bowerbird-cloud")
        ? "可用 Bcoin 不足，请补充积分后再生成。"
        : "当前生成服务的可用积分不足，请补充积分，或切换生成方式。";
  }
  if (/InputTextSensitiveContentDetected|提示词未通过.*审核/i.test(message)) return "提示词未通过内容审核，请调整文字后重试。";
  if (/InputImageSensitiveContentDetected|参考图未通过.*审核/i.test(message)) return "参考图未通过内容审核，请更换参考图后重试。";
  if (/Output\w*SensitiveContentDetected|生成结果未通过.*审核/i.test(message)) return "生成结果未通过内容审核，请调整文字或参考素材后重试。";
  if (/content_moderation|content_policy_violation|content_filter|safety_check_failed/i.test(message)) return "内容未通过审核，请调整文字或参考素材后重试。";
  if (/视频参考文件不存在|参考图(?:片)?(?:文件)?不存在/.test(message)) return "参考文件可能已被移动或删除，请重新选择参考素材。";
  if (/invalid_reference_image|InvalidImage(?:Format|Size|Resolution|Ratio)|参考图无法被方舟读取/i.test(message)) return "参考图无法读取，请重新选择图片，并检查格式、尺寸和宽高比。";
  if (/方舟视频仅支持 480p \/ 720p \/ 1080p/.test(message)) return "所选视频分辨率不受支持，请选择 480p、720p 或 1080p。";
  if (/每条参考视频不能超过 200 MiB/.test(message)) return "单条参考视频不能超过 200 MiB，请压缩或裁短后重新选择。";
  const duration = message.match(/每条参考视频须为 (\d+[–-]\d+) 秒/);
  if (duration) return `每条参考视频须为 ${duration[1]} 秒，请裁剪或更换参考视频。`;
  const totalDuration = message.match(/参考视频总时长不得超过 (\d+) 秒/);
  if (totalDuration) return `参考视频总时长不得超过 ${totalDuration[1]} 秒，请减少或裁剪参考视频。`;
  if (/invalid_provider_request|\bInvalidParameter\b|方舟拒绝了生成参数/i.test(message)) return "当前生成参数不被服务支持，请检查模型、尺寸和参考素材后重试。";
  if (/model_not_configured|Provider 未启用/i.test(message)) return "所选生成方式暂时不可用，请切换生成方式，或稍后再试。";
  if (/provider_burst|RequestBurstTooFast|方舟请求过快/i.test(message)) return "生成请求过于频繁，请稍后再试。";
  if (/provider_busy|方舟请求受限/i.test(message)) return "生成服务当前繁忙，请稍后再试。";
  if (/provider_failed|方舟服务暂时不可用/i.test(message)) return "生成服务暂时不可用，请稍后查看任务状态。如已提交任务，请勿重复提交。";
  if (/app 重启中断.*会话不可恢复/i.test(message)) return "应用重启中断了本次生成，无法继续原任务。请在当前会话中重试。";
  if (/超时|deadline exceeded/i.test(message)) return userErrorMessage("timeout");
  // A known quota/moderation error inside the provider reply is more useful than its no-output wrapper.
  if (/未生成图片|未返回图片|没有生成图片/.test(message)) return "本次没有生成图片，请补充或调整生成要求后重试。";
  // The native Cloud adapter appends a code to the original message. An unfamiliar
  // code must not discard an otherwise helpful validation/refund/recovery instruction.
  const withoutCode = message.replace(/\s+\[code: [^\]\r\n]+\]$/, "");
  return userErrorMessage(withoutCode, "生成未完成，暂时无法确定具体原因。请稍后重试；若反复出现，可复制会话诊断信息联系支持。");
}
