import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { api } from "../lib/api";
import guide1 from "../assets/bowerbird-extension-guide-1.gif";
import guide2 from "../assets/bowerbird-extension-guide-2.gif";
import guide3 from "../assets/bowerbird-extension-guide-3.gif";

/** localStorage key：用户已看过/已跳过引导，未连时不再自动弹出（点灰点仍可手动唤起）。 */
const SEEN_KEY = "bowerbird.extensionOnboardingSeen";
const EXT_PAGE_URL = "chrome://extensions";

/** 截图：限高 + 圆角边框，ml-7 与步骤编号对齐；点击放大（cursor-zoom-in 提示可点）。 */
function Shot({ src, alt, onZoom }: { src: string; alt: string; onZoom: () => void }) {
  return (
    <img
      src={src}
      alt={alt}
      onClick={onZoom}
      className="mt-1.5 ml-7 max-h-44 cursor-zoom-in rounded border border-edge hover:opacity-90"
    />
  );
}

/** 全屏放大查看（createPortal 到 document.body，z-[60] 盖过引导 z-50；Esc / 点背景 / ✕ 关闭）。 */
function ZoomImage({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4"
      onClick={onClose}
    >
      <img
        src={src}
        alt="示例图放大"
        className="max-h-[92vh] max-w-[92vw] rounded object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-lg text-white hover:bg-white/20"
        title="关闭（Esc）"
      >
        ✕
      </button>
    </div>,
    document.body
  );
}

/**
 * 扩展安装引导（约定 13 全屏 Modal 形态，类比 CodexOnboarding）。
 *
 * 显示条件：`forceOpen || (!extensionConnected && !seen)`。首启/未装自动弹（未连 + 未 seen）；
 * 用户点工具栏灰点可手动唤起（forceOpen）。扩展连上后自动关闭。
 *
 * 不自动打开 chrome://extensions / 文件夹——Windows 上 Chrome 单实例丢 URL、explorer 不认
 * 含 `..` 路径，都不稳。改为**一键复制 + 教用户粘贴**，小白照做即可。
 */
export function ExtensionOnboarding() {
  const connected = useStore((s) => s.extensionConnected);
  const forceOpen = useStore((s) => s.extensionOnboardingForceOpen);
  const setForceOpen = useStore((s) => s.setExtensionOnboardingForceOpen);
  const [seen, setSeen] = useState(() => localStorage.getItem(SEEN_KEY) === "1");
  const [copied, setCopied] = useState<string | null>(null); // "page" | "folder"
  const [zoom, setZoom] = useState<string | null>(null); // 放大的 gif src

  // 扩展连上后：清 forceOpen（避免断开后又自动弹）。
  useEffect(() => {
    if (connected) setForceOpen(false);
  }, [connected, setForceOpen]);

  if (connected) return null;
  if (!forceOpen && seen) return null;

  function dismiss() {
    localStorage.setItem(SEEN_KEY, "1");
    setSeen(true);
    setForceOpen(false);
  }

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1500);
    } catch {
      // 剪贴板不可用（如非安全上下文）时静默，用户仍可手动选中复制
    }
  }

  async function copyFolderPath() {
    try {
      const path = await api.extensionFolderPath();
      await copy(path, "folder");
    } catch {
      // 路径获取失败：静默（release resource 解析失败时用户可手动找）
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-edge bg-panel p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-ink">安装浏览器扩展以启用采集</h2>
        <p className="mt-1.5 text-sm text-muted">
          装好后，在任意网页拖图到右下角 Logo、点 Logo 批量采集、或 Alt+点击图片单张保存到 Bowerbird。
        </p>

        <ol className="mt-4 space-y-3 text-sm">
          <li>
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                1
              </span>
              <span className="text-ink">打开浏览器扩展管理页</span>
            </div>
            <div className="mt-1.5 pl-7">
              <button
                onClick={() => void copy(EXT_PAGE_URL, "page")}
                className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90"
              >
                {copied === "page" ? "已复制 ✓" : "一键复制 chrome://extensions"}
              </button>
              <div className="mt-1 text-xs text-muted">
                粘贴到 Chrome / Edge 地址栏并回车，进入扩展管理页。
              </div>
            </div>
            <Shot
              src={guide1}
              alt="地址栏粘贴 chrome://extensions 进入扩展管理页"
              onZoom={() => setZoom(guide1)}
            />
          </li>

          <li>
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                2
              </span>
              <span className="text-ink">打开「开发者模式」开关</span>
            </div>
            <div className="mt-1 pl-7 text-xs text-muted">
              Chrome：页面右上角的「开发者模式」开关；新版 Edge：左侧边栏底部。打开后才会出现「加载已解压」按钮。
            </div>
            <Shot src={guide2} alt="开发者模式开关位置" onZoom={() => setZoom(guide2)} />
          </li>

          <li>
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                3
              </span>
              <span className="text-ink">「加载已解压的扩展程序」并粘贴扩展文件夹路径</span>
            </div>
            <div className="mt-1.5 pl-7">
              <button
                onClick={() => void copyFolderPath()}
                className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90"
              >
                {copied === "folder" ? "已复制 ✓" : "一键复制扩展文件夹路径"}
              </button>
              <div className="mt-1 text-xs text-muted">
                回到扩展页点「加载已解压的扩展程序」，在弹出的对话框<b className="text-ink">顶部地址栏</b>粘贴此路径并回车，定位到扩展文件夹后点「选择文件夹」。
              </div>
            </div>
            <Shot
              src={guide3}
              alt="加载已解压对话框地址栏粘贴路径"
              onZoom={() => setZoom(guide3)}
            />
          </li>

          <li>
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                4
              </span>
              <span className="text-ink">装好后自动检测</span>
            </div>
            <div className="mt-1 pl-7 text-xs text-muted">
              扩展加载后约 15 秒内本窗口自动关闭，工具栏出现绿色圆点。
            </div>
          </li>
        </ol>

        <div className="mt-6 flex justify-end">
          <button
            onClick={dismiss}
            className="rounded-md bg-panel2 px-3 py-1.5 text-sm text-ink hover:bg-edge"
          >
            稍后再说
          </button>
        </div>
      </div>

      {zoom && <ZoomImage src={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}
