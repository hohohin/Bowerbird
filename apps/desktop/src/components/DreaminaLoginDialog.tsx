import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";

/**
 * 即梦 OAuth 登录引导（约定 13 Modal，open/onClose 受控；不用 SEEN_KEY——登录是用户主动行为）。
 *
 * dreamina login --headless 走 OAuth Device Flow：spawn 后 stdout 逐行透传到 store.dreaminaLoginLines
 * （App 监听 dreamina://login）。这里展示输出、尽力提取 verification_uri / user_code 给用户去浏览器授权。
 * 子进程结束（dreamina://login-done，App 监听）→ store.dreaminaLoginActive=false + dreaminaHealth 刷新。
 *
 * ⚠️ dreamina `login --headless` 的确切输出格式未实测（spike 没测 headless 登录），下方 regex 提取是
 * 尽力而为（抓 http 链接 + user_code/device_code 短码）；实际格式跑一次后可能要调。
 */
export function DreaminaLoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lines = useStore((s) => s.dreaminaLoginLines);
  const active = useStore((s) => s.dreaminaLoginActive);
  const setDreaminaLoginActive = useStore((s) => s.setDreaminaLoginActive);
  const clearDreaminaLogin = useStore((s) => s.clearDreaminaLogin);
  const [copied, setCopied] = useState<string | null>(null);

  // 打开时启动登录流程：清旧行 + 标记 active + spawn dreamina login。
  useEffect(() => {
    if (!open) return;
    clearDreaminaLogin();
    setDreaminaLoginActive(true);
    api.dreaminaLogin().catch(() => {
      /* spawn 失败：active 保持 true、lines 空，用户可关闭重试 */
    });
  }, [open, clearDreaminaLogin, setDreaminaLoginActive]);

  if (!open) return null;

  // 从 stdout 行里尽力提取 OAuth 材料：verification_uri（http 链接）/ user_code（短码）。
  const allText = lines.join("\n");
  const uriMatch = allText.match(/https?:\/\/\S+/);
  const verificationUri = uriMatch ? uriMatch[0] : null;
  const codeMatch = allText.match(/(?:user_code|device_code)["']?\s*[:=]\s*["']?([A-Za-z0-9-]+)/i);
  const userCode = codeMatch ? codeMatch[1] : null;

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(text);
      setTimeout(() => setCopied(null), 1200);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-edge bg-panel p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-ink">登录即梦账号</h2>
        <p className="mt-1 text-xs text-muted">
          dreamina CLI 走 OAuth Device Flow。打开下方授权页、输入授权码完成登录（即梦/抖音账号）。
        </p>

        <div className="mt-4 space-y-3">
          {verificationUri && (
            <div className="rounded bg-panel2 p-2">
              <div className="text-[10px] uppercase tracking-wide text-muted">授权链接</div>
              <div className="mt-1 flex items-center gap-2">
                <a
                  href={verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-sm text-accent underline"
                >
                  {verificationUri}
                </a>
                <button
                  onClick={() => copy(verificationUri)}
                  className="shrink-0 rounded bg-edge px-2 py-0.5 text-[11px] text-ink hover:opacity-80"
                >
                  {copied === verificationUri ? "已复制 ✓" : "复制"}
                </button>
              </div>
            </div>
          )}
          {userCode && (
            <div className="rounded bg-panel2 p-2">
              <div className="text-[10px] uppercase tracking-wide text-muted">授权码</div>
              <div className="mt-1 flex items-center gap-2">
                <code className="font-mono text-lg tracking-widest text-accent">{userCode}</code>
                <button
                  onClick={() => copy(userCode)}
                  className="shrink-0 rounded bg-edge px-2 py-0.5 text-[11px] text-ink hover:opacity-80"
                >
                  {copied === userCode ? "已复制 ✓" : "复制"}
                </button>
              </div>
            </div>
          )}
          {!verificationUri && !userCode && (
            <div className="rounded bg-panel2 p-3 text-xs text-muted">
              {active ? "等待 dreamina 输出授权信息…" : "未获取到授权信息。"}
              {lines.length > 0 && (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[10px]">
                  {allText}
                </pre>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 text-xs text-muted">
          {active
            ? "授权完成后登录自动生效，可关闭此窗口。"
            : "✓ 登录流程结束（即梦状态已刷新；仍不可用请重试或检查网络）。"}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-black hover:opacity-90"
          >
            {active ? "关闭（登录后台继续）" : "完成"}
          </button>
        </div>
      </div>
    </div>
  );
}
