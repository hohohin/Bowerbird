const DEFAULT_MESSAGE = "操作未完成，请稍后重试。";
// English product names, keys and file formats can be useful in a Chinese instruction.
// Everything else (including unfamiliar upstream prose) uses the caller's action-specific fallback.
const DISPLAY_WORDS = /^(?:Bowerbird|Bcoin|Pro|Studio|Cloud|Codex|ChatGPT|ComfyUI|Jev|Jimeng|Dreamina|Seedream|Seedance|GPT|OpenAI|Agent|CLI|API|DSH|MCP|FFmpeg|Python|tar|x64|Windows|macOS|Mac|Apple|Intel|NVIDIA|AMD|GPU|CPU|RAM|H3|F\d{1,2}|Ctrl|Control|Alt|Shift|Command|Cmd|Option|Esc|Escape|Enter|Tab|Space|Backspace|Delete|PNG|JPE?G|WebP|GIF|AVIF|HEIC|SVG|PDF|PSD|MP4|MOV|WebM|MKV|MP3|WAV|ZIP|JSON|GB|MB|KB|TB|px|fps|x)$/i;

function clearChineseMessage(message: string): boolean {
  return /[\u3400-\u9fff]/.test(message) && message.length <= 240
    && !/[\r\n\x00-\x1f{}<>]|https?:|file:|[a-z]:[\\/]|\\\\|(?:^|[\s：:（("'])\/(?:[^\s/]+\/)|\b[a-z0-9]+(?:_[a-z0-9]+)+\b|\b0x[\da-f]+\b|\b[\da-f]{8}-[\da-f-]{27,}\b|\b[a-z][a-z0-9-]*\.[a-z]{2,}(?:\b|\/)/i.test(message)
    && (message.match(/[a-z][a-z0-9]*/gi) ?? []).every(word => DISPLAY_WORDS.test(word));
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
