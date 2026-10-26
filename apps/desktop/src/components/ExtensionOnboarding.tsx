import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { CheckCircle2, ChevronDown, Copy, LoaderCircle, RefreshCw, Unplug, X } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { userErrorMessage } from "../lib/userError";
import guide1 from "../assets/bowerbird-extension-guide-1.gif";
import guide2 from "../assets/bowerbird-extension-guide-2.gif";
import guide3 from "../assets/bowerbird-extension-guide-3.gif";
import guide4 from "../assets/bowerbird-extension-guide-4.png";
import { ModalShell } from "./ModalShell";
import "./BrowserExtension.css";

type Browser = "Chrome" | "Edge";
const EXTENSION_PAGES: Record<Browser, string> = { Chrome: "chrome://extensions", Edge: "edge://extensions" };

function Shot({ src, alt, onZoom }: { src: string; alt: string; onZoom: () => void }) {
  return <button type="button" className="extension-guide-shot" onClick={onZoom} aria-label={`放大：${alt}`}>
    <img src={src} alt={alt} />
  </button>;
}

function ZoomImage({ src, onClose }: { src: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") { event.preventDefault(); closeRef.current?.focus(); }
    }
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/90 p-4" role="dialog" aria-modal="true" aria-label="示例图放大" onClick={onClose}>
      <img src={src} alt="浏览器插件配置示例" className="max-h-[92vh] max-w-[92vw] rounded object-contain" onClick={(event) => event.stopPropagation()} />
      <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭示例图" className="app-modal-close absolute right-3 top-3"><X size={18} aria-hidden /></button>
    </div>, document.body,
  );
}

