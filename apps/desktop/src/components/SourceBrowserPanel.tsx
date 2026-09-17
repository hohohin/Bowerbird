import { type FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import {
  ArrowLeft,
  ArrowRight,
  Compass,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  X,
} from "lucide-react";
import { api, type SourceBrowserBounds } from "../lib/api";
import { normalizeSourceAddress, sourceDiscoveryFor } from "../lib/sourceDiscovery";
import { EXPLORER_SITES, queueBrowserOperation } from "../lib/explorer";

const STATUS_EVENT = "source-browser://status";
const TITLE_EVENT = "source-browser://title";
const NEW_WINDOW_EVENT = "source-browser://new-window";

interface BrowserStatus {
  url: string;
  loading: boolean;
}

function boundsFor(element: HTMLElement): SourceBrowserBounds {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function hostnameFor(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "来源网站";
  }
}

export function SourceBrowserPanel({ url, onClose, visible = true, suspended = false, navigationId = 0 }: { url: string; onClose: () => void; visible?: boolean; suspended?: boolean; navigationId?: number }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressFocusedRef = useRef(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const openedRef = useRef(false);
  const requestedUrlRef = useRef({ url, navigationId });
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [currentUrl, setCurrentUrl] = useState(url);
  const [address, setAddress] = useState(url);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [occluded, setOccluded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const discovery = useMemo(() => sourceDiscoveryFor(currentUrl), [currentUrl]);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const browserAction = useCallback((operation: () => Promise<void>) => {
    void queueBrowserOperation(operation).catch(cause => setError(String(cause)));
  }, []);

  const navigate = useCallback(async (nextUrl: string) => {
    const normalized = normalizeSourceAddress(nextUrl);
    if (!normalized) {
      setError("请输入有效的 HTTP(S) 网址");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await queueBrowserOperation(() => api.navigateSourceBrowser(normalized));
      setCurrentUrl(normalized);
      setAddress(normalized);
    } catch (cause) {
      setLoading(false);
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    try { if (normalizeSourceAddress(currentUrl)) localStorage.setItem("bowerbird.explorer.lastUrl", currentUrl); } catch { /* unavailable storage */ }
  }, [currentUrl]);

  useEffect(() => {
    let alive = true;
    let unlisteners: UnlistenFn[] = [];
    Promise.all([
      listen<BrowserStatus>(STATUS_EVENT, ({ payload }) => {
        setCurrentUrl(payload.url);
        if (!addressFocusedRef.current) setAddress(payload.url);
        setLoading(payload.loading);
        if (!payload.loading) setError(null);
      }),
      listen<string>(TITLE_EVENT, ({ payload }) => setTitle(payload)),
      listen<string>(NEW_WINDOW_EVENT, ({ payload }) => void navigate(payload)),
    ]).then((registered) => {
      if (alive) unlisteners = registered;
      else registered.forEach((unlisten) => unlisten());
    });
    return () => {
      alive = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [navigate]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !visible) return;

    let alive = true;
    let openFrame = 0;
    let resizeFrame = 0;
    let lastLayout: string | null = null;
    const resize = () => {
      if (!alive) return;
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        if (!alive || !visibleRef.current || !openedRef.current) return;
        const bounds = boundsFor(viewport);
        if (bounds.width < 240 || bounds.height < 180) return;
        const viewportRect = viewport.getBoundingClientRect();
        const overlay = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], .caption-ring-layer, .app-sidebar.is-auto-hide:not(.is-auto-hidden)'))
          .some(element => {
            if (element.getClientRects().length === 0 || getComputedStyle(element).visibility === "hidden") return false;
            // Dialogs and the dimension ring have full-window backdrops. The
            // native webpage must yield until they close, regardless of z-index.
            if (element.matches('[role="dialog"], [role="alertdialog"], .caption-ring-layer')) return true;
            const rect = element.getBoundingClientRect();
            // Use the drawer's destination while it slides in; WebView2 must yield before it covers the controls.
            if (element.matches(".app-sidebar.is-auto-hide")) {
              const left = element.parentElement!.getBoundingClientRect().left;
              return left < viewportRect.right && left + rect.width > viewportRect.left
                && rect.top < viewportRect.bottom && rect.bottom > viewportRect.top;
            }
            return rect.left < viewportRect.right && rect.right > viewportRect.left
              && rect.top < viewportRect.bottom && rect.bottom > viewportRect.top;
          });
        const hidden = overlay || suspendedRef.current;
        setOccluded(hidden);
        const dimmed = !!document.querySelector("[data-onboarding-dim-browser]");
        const layout = JSON.stringify([bounds, hidden, dimmed]);
        if (lastLayout === layout) return;
        lastLayout = layout;
        void queueBrowserOperation(() => api.resizeSourceBrowser(bounds, !hidden, dimmed)).catch((cause) => {
          if (lastLayout === layout) lastLayout = null;
          if (alive) setError(String(cause));
        });
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    const overlays = new MutationObserver(resize);
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "hidden", "style", "class"] });
    window.addEventListener("resize", resize);
    window.addEventListener("explorer:layout", resize);

    openFrame = window.requestAnimationFrame(() => {
      void queueBrowserOperation(async () => {
        if (!openedRef.current) {
          await api.openSourceBrowser(url, boundsFor(viewport));
          openedRef.current = true;
        }
        const previous = requestedUrlRef.current;
        if (previous.url !== url || previous.navigationId !== navigationId) {
          await api.navigateSourceBrowser(url);
          requestedUrlRef.current = { url, navigationId };
        }
      }).then(resize).catch((cause) => {
        if (alive) {
          setLoading(false);
          setError(String(cause));
        }
      });
    });

    return () => {
      alive = false;
      observer.disconnect();
      overlays.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("explorer:layout", resize);
      window.cancelAnimationFrame(openFrame);
      window.cancelAnimationFrame(resizeFrame);
      void queueBrowserOperation(() => api.hideSourceBrowser()).catch(() => {});
    };
  }, [visible, url, navigationId]);

  useEffect(() => { window.dispatchEvent(new Event("explorer:layout")); }, [suspended]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!visibleRef.current || event.defaultPrevented || suspendedRef.current || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        addressRef.current?.focus();
        addressRef.current?.select();
      } else if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        browserAction(() => api.sourceBrowserBack());
      } else if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        browserAction(() => api.sourceBrowserForward());
      } else if (event.key === "Escape" && document.activeElement !== addressRef.current) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, browserAction]);

  function submitAddress(event: FormEvent) {
    event.preventDefault();
    addressRef.current?.blur();
    void navigate(address);
  }

  function openExternal() {
    void open(currentUrl).catch((cause) => setError(String(cause)));
  }

  const host = hostnameFor(currentUrl);
  return (
    <section className="source-browser-panel" aria-label="探索浏览器">
      <header className="source-browser-header">
        <div className="source-browser-heading">
          <span className="source-browser-mark"><Compass size={16} /></span>
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-ink">{title || discovery?.actionLabel || "素材发现"}</div>
            <div className="truncate text-[10px] text-muted">探索 · {host}</div>
          </div>
        </div>

        <div className="source-browser-nav" aria-label="网页导航">
          <button type="button" onClick={() => browserAction(() => api.sourceBrowserBack())} title="返回上一页" aria-label="返回上一页">
            <ArrowLeft size={15} />
          </button>
          <button type="button" onClick={() => browserAction(() => api.sourceBrowserForward())} title="前往下一页" aria-label="前往下一页">
            <ArrowRight size={15} />
          </button>
          <button type="button" onClick={() => browserAction(() => api.reloadSourceBrowser())} title="刷新" aria-label="刷新">
            {loading ? <LoaderCircle size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          </button>
        </div>

        <form className="source-browser-address" onSubmit={submitAddress}>
          <LockKeyhole size={12} aria-hidden />
          <input
            ref={addressRef}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={() => { addressFocusedRef.current = true; }}
            onBlur={() => { addressFocusedRef.current = false; }}
            aria-label="网页地址"
            spellCheck={false}
          />
        </form>

        <div className="source-browser-actions">
          <button type="button" onClick={openExternal} title="用系统浏览器打开" aria-label="用系统浏览器打开">
            <ExternalLink size={15} />
          </button>
          <button type="button" onClick={onClose} title="收起浏览器" aria-label="收起浏览器">
            <X size={16} />
          </button>
        </div>
      </header>

      <nav className="explore-sites" aria-label="探索网站">
        {EXPLORER_SITES.map(site => <button key={site.name} type="button" onClick={() => void navigate(site.url)}>{site.name}</button>)}
        <span>登录状态保存在本机</span>
      </nav>

      {error && <div className="source-browser-error" role="alert">{error}</div>}
      <div ref={viewportRef} className="source-browser-viewport" data-source-browser-viewport>
        <div className="source-browser-placeholder" aria-hidden>
          {occluded ? "网页暂时隐藏，操作结束后恢复" : loading ? <><LoaderCircle size={20} className="animate-spin" />正在打开 {host}</> : "网页已就绪"}
        </div>
      </div>
    </section>
  );
}
