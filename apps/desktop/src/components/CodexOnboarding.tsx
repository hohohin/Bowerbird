import { useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";

/** localStorage key：用户已看过/已跳过引导，不再自动弹出。 */
const SEEN_KEY = "bowerbird.onboardingSeen";

const STEPS: { n: number; title: string; cmd?: string; note: string }[] = [
  {
    n: 1,
    title: "安装 codex CLI",
    cmd: "npm install -g @openai/codex",
    note: "需要先装好 Node.js（npm 随 Node 附带）。",
  },
  {
    n: 2,
    title: "登录 ChatGPT 订阅",
    cmd: "codex login",
    note: "会打开浏览器授权，用你的 ChatGPT 账号（需 Plus / Pro 等订阅）。",
  },
  {
    n: 3,
    title: "回到这里点「重新检测」",
    note: "检测通过后即可使用反推、生成图、采集即命名。",
  },
];

/**
 * codex 首启引导（约定 7：离线/无账号降级的入口）。
 *
 * codexHealth 已由 App 挂载时取好并存进 store，这里不重复探测，仅消费。三态：
 * `null`（检测中，不闪）、`{ok:true}`（就绪，不显）、`{ok:false}`（未就绪，显引导）。
 * 用户点「稍后再说」或检测通过后写 localStorage，持久不再自动弹出。
 */
export function CodexOnboarding() {
  const codexHealth = useStore((s) => s.codexHealth);
  const setCodexHealth = useStore((s) => s.setCodexHealth);
  const [seen, setSeen] = useState(
    () => localStorage.getItem(SEEN_KEY) === "1"
  );
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);

  // 还没检测完 / 已就绪 / 已看过 → 不显示
  if (seen || !codexHealth || codexHealth.ok) return null;

  function dismiss() {
    localStorage.setItem(SEEN_KEY, "1");
    setSeen(true);
  }

  async function recheck() {
    setChecking(true);
    try {
      const h = await api.codexHealth();
      setCodexHealth(h);
      if (h.ok) {
        // 配好了：记 seen，之后即使状态变化也不再自动弹
        localStorage.setItem(SEEN_KEY, "1");
        setSeen(true);
      }
    } catch {
      setCodexHealth({ ok: false, reason: "codex 状态检测失败" });
    } finally {
      setChecking(false);
    }
  }

  function copy(step: number, text: string) {
    try {
      void navigator.clipboard.writeText(text);
      setCopied(step);
      setTimeout(() => setCopied((c) => (c === step ? null : c)), 1200);
    } catch {
      // 剪贴板不可用（如非安全上下文）时静默忽略，用户仍可手动选中复制
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-edge bg-panel p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-ink">配置 codex 以启用 AI 功能</h2>
        <p className="mt-1.5 text-sm text-muted">
          反推、生成图、采集即命名都依赖 codex CLI（走你的 ChatGPT 订阅）。不配置也能正常使用本地素材库——浏览、搜索、整理、收藏。
        </p>

        {/* 当前状态（复用后端 reason 文案） */}
        <div className="mt-4 rounded bg-red-500/15 p-2 text-xs text-red-300">
          当前状态：{codexHealth.reason}
        </div>

        <ol className="mt-4 space-y-3">
          {STEPS.map((s) => (
            <li key={s.n} className="text-sm">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                  {s.n}
                </span>
                <span className="text-ink">{s.title}</span>
              </div>
              {s.cmd && (
                <div className="mt-1.5 flex items-center gap-1.5 pl-7">
                  <code className="min-w-0 flex-1 truncate rounded bg-panel2 px-2 py-1 text-[12px] text-ink">
                    {s.cmd}
                  </code>
                  <button
                    onClick={() => copy(s.n, s.cmd!)}
                    className="shrink-0 rounded bg-panel2 px-2 py-1 text-[11px] text-muted hover:text-ink"
                  >
                    {copied === s.n ? "已复制" : "复制"}
                  </button>
                </div>
              )}
              <div className="mt-1 pl-7 text-xs text-muted">{s.note}</div>
            </li>
          ))}
        </ol>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={dismiss}
            className="rounded-md bg-panel2 px-3 py-1.5 text-sm text-ink hover:bg-edge"
          >
            稍后再说
          </button>
          <button
            onClick={() => void recheck()}
            disabled={checking}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50"
          >
            {checking ? "检测中…" : "重新检测"}
          </button>
        </div>
      </div>
    </div>
  );
}