/** Only mounted after an explicit entry click; connection events never dismiss the user's tutorial. */
function ExtensionPanel({ onClose }: { onClose: () => void }) {
  const connected = useStore((state) => state.extensionConnected);
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [showTutorial, setShowTutorial] = useState(false);
  const [browser, setBrowser] = useState<Browser>("Chrome");
  const [folderPath, setFolderPath] = useState("");
  const [folderLoading, setFolderLoading] = useState(true);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const request = useRef(0);
  const folderRequest = useRef(0);
  const copyRequest = useRef(0);
  const connectionRevision = useRef(0);
  const alive = useRef(true);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>();
  const closeZoom = useCallback(() => setZoom(null), []);

  const checkConnection = useCallback(async (initial = false) => {
    const currentRequest = ++request.current;
    const revision = connectionRevision.current;
    setChecking(true);
    setStatusError(null);
    try {
      const result = await api.extensionStatus();
      if (!alive.current || currentRequest !== request.current) return;
      // A live connection event received during this query is newer than its snapshot.
      const current = revision === connectionRevision.current ? result : useStore.getState().extensionConnected;
      if (revision === connectionRevision.current) useStore.getState().setExtensionConnected(current);
      if (initial) setShowTutorial(!current);
    } catch (error) {
      if (!alive.current || currentRequest !== request.current) return;
      if (revision === connectionRevision.current) {
        setStatusError(userErrorMessage(error, "连接状态暂时无法读取，请稍后重新检测。"));
      }
      if (initial) setShowTutorial(true);
    } finally {
      if (alive.current && currentRequest === request.current) { setReady(true); setChecking(false); }
    }
  }, []);

  const loadFolder = useCallback(async () => {
    const currentRequest = ++folderRequest.current;
    setFolderLoading(true);
    setFolderError(null);
    try {
      const path = await api.extensionFolderPath();
      if (alive.current && currentRequest === folderRequest.current) setFolderPath(path);
    } catch (error) {
      if (alive.current && currentRequest === folderRequest.current) {
        setFolderError(userErrorMessage(error, "插件文件夹暂时无法读取，请重新获取路径。"));
      }
    } finally {
      if (alive.current && currentRequest === folderRequest.current) setFolderLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    let active = true;
    const unlisteners: UnlistenFn[] = [];
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.extensionConnected !== previous.extensionConnected) {
        connectionRevision.current += 1;
        setStatusError(null);
      }
    });
    const recordConnection = (value: boolean) => {
      if (!active) return;
      // Repeated heartbeats are newer evidence even when the boolean stays the same.
      connectionRevision.current += 1;
      useStore.getState().setExtensionConnected(value);
      setStatusError(null);
    };
    void Promise.allSettled([
      listen("collect://extension-connected", () => recordConnection(true)),
      listen("collect://extension-disconnected", () => recordConnection(false)),
    ].map(registration => registration.then(unlisten => {
      if (active) unlisteners.push(unlisten);
      else unlisten();
    }))).then(results => {
      if (!active) return;
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") {
        setStatusError(userErrorMessage(failed.reason, "连接状态暂时无法读取，请稍后重新检测。"));
        setReady(true);
        setChecking(false);
        setShowTutorial(true);
      } else {
        void checkConnection(true);
      }
    });
    void loadFolder();
    return () => {
      active = false;
      alive.current = false;
      request.current += 1;
      folderRequest.current += 1;
      copyRequest.current += 1;
      unsubscribe();
      unlisteners.forEach(unlisten => unlisten());
      clearTimeout(copiedTimer.current);
    };
  }, [checkConnection, loadFolder]);

  async function copy(text: string, tag: string) {
    const currentRequest = ++copyRequest.current;
    clearTimeout(copiedTimer.current);
    setCopied(null);
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(text);
      if (!alive.current || currentRequest !== copyRequest.current) return;
      setCopied(tag);
      copiedTimer.current = setTimeout(() => setCopied(null), 1800);
    } catch (error) {
      if (alive.current && currentRequest === copyRequest.current) {
        setCopied(null);
        setCopyError(userErrorMessage(error, "复制未完成，请选中下方地址或路径后手动复制。"));
      }
    }
  }

  return <>
    <ModalShell title="浏览器插件" eyebrow="Browser collection" description="在 Chrome 或 Edge 中采集网页图片，连接到当前 Bowerbird 应用。" width="lg" className="extension-setup" preventClose={zoom !== null} onClose={onClose}
      footer={<button type="button" onClick={onClose} className="app-modal-button">完成</button>}>
      <section className="setup-card extension-setup-status" aria-label="插件连接状态" aria-busy={checking}>
        <div className="extension-setup-status-copy" aria-live="polite">
          {checking ? <LoaderCircle size={19} className="animate-spin" aria-hidden /> : connected && !statusError ? <CheckCircle2 size={19} aria-hidden /> : <Unplug size={19} aria-hidden />}
          <div>
            <strong>{checking ? "正在检测…" : statusError ? "暂时无法确认连接状态" : connected ? "已连接" : "未连接"}</strong>
            <p>{checking ? "正在检查浏览器与应用的连接。" : statusError ? "可继续查看安装教程，稍后再检查连接。" : connected ? "已收到浏览器插件的连接信号，可以开始采集。" : "未连接不代表未安装。请保持应用运行，并在浏览器中打开或刷新一个普通网页。"}</p>
          </div>
        </div>
        <button type="button" onClick={() => void checkConnection()} disabled={checking} className="app-modal-button"><RefreshCw size={14} aria-hidden />{checking ? "正在检测…" : "重新检测"}</button>
      </section>
      {statusError && <p className="extension-setup-error" role="alert">{userErrorMessage(statusError, "连接状态暂时无法读取，请稍后重新检测。")}</p>}

      {ready && <>
        <section className="extension-setup-usage" aria-label="采集使用方法">
          <h3>如何采集</h3>
          <p>在普通网页中，点击右下角的 Bowerbird 按钮批量采集本页图片，或按住 Alt 点击单张图片。也可以将图片拖到右下角 Bowerbird 按钮。</p>
          <p>采集后在项目素材或收集箱查看，再按需拖入画板。内置探索浏览器仍可直接拖图，无需安装插件。</p>
        </section>
        <button type="button" className="app-modal-button extension-setup-toggle" onClick={() => setShowTutorial(value => !value)} aria-expanded={showTutorial} aria-controls="extension-install-guide">
          安装或更新教程<ChevronDown size={15} aria-hidden className={showTutorial ? "rotate-180" : ""} />
        </button>
        {showTutorial && <div id="extension-install-guide" className="extension-install-guide">
          <div className="extension-browser-choice" role="group" aria-label="选择浏览器">
            {(["Chrome", "Edge"] as const).map(name => <button key={name} type="button" className="app-modal-button" aria-pressed={browser === name} onClick={() => { copyRequest.current += 1; clearTimeout(copiedTimer.current); setBrowser(name); setCopied(null); setCopyError(null); }}>{name}</button>)}
          </div>
          {copyError && <p className="extension-setup-error" role="alert">{userErrorMessage(copyError, "复制未完成，请选中下方地址或路径后手动复制。")}</p>}
          <ol className="extension-guide-steps">
            <li className="setup-card">
              <h3><span>1</span>打开扩展管理页</h3>
              <p>复制下方地址，粘贴到 {browser} 地址栏并回车。</p>
              <div className="extension-copy-row">
                <input aria-label={`${browser} 扩展页地址`} value={EXTENSION_PAGES[browser]} readOnly onFocus={event => event.currentTarget.select()} />
                <button type="button" className="app-modal-button" aria-label={`复制 ${browser} 扩展页地址`} onClick={() => void copy(EXTENSION_PAGES[browser], "page")}><Copy size={14} aria-hidden />{copied === "page" ? "已复制" : "复制地址"}</button>
              </div>
              {browser === "Chrome" && <Shot src={guide1} alt="在地址栏打开扩展管理页" onZoom={() => setZoom(guide1)} />}
            </li>
            <li className="setup-card">
              <h3><span>2</span>开启开发者模式</h3>
              <p>在扩展管理页找到并开启「开发者模式」，随后选择「加载已解压的扩展程序」（Edge 中可能显示「加载解压缩的扩展」）。</p>
              {browser === "Chrome" && <Shot src={guide2} alt="开发者模式开关" onZoom={() => setZoom(guide2)} />}
            </li>
            <li className="setup-card">
              <h3><span>3</span>选择插件文件夹</h3>
              <p>复制当前应用提供的路径，在文件夹选择窗口中粘贴后确认。</p>
              <div className="extension-copy-row">
                <input aria-label="插件文件夹路径" value={folderPath} placeholder={folderLoading ? "正在读取插件路径…" : "插件路径暂不可用"} readOnly onFocus={event => event.currentTarget.select()} />
                <button type="button" className="app-modal-button" disabled={folderLoading || !folderPath} aria-label="复制插件文件夹路径" onClick={() => void copy(folderPath, "folder")}><Copy size={14} aria-hidden />{copied === "folder" ? "已复制" : "复制路径"}</button>
              </div>
              {folderError && <div><p className="extension-setup-error" role="alert">{userErrorMessage(folderError, "插件文件夹暂时无法读取，请重新获取路径。")}</p><button type="button" className="app-modal-button" disabled={folderLoading} aria-label="重新获取插件文件夹路径" onClick={() => void loadFolder()}>重新获取路径</button></div>}
              <p>Windows：粘贴到窗口顶部地址栏。macOS：按 ⌘⇧G，粘贴路径并回车，再选择该文件夹。</p>
              {browser === "Chrome" && <Shot src={guide3} alt="在文件夹选择窗口中粘贴路径" onZoom={() => setZoom(guide3)} />}
            </li>
            <li className="setup-card">
              <h3><span>4</span>刷新网页并检查连接</h3>
              <p>保持 Bowerbird 运行，打开或刷新带图片的普通网页，右下角会出现 Bowerbird 按钮。浏览器新标签页和扩展管理页不支持采集。</p>
              <p>返回这里查看连接状态；连接变化可能需要等待片刻，也可以点击「重新检测」。</p>
              <Shot src={guide4} alt="网页右下角的 Bowerbird 按钮" onZoom={() => setZoom(guide4)} />
            </li>
          </ol>
          <section className="setup-card extension-update-guide" aria-label="更新已有插件">
            <h3>已安装旧版插件</h3>
            <p>应用更新后，在扩展管理页找到 Bowerbird，点击「重新加载」或刷新图标，再刷新已打开的网页。如果旧插件来自其他文件夹，请移除旧插件后，使用上方当前路径重新加载。</p>
            <p>仍未连接时，请检查插件是否启用，并确认没有同时运行多个 Bowerbird 应用。</p>
          </section>
          <div className="sr-only" role="status">{copied === "page" ? "扩展页地址已复制" : copied === "folder" ? "插件文件夹路径已复制" : ""}</div>
        </div>}
      </>}
    </ModalShell>
    {zoom && <ZoomImage src={zoom} onClose={closeZoom} />}
  </>;
}

export function ExtensionOnboarding() {
  const forceOpen = useStore((state) => state.extensionOnboardingForceOpen);
  const setForceOpen = useStore((state) => state.setExtensionOnboardingForceOpen);
  return forceOpen ? <ExtensionPanel onClose={() => setForceOpen(false)} /> : null;
}
