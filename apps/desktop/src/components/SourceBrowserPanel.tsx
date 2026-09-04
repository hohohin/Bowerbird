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

export function SourceBrowserPanel({ url, onClose }: { url: string; onClose: () => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressFocusedRef = useRef(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [address, setAddress] = useState(url);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const discovery = useMemo(() => sourceDiscoveryFor(currentUrl), [currentUrl]);

  const navigate = useCallback(async (nextUrl: string) => {
    const normalized = normalizeSourceAddress(nextUrl);
    if (!normalized) {
      setError("请输入有效的 HTTP(S) 网址");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await api.navigateSourceBrowser(normalized);
      setCurrentUrl(normalized);
      setAddress(normalized);
    } catch (cause) {
      setLoading(false);
      setError(String(cause));
    }
  }, []);

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
    if (!viewport) return;

    let alive = true;
    let openFrame = 0;
    let resizeFrame = 0;
    const resize = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        void api.resizeSourceBrowser(boundsFor(viewport)).catch((cause) => {
          if (alive) setError(String(cause));
        });
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);

    openFrame = window.requestAnimationFrame(() => {
      void api.openSourceBrowser(url, boundsFor(viewport)).catch((cause) => {
        if (alive) {
          setLoading(false);
          setError(String(cause));
        }
      });
    });

    return () => {
      alive = false;
      observer.disconnect();
      window.cancelAnimationFrame(openFrame);
      window.cancelAnimationFrame(resizeFrame);
      void api.hideSourceBrowser();
    };
  }, [url]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        addressRef.current?.focus();
        addressRef.current?.select();
      } else if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        void api.sourceBrowserBack();
      } else if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        void api.sourceBrowserForward();
      } else if (event.key === "Escape" && document.activeElement !== addressRef.current) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
    <section className="source-browser-panel" aria-label="素材发现浏览器">
      <header className="source-browser-header">
        <div className="source-browser-heading">
          <span className="source-browser-mark"><Compass size={16} /></span>
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-ink">{title || discovery?.actionLabel || "素材发现"}</div>
            <div className="truncate text-[10px] text-muted">从原素材继续探索 · {host}</div>
          </div>
        </div>

        <div className="source-browser-nav" aria-label="网页导航">
          <button type="button" onClick={() => void api.sourceBrowserBack()} title="返回上一页" aria-label="返回上一页">
            <ArrowLeft size={15} />
          </button>
          <button type="button" onClick={() => void api.sourceBrowserForward()} title="前往下一页" aria-label="前往下一页">
            <ArrowRight size={15} />
          </button>
          <button type="button" onClick={() => void api.reloadSourceBrowser()} title="刷新" aria-label="刷新">
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
          <button type="button" onClick={onClose} title="关闭素材发现" aria-label="关闭素材发现">
            <X size={16} />
          </button>
        </div>
      </header>

      {error && <div className="source-browser-error" role="alert">{error}</div>}
      <div ref={viewportRef} className="source-browser-viewport" data-source-browser-viewport>
        <div className="source-browser-placeholder" aria-hidden>
          <LoaderCircle size={20} className="animate-spin" />
          正在打开 {host}
        </div>
      </div>
    </section>
  );
}
