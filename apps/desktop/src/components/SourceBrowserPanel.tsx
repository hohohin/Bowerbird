import { userErrorMessage } from "../lib/userError";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import {
  ArrowLeft,
  ArrowRight,
  Compass,
  ExternalLink,
  LoaderCircle,
  Puzzle,
  RefreshCw,
} from "lucide-react";
import { api, type SourceBrowserBounds } from "../lib/api";
import { normalizeSourceAddress, rememberSourceAddress } from "../lib/sourceDiscovery";
import { queueBrowserOperation } from "../lib/explorer";
import { cancelPinterestSearch, isPinterestSearchCurrent, PINTEREST_SEARCH_EVENT, PINTEREST_SEARCH_URL, receivePinterestSearchStatus, usePinterestSearch, type PinterestSearchStatus } from "../lib/pinterestSearch";
import { useStore } from "../store";
import "./BrowserExtension.css";
import { VideoCollectionEntry } from "./VideoCollectionEntry";
import { ExplorerCaptureHistory } from "./ExplorerCaptureHistory";
import { ExploreSiteShortcuts } from "./ExploreSiteShortcuts";
import { SourceBrowserAddress } from "./SourceBrowserAddress";
import "./SourceBrowserControls.css";

const STATUS_EVENT = "source-browser://status";
const LOCATION_EVENT = "source-browser://location";
const TITLE_EVENT = "source-browser://title";
const NEW_WINDOW_EVENT = "source-browser://new-window";
const DIM_BROWSER_SELECTOR = "[data-onboarding-dim-browser]";
const HANDLE_SHAPE_SELECTOR = ".explore-panel-handle .canvas-library-tab-shape";
const OVERLAY_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .caption-ring-layer, .external-drag-backdrop, .app-sidebar.is-auto-hide';
const LAYOUT_SELECTOR = `${OVERLAY_SELECTOR}, ${DIM_BROWSER_SELECTOR}, ${HANDLE_SHAPE_SELECTOR}, .app-sidebar-host`;
const BLOCKING_SHORTCUT_SELECTOR = 'dialog:modal, [aria-modal="true"], [role="alertdialog"], [role="menu"]';

interface BrowserStatus {
  url: string;
  loading: boolean;
}

function boundsFor(element: HTMLElement, rect: DOMRect): SourceBrowserBounds {
  const bounds: SourceBrowserBounds = {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  const shape = element.closest(".explore-browser")?.querySelector(HANDLE_SHAPE_SELECTOR);
  if (shape && rect.width > 0 && rect.height > 0) {
    const tab = shape.getBoundingClientRect();
    const scaleX = bounds.width / rect.width, scaleY = bounds.height / rect.height;
    const x = Math.max(0, (tab.left - rect.left) * scaleX), y = Math.max(0, (tab.top - rect.top) * scaleY);
    const width = Math.min(bounds.width, (tab.right - rect.left) * scaleX) - x;
    const height = Math.min(bounds.height, (tab.bottom - rect.top) * scaleY) - y;
    if (width > 0 && height > 0) {
      const cut = Math.max(0, Math.min(Number(shape.getAttribute("data-overlay-cut")) || 0, width / 2, height / 2));
      const side = shape.getAttribute("data-overlay-side");
      bounds.overlay = {
        x: Math.min(x, bounds.width - width), y: Math.min(y, bounds.height - height), width, height, cut,
        side: side === "left" || side === "right" ? side : undefined,
      };
    }
  }
  return bounds;
}

function occludesViewport(element: Element, viewport: DOMRect): boolean {
  if (element.matches("dialog:not([open]), .app-sidebar.is-auto-hidden") || !isVisible(element)) return false;
  // Modal interaction and full-window veils block the page. Other popovers
  // only interfere when they overlap the native child.
  if (element.matches('[aria-modal="true"], :modal, .caption-ring-layer, .external-drag-backdrop')) return true;
  const rect = element.getBoundingClientRect();
  return !!rect.width && !!rect.height && rect.left < viewport.right && rect.right > viewport.left
    && rect.top < viewport.bottom && rect.bottom > viewport.top;
}

function isVisible(element: Element): boolean {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
}

function hostnameFor(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "来源网站";
  }
}

export function SourceBrowserPanel({ url, onClose, onCreateProject, leadingControls, visible = true, suspended = false, navigationId = 0, closeOnEscape = false }: {
  url: string;
  onClose: () => void;
  visible?: boolean;
  suspended?: boolean;
  navigationId?: number;
  closeOnEscape?: boolean;
  onCreateProject?: (ids?: string[]) => Promise<unknown>;
  leadingControls?: ReactNode;
}) {
  const projectId = useStore(state => state.activeProjectId);
  const openExtension = useStore((state) => state.setExtensionOnboardingForceOpen);
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const requestedUrlRef = useRef({ url, navigationId });
  const appliedNavigationRef = useRef<typeof requestedUrlRef.current | null>(null);
  const openingAddressRef = useRef(url);
  const [opened, setOpened] = useState(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [currentUrl, setCurrentUrl] = useState(url);
  const [addressHistory, setAddressHistory] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [occluded, setOccluded] = useState(false);
  const [tooSmall, setTooSmall] = useState(false);
  const [navigationHint, setNavigationHint] = useState("");
  const [error, setError] = useState<string | null>(null);
  const search = usePinterestSearch(state => state.request);
  const searchProgress = usePinterestSearch(state => state.progress);
  const submittedSearchRef = useRef<string | null>(null);
  const listenersReadyRef = useRef<Promise<void>>(Promise.resolve());
  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    if (wasVisibleRef.current && !visible) cancelPinterestSearch();
    wasVisibleRef.current = visible;
  }, [visible]);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const browserAction = useCallback((operation: () => Promise<void>) => {
    if (!appliedNavigationRef.current) return;
    addressRef.current?.blur();
    cancelPinterestSearch();
    setNavigationHint("");
    setError(null);
    void queueBrowserOperation(operation).catch(cause => {
      const message = String(cause);
      const boundary = message.match(/没有可(?:返回的上一页|前往的下一页)/);
      if (boundary) setNavigationHint(boundary[0]);
      else setError(message);
    });
  }, []);

  const navigate = useCallback(async (nextUrl: string, manual = true) => {
    const normalized = normalizeSourceAddress(nextUrl);
    if (!normalized) {
      setError("网址格式不正确，请复制浏览器地址栏中的完整网址。");
      return;
    }
    if (manual) cancelPinterestSearch();
    setNavigationHint("");
    setError(null);
    setLoading(true);
    if (!appliedNavigationRef.current) {
      openingAddressRef.current = normalized;
      window.dispatchEvent(new Event("explorer:layout"));
    }
    try {
      await queueBrowserOperation(async () => {
        if (appliedNavigationRef.current) await api.navigateSourceBrowser(normalized);
      });
      setCurrentUrl(normalized);
    } catch (cause) {
      setLoading(false);
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    rememberSourceAddress(currentUrl);
  }, [currentUrl]);

  useEffect(() => {
    let alive = true;
    let unlisteners: UnlistenFn[] = [];
    const recordVisit = (url: string) => {
      const address = normalizeSourceAddress(url);
      // Keep recent addresses for this session. The existing last-URL memory
      // is still the only persisted record of ordinary navigation.
      if (address) setAddressHistory(history => history[0] === address
        ? history : [address, ...history.filter(item => item !== address)].slice(0, 20));
    };
    listenersReadyRef.current = Promise.all([
      listen<BrowserStatus>(STATUS_EVENT, ({ payload }) => {
        setCurrentUrl(payload.url);
        setLoading(payload.loading);
        if (payload.loading) setNavigationHint("");
        if (!payload.loading) {
          setError(null);
          recordVisit(payload.url);
        }
      }),
      listen<string>(LOCATION_EVENT, ({ payload }) => {
        setCurrentUrl(payload);
        setNavigationHint("");
        recordVisit(payload);
      }),
      listen<string>(TITLE_EVENT, ({ payload }) => setTitle(payload)),
      listen<string>(NEW_WINDOW_EVENT, ({ payload }) => void navigate(payload, false)),
      listen<PinterestSearchStatus>(PINTEREST_SEARCH_EVENT, ({ payload }) => receivePinterestSearchStatus(payload)),
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
    let attemptedOpen = false;
    let frame: number | null = null;
    let lastBounds: SourceBrowserBounds | null = null;
    let lastLayout: { key: string } | null = null;
    let layoutTargets = new Set<Element>();
    let overlayAncestors = new Set<Element>();
    let sidebarHosts = new Set<Element>();

    const resize = () => {
      if (!alive || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const viewportRect = viewport.getBoundingClientRect();
        const measured = boundsFor(viewport, viewportRect);
        const undersized = measured.width < 240 || measured.height < 180;
        if (!undersized) lastBounds = measured;
        setTooSmall(undersized);

        const targets = Array.from(document.querySelectorAll(LAYOUT_SELECTOR));
        layoutTargets = new Set(targets);
        overlayAncestors = new Set();
        const nextSidebarHosts = new Set<Element>();
        for (const target of targets) {
          for (let parent = target.parentElement; parent; parent = parent.parentElement) overlayAncestors.add(parent);
          if (target.matches(".app-sidebar-host")) {
            nextSidebarHosts.add(target);
            if (!sidebarHosts.has(target)) sizeObserver.observe(target);
          }
        }
        for (const host of sidebarHosts) if (!nextSidebarHosts.has(host)) sizeObserver.unobserve(host);
        sidebarHosts = nextSidebarHosts;

        const hidden = suspendedRef.current || targets.some(
          target => target.matches(OVERLAY_SELECTOR) && occludesViewport(target, viewportRect),
        );
        setOccluded(hidden);
        const bounds = lastBounds;
        if (!bounds) return;
        const show = !hidden && !undersized;
        const dimmed = targets.some(target => target.matches(DIM_BROWSER_SELECTOR));
        const key = JSON.stringify([bounds, show, dimmed]);
        if (lastLayout?.key === key) return;
        const layout = { key };
        lastLayout = layout;
        void queueBrowserOperation(async () => {
          if (!alive || lastLayout !== layout) return;
          if (!appliedNavigationRef.current) {
            if (!show) return;
            await listenersReadyRef.current;
            if (!alive || lastLayout !== layout) return;
            const request = requestedUrlRef.current;
            attemptedOpen = true;
            await api.openSourceBrowser(openingAddressRef.current, bounds);
            appliedNavigationRef.current = request;
            setOpened(true);
          }
          if (alive && lastLayout === layout) await api.resizeSourceBrowser(bounds, show, dimmed);
        }).catch((cause) => {
          if (lastLayout === layout) lastLayout = null;
          if (alive) {
            setLoading(false);
            setError(String(cause));
          }
        });
      });
    };
    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(viewport);

    // Portals and inline popovers have different hosts. Filter DOM changes
    // before reading geometry, especially canvas and dimension ring animation.
    const isLayoutTarget = (element: Element) => layoutTargets.has(element) || element.matches(LAYOUT_SELECTOR);
    const affectsLayout = (mutation: MutationRecord): boolean => {
      if (mutation.type === "attributes" && mutation.target instanceof Element) {
        const target = mutation.target;
        return isLayoutTarget(target) || overlayAncestors.has(target);
      }
      return [...mutation.addedNodes, ...mutation.removedNodes].some(
        node => node instanceof Element && (isLayoutTarget(node) || !!node.querySelector(LAYOUT_SELECTOR)),
      );
    };
    const overlays = new MutationObserver(records => {
      if (records.some(affectsLayout)) resize();
    });
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["role", "aria-modal", "open", "hidden", "style", "class", "data-onboarding-dim-browser", "data-overlay-side", "data-overlay-cut"] });
    const overlayTransition = (event: TransitionEvent) => {
      if (event.target instanceof Element && isLayoutTarget(event.target)) resize();
    };
    document.addEventListener("transitionend", overlayTransition, true);
    document.addEventListener("transitioncancel", overlayTransition, true);
    window.addEventListener("resize", resize);
    window.addEventListener("explorer:layout", resize);
    resize();

    return () => {
      alive = false;
      sizeObserver.disconnect();
      overlays.disconnect();
      document.removeEventListener("transitionend", overlayTransition, true);
      document.removeEventListener("transitioncancel", overlayTransition, true);
      window.removeEventListener("resize", resize);
      window.removeEventListener("explorer:layout", resize);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (attemptedOpen || appliedNavigationRef.current) {
        void queueBrowserOperation(() => api.hideSourceBrowser()).catch(() => {});
      }
    };
  }, [visible]);

  useLayoutEffect(() => {
    const previous = requestedUrlRef.current;
    if (previous.url !== url || previous.navigationId !== navigationId) {
      requestedUrlRef.current = { url, navigationId };
      openingAddressRef.current = url;
      if (!opened) window.dispatchEvent(new Event("explorer:layout"));
    }
    const request = requestedUrlRef.current;
    if (!visible || !opened || appliedNavigationRef.current === request) return;
    // Search dispatch opens its own fresh Pinterest document after preparation.
    // A companion URL update must not interrupt its upload.
    if (url === PINTEREST_SEARCH_URL && usePinterestSearch.getState().request) {
      appliedNavigationRef.current = request;
      return;
    }
    let alive = true;
    void queueBrowserOperation(async () => {
      if (!alive) return;
      setNavigationHint("");
      await api.navigateSourceBrowser(request.url);
      appliedNavigationRef.current = request;
    }).catch(cause => {
      if (alive) {
        setLoading(false);
        setError(String(cause));
      }
    });
    return () => { alive = false; };
  }, [visible, opened, url, navigationId]);

  useEffect(() => {
    if (!visible || !opened || !search || submittedSearchRef.current === search.requestId) return;
    let alive = true;
    void queueBrowserOperation(async () => {
      await listenersReadyRef.current;
      if (!alive || !visibleRef.current || !isPinterestSearchCurrent(search)) return;
      submittedSearchRef.current = search.requestId;
      // Image preparation stays off the queue so that cancellation and manual
      // navigation can reach native code immediately.
      void api.startPinterestImageSearch(search.assetId, search.requestId).catch(cause => {
        receivePinterestSearchStatus({ requestId: search.requestId, status: "error", message: String(cause) });
      });
    }).catch(cause => {
      if (alive) receivePinterestSearchStatus({ requestId: search.requestId, status: "error", message: String(cause) });
    });
    return () => { alive = false; };
  }, [visible, opened, search]);

  useEffect(() => { window.dispatchEvent(new Event("explorer:layout")); }, [suspended]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!visibleRef.current || event.defaultPrevented || event.isComposing || suspendedRef.current) return;
      const focusAddress = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l";
      const goBack = event.altKey && event.key === "ArrowLeft";
      const goForward = event.altKey && event.key === "ArrowRight";
      const escape = closeOnEscape && event.key === "Escape";
      if (!focusAddress && !goBack && !goForward && !escape) return;
      if (document.activeElement?.closest('dialog, [role="dialog"], [role="alertdialog"], [role="menu"]')
          || Array.from(document.querySelectorAll(BLOCKING_SHORTCUT_SELECTOR)).some(isVisible)) return;
      if (focusAddress) {
        event.preventDefault();
        addressRef.current?.focus();
        addressRef.current?.select();
      } else if (goBack) {
        event.preventDefault();
        browserAction(() => api.sourceBrowserBack());
      } else if (goForward) {
        event.preventDefault();
        browserAction(() => api.sourceBrowserForward());
      } else if (document.activeElement !== addressRef.current && !document.querySelector(".source-browser-popover")) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, browserAction, closeOnEscape]);

  function openExternal() {
    void open(currentUrl).catch((cause) => setError(String(cause)));
  }

  const host = hostnameFor(currentUrl);
  return (
    <section className="source-browser-panel" aria-label="探索浏览器">
      <header className="source-browser-header">
        <div className="source-browser-heading">
          {leadingControls}
          <span className="source-browser-mark"><Compass size={16} /></span>
          <div className="min-w-0 truncate text-xs font-semibold text-ink">{title || host}</div>
        </div>

        <div className="source-browser-navigation-row">
          <div className="source-browser-nav" aria-label="网页导航">
            <button type="button" disabled={!opened} onClick={() => browserAction(() => api.sourceBrowserBack())} title="返回上一页" aria-label="返回上一页">
              <ArrowLeft size={15} />
            </button>
            <button type="button" disabled={!opened} onClick={() => browserAction(() => api.sourceBrowserForward())} title="前往下一页" aria-label="前往下一页">
              <ArrowRight size={15} />
            </button>
            <button type="button" disabled={!opened} onClick={() => browserAction(() => api.reloadSourceBrowser())} title="刷新" aria-label="刷新">
              <RefreshCw size={15} />
            </button>
          </div>

          <SourceBrowserAddress input={addressRef} url={currentUrl} history={addressHistory} onNavigate={value => void navigate(value)} />

          <div className="source-browser-actions">
            <button type="button" onClick={openExternal} title="用系统浏览器打开" aria-label="用系统浏览器打开">
              <ExternalLink size={15} />
            </button>
            <ExplorerCaptureHistory visible={visible} />
          </div>
        </div>
        {loading && !tooSmall && <div className="source-browser-progress" role="progressbar" aria-label="正在打开网页" />}
      </header>

      <ExploreSiteShortcuts url={currentUrl} visible={visible} onNavigate={value => void navigate(value)}>
        <button type="button" className="source-browser-extension-entry" onClick={() => openExtension(true)} aria-haspopup="dialog" title="浏览器插件">
          <Puzzle size={14} aria-hidden /><span>浏览器插件</span>
        </button>
        <VideoCollectionEntry projectId={projectId} onCloseLibrary={onClose} onCreateProject={onCreateProject}/>
      </ExploreSiteShortcuts>

      {navigationHint && <div className="source-browser-navigation-hint" role="status">{navigationHint}</div>}
      {error && <div className="source-browser-error" role="alert">{userErrorMessage(error, "网页暂时无法打开，请检查网络和网址后重试。")}</div>}
      {searchProgress && searchProgress.status !== "submitted" && <div className={searchProgress.status === "error" ? "source-browser-error" : "shrink-0 border-b border-edge px-3.5 py-1.5 text-xs text-muted"} role={searchProgress.status === "error" ? "alert" : "status"}>
        {searchProgress.status === "waiting-login" ? "请在 Pinterest 登录，完成后继续搜图。" : searchProgress.status === "error"
          ? userErrorMessage(searchProgress.message, "以图搜图暂时无法完成，请重试。")
          : searchProgress.status === "searching" ? "正在搜索相似图片…" : "正在准备搜图…"}
      </div>}
      <div ref={viewportRef} className="source-browser-viewport" data-source-browser-viewport>
        <div className="source-browser-placeholder" aria-hidden={!tooSmall} role={tooSmall ? "status" : undefined}>
          {tooSmall ? <span className="px-3 text-center">网页区域过小，请拉宽探索面板或放大窗口。</span> : occluded ? "网页暂时隐藏，操作结束后恢复" : loading ? <><LoaderCircle size={20} className="animate-spin" />正在打开 {host}</> : "网页已就绪"}
        </div>
      </div>
    </section>
  );
}
