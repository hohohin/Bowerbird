import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import type { CatalogFilter } from "../lib/materialCatalog";
import { usePortalTarget } from "../lib/portalTarget";
import { semanticSearch, type SemanticSession, type SemanticStatus } from "../lib/semanticSearch";
import { userErrorMessage } from "../lib/userError";
import "./LibrarySemanticSearch.css";

const PAGE_SIZE = 60;
const MAX_RESULTS = 240;
const MAX_QUERY_LENGTH = 512;
const EXPIRED = "索引或素材范围已有变化，请重新搜索。";

export function useLibrarySemanticSearch({ paneId, filter, enabled, revision, onResults }: {
  paneId: string; filter: CatalogFilter; enabled: boolean; revision: number; onResults: () => void;
}) {
  const scope = enabled ? JSON.stringify({ ...filter, media: "images" }) : "";
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const request = useRef<string | null>(null);
  const active = useRef<SemanticSession | null>(null);
  const verifiedRevision = useRef<number>();
  const [state, setState] = useState<{
    scope: string; text: string; pending: boolean; session: SemanticSession | null; error: string;
  } | null>(null);

  const release = useCallback(() => {
    const requestId = request.current, sessionId = active.current?.sessionId;
    request.current = null;
    active.current = null;
    if (requestId) void semanticSearch.cancel({ requestId }).catch(() => {});
    if (sessionId) void semanticSearch.cancel({ sessionId }).catch(() => {});
  }, []);
  const clear = useCallback(() => { release(); setState(null); }, [release]);
  useLayoutEffect(() => clear, [scope, clear]);
  const activeSession = state?.scope === scope ? state.session : null;
  useEffect(() => {
    if (!activeSession) return;
    let listening = true;
    const unlisten: Array<() => void> = [];
    const subscribe = (registration: Promise<() => void>) => {
      void registration.then(dispose => { if (listening) unlisten.push(dispose); else dispose(); }, () => {});
    };
    subscribe(semanticSearch.onProgress(value => {
      if (!listening || value?.libraryId !== activeSession.libraryId) return;
      if (value.modelState !== "ready" || value.activeModelKey !== activeSession.modelKey || value.indexState === "off") expire(activeSession, "stale_session");
    }));
    subscribe(semanticSearch.onSessionsReset(libraryId => {
      if (listening && libraryId === activeSession.libraryId) expire(activeSession, "stale_session");
    }));
    return () => { listening = false; unlisten.forEach(dispose => dispose()); };
  }, [activeSession]);

  useEffect(() => {
    if (!activeSession || verifiedRevision.current === revision) return;
    let current = true;
    // The native ID read validates the full frozen ranking, even for a one-ID page.
    void semanticSearch.ids({ sessionId: activeSession.sessionId, offset: 0, limit: 1 }).then(() => {
      if (current) verifiedRevision.current = revision;
    }).catch(error => { if (current) expire(activeSession, error); });
    return () => { current = false; };
  }, [activeSession, revision]);

  async function submit(text: string) {
    if (!scope || latestScope.current !== scope || !text) return;
    release();
    const requestId = crypto.randomUUID();
    request.current = requestId;
    setState({ scope, text, pending: true, session: null, error: "" });
    try {
      const session = await semanticSearch.start({ requestId, paneId, text, filter: { ...filter, media: "images" }, topK: MAX_RESULTS });
      if (latestScope.current !== scope || request.current !== requestId || session.requestId !== requestId) {
        void semanticSearch.cancel({ sessionId: session.sessionId }).catch(() => {});
        if (latestScope.current === scope && request.current === requestId) throw new Error("mismatched search response");
        return;
      }
      onResults();
      active.current = session;
      verifiedRevision.current = revision;
      setState({ scope, text, pending: false, session, error: "" });
    } catch (error) {
      if (latestScope.current !== scope || request.current !== requestId) return;
      setState({ scope, text, pending: false, session: null, error: searchError(error) });
    } finally {
      if (request.current === requestId) request.current = null;
    }
  }

  function expire(session: SemanticSession, error: unknown) {
    if (String(error) !== "stale_session" || active.current?.sessionId !== session.sessionId) return;
    active.current = null;
    void semanticSearch.cancel({ sessionId: session.sessionId }).catch(() => {});
    setState(previous => previous ? { ...previous, session: null, error: EXPIRED } : previous);
  }

  async function readPage(session: SemanticSession, offset: number, limit: number) {
    try { return (await semanticSearch.page({ sessionId: session.sessionId, offset, limit })).map(row => row.asset); }
    catch (error) { expire(session, error); throw error; }
  }
  async function readIds(session: SemanticSession, offset: number, limit: number) {
    try { return await semanticSearch.ids({ sessionId: session.sessionId, offset, limit: Math.min(PAGE_SIZE, limit) }); }
    catch (error) { expire(session, error); throw error; }
  }

  return { scope, result: state?.scope === scope ? state : null, submit, clear, readPage, readIds };
}

type SearchController = ReturnType<typeof useLibrarySemanticSearch>;

export function LibrarySemanticSearch({ scopeLabel, search, owner }: {
  scopeLabel: string; search: SearchController; owner: RefObject<HTMLElement>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<SemanticStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [operation, setOperation] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const composing = useRef(false);
  const lengthId = useId();
  const portal = usePortalTarget();
  const refreshRef = useRef<() => void>();
  const libraryId = useRef<string>();
  const result = search.result;

  useEffect(() => {
    if (!open) return;
    let active = true;
    let sequence = 0;
    let unlisten: (() => void) | undefined;
    const refresh = () => {
      const revision = ++sequence;
      void semanticSearch.status().then(value => {
        if (!active || sequence !== revision) return;
        libraryId.current = value.libraryId;
        setStatus(value);
        setStatusError("");
      }).catch(error => {
        if (active && sequence === revision) setStatusError(userErrorMessage(error, "暂时无法读取搜图状态，请重试。"));
      });
    };
    refreshRef.current = refresh;
    refresh();
    void semanticSearch.onProgress(value => {
      if (!active || !value?.libraryId || (libraryId.current && libraryId.current !== value.libraryId)) return;
      libraryId.current = value.libraryId;
      sequence++;
      setStatus(value);
      setStatusError("");
    }).then(dispose => { if (active) unlisten = dispose; else dispose(); }, () => {});
    return () => { active = false; refreshRef.current = undefined; unlisten?.(); };
  }, [open]);
  useEffect(() => { if (open && result?.error) refreshRef.current?.(); }, [open, result?.error]);

  function clear() { search.clear(); setDraft(""); }
  function close() {
    clear();
    composing.current = false;
    setOpen(false);
    const entry = trigger.current;
    const overflow = entry?.closest(".library-controls-host")?.querySelector<HTMLButtonElement>("button[aria-label='更多素材库控件']");
    (entry?.closest("[inert]") ? overflow : entry)?.focus({ preventScroll: true });
  }
  const closeRef = useRef(close);
  closeRef.current = close;
  const ownsSearch = !!result?.session || !!result?.pending || !!result?.error;
  useLayoutEffect(() => {
    if (!open && !ownsSearch) return;
    const entry = trigger.current;
    const box = panel.current;
    const heading = entry?.closest(".file-view-heading");
    const align = () => {
      if (!entry || !box) return;
      const visibleControl = entry.getBoundingClientRect();
      const bounds = visibleControl.width && visibleControl.height ? visibleControl : heading?.getBoundingClientRect();
      if (!bounds) return;
      const paneBounds = owner.current?.getBoundingClientRect();
      const leftEdge = Math.max(0, paneBounds?.left ?? 0) + 12;
      const rightEdge = Math.min(window.innerWidth, paneBounds?.right ?? window.innerWidth) - 12;
      const width = Math.min(360, rightEdge - leftEdge);
      box.style.width = `${width}px`;
      box.style.left = `${Math.max(leftEdge, Math.min(bounds.right - width, rightEdge - width))}px`;
      box.style.top = `${Math.max(12, Math.min(bounds.bottom + 8, window.innerHeight - box.offsetHeight - 12))}px`;
    };
    const onOutside = (event: PointerEvent) => {
      if (box && !box.contains(event.target as Node) && !entry?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || composing.current) return;
      const target = document.activeElement;
      const nested = target?.closest('[role="dialog"], [role="menu"]');
      if (nested && nested !== box && !nested.contains(entry ?? null)) return;
      if (!box?.contains(target) && !owner.current?.contains(target) && !(open && target === document.body)) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    const observer = new ResizeObserver(align);
    if (entry) observer.observe(entry);
    if (heading) observer.observe(heading);
    if (box) observer.observe(box);
    if (owner.current) observer.observe(owner.current);
    align();
    window.addEventListener("resize", align);
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("keydown", onEscape, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", align);
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("keydown", onEscape, true);
    };
  }, [open, ownsSearch, owner]);

  useEffect(() => {
    if (!open || panel.current?.contains(document.activeElement)) return;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("[data-search-focus]")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open, status?.modelState, status?.indexState]);

  async function control(action: () => Promise<unknown>, fallback: string) {
    setOperation(true);
    setStatusError("");
    try { await action(); refreshRef.current?.(); }
    catch (error) { setStatusError(searchError(error, fallback)); }
    finally { setOperation(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (composing.current || !ready) return;
    const text = draft.trim();
    if (text && !tooLong && (!result?.pending || result.text !== text)) void search.submit(text);
  }

  const tooLong = [...draft.trim()].length > MAX_QUERY_LENGTH;
  const ready = status?.supported && status.modelState === "ready" && status.indexState !== "off";
  const error = statusError || result?.error;
  const session = result?.session;
  return <>
    <button type="button" className="library-filter-trigger library-semantic-trigger" title="以文搜图" aria-label="以文搜图"
      data-active={open || !!session || !!result?.pending || undefined} aria-expanded={open} aria-haspopup="dialog" ref={trigger} onClick={() => open ? close() : setOpen(true)}>
      <Search size={15} aria-hidden="true"/><span>以文搜图</span>
    </button>
    {open && createPortal(<section className="library-semantic-panel" ref={panel} role="dialog" aria-label="以文搜图">
      <header className="library-semantic-head">
        <strong>以文搜图</strong>
        <button type="button" className="library-semantic-close" aria-label="关闭搜索" title="关闭搜索" onClick={close}><X size={16} aria-hidden="true"/></button>
      </header>
      <div className="library-semantic-scope">{scopeLabel}</div>
      {ready && <form className="library-semantic-form" role="search" onSubmit={submit}>
        <input aria-label="描述想找的图片" placeholder="例如：有侧光的产品照" data-search-focus
          value={draft} onChange={event => setDraft(event.target.value)} maxLength={2 * MAX_QUERY_LENGTH}
          aria-invalid={tooLong || undefined} aria-describedby={tooLong ? lengthId : undefined}
          onKeyDown={event => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current)) event.preventDefault(); }}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}/>
        {(draft || session) && <button type="button" title="清除搜索" aria-label="清除搜索" onClick={() => { clear(); panel.current?.querySelector<HTMLInputElement>("input")?.focus(); }}><X size={14} aria-hidden="true"/></button>}
        <button type="submit" disabled={!draft.trim() || tooLong || (!!result?.pending && result.text === draft.trim())}>搜索</button>
      </form>}
      {tooLong && <p className="library-semantic-status" id={lengthId} role="alert">描述最多可输入 512 个字符。</p>}
      {!status && !error && <p className="library-semantic-status" role="status">正在读取搜图状态…</p>}
      {status && <Progress status={status} disabled={operation} control={control}/>}
      {error && <div className="library-semantic-status" role="alert"><p>{error}</p>
        {statusError && <button type="button" data-search-focus onClick={() => refreshRef.current?.()}>重试</button>}
      </div>}
      {(session || result?.pending) && <div className="library-semantic-results" role="status">{result?.pending ? "正在搜索图片…" : session ? resultMessage(session) : null}</div>}
    </section>, portal)}
  </>;
}

function searchError(error: unknown, fallback = "暂时无法搜索图片，请重试。") {
  switch (String(error)) {
    case "stale_session": return EXPIRED;
    case "cancelled": return "搜索已取消，可重新搜索。";
    case "index_empty": return "索引尚未准备好，请先建立索引。";
    case "model_missing": return "搜图模型尚未准备好，请先下载模型。";
    case "model_busy": return "搜图模型正在准备，请稍后重试。";
    case "model_corrupt": return "搜图模型暂时无法读取，请重新下载。";
    case "disk_full": return "磁盘空间不足，请释放空间后重试。";
    case "download_failed": return "搜图模型下载失败，请检查网络后重试。";
    case "invalid_scope": return "素材范围不可用，请重新选择后重试。";
    case "invalid_query": return "请输入 1 到 512 个字符后重试。";
    case "unsupported_platform": return "当前设备暂不支持本机以文搜图。";
    case "resource_limit": return "本机搜图暂时繁忙，请稍后重试。";
    default: return userErrorMessage(error, fallback);
  }
}

function resultMessage(session: SemanticSession) {
  if (!session.eligible) return "当前范围内没有可索引的图片。";
  if (!session.indexed) return "当前范围内还没有已索引的图片。";
  if (!session.resultCount) return "当前范围内未找到图片。";
  return `找到 ${session.resultCount} 张图片${session.resultCount < session.indexed ? "，已显示最相关的结果" : ""}${session.indexed < session.eligible ? `。已索引 ${session.indexed} / 可索引 ${session.eligible} 张` : ""}${session.truncated ? "。描述较长，已按部分描述搜索。" : ""}`;
}

function Progress({ status, disabled, control }: {
  status: SemanticStatus; disabled: boolean; control: (action: () => Promise<unknown>, fallback: string) => Promise<void>;
}) {
  if (!status.supported) return <p className="library-semantic-status" role="status">当前设备暂不支持本机以文搜图。</p>;
  if (status.modelState === "missing" || status.modelState === "corrupt") {
    const missing = status.modelState === "missing";
    const size = status.downloadBytes ? `约 ${(status.downloadBytes / 1e9).toFixed(1)} GB` : "约 1.5 GB";
    return <div className="library-semantic-status">
      <p>{missing ? `首次使用需下载${size}的模型和运行时组件。图片和搜索词在本机处理。` : "搜图模型文件暂时无法读取，请重新下载。"}</p>
      {status.modelError && status.modelError !== "model_corrupt" && <p role="alert">{searchError(status.modelError)}</p>}
      <button type="button" className="library-semantic-action" data-search-focus disabled={disabled}
        onClick={() => void control(() => semanticSearch.model(missing ? "install" : "repair"), "暂时无法下载搜图模型，请重试。")}>{missing ? "下载模型" : "重新下载"}</button>
    </div>;
  }
  if (status.modelState === "downloading") {
    const total = status.totalBytes || status.downloadBytes || undefined;
    const downloaded = status.downloadedBytes;
    return <div className="library-semantic-status">
      <p role="status">正在下载模型{total && downloaded !== undefined ? ` · ${Math.floor(downloaded / total * 100)}%` : "…"}</p>
      <progress aria-label="下载进度" value={total ? downloaded : undefined} max={total}/>
      <button type="button" data-search-focus disabled={disabled} onClick={() => void control(() => semanticSearch.model("cancel"), "暂时无法取消下载，请重试。")}>取消下载</button>
    </div>;
  }
  if (status.indexState === "off") return <div className="library-semantic-status">
    <p>建立索引后即可搜索本机图片。</p>
    <button type="button" className="library-semantic-action" data-search-focus disabled={disabled}
      onClick={() => void control(() => semanticSearch.index("start"), "暂时无法建立索引，请重试。")}>建立索引</button>
  </div>;
  if (status.indexState === "running" && status.backfillComplete && !status.failed && !status.pending && !status.unavailable && !status.auditing && !status.workerError) return null;
  const paused = status.indexState === "paused";
  const total = status.eligible;
  const scanning = !status.backfillComplete;
  return <div className="library-semantic-status">
    <div className="library-semantic-progress"><span>{paused ? "索引已暂停" : scanning || status.pending ? "正在建立索引" : "索引已更新"}</span>
      <span>已索引 {status.indexed}{!scanning && ` / 可索引 ${total}`} 张</span></div>
    {scanning ? !paused && <progress aria-label="正在检查图片"/> : !!total && <progress aria-label="索引进度" value={status.indexed} max={total}/>}
    {!!status.unavailable && <p>{status.unavailable} 张图片暂时不可用，可用后会重新检查。</p>}
    {!!status.auditing && <p>正在核对 {status.auditing} 张已索引图片。</p>}
    {status.workerError || status.lastError ? <p role="alert">{searchError(status.workerError || status.lastError, "部分图片暂时无法索引，请稍后重试。")}</p> : <p>当前可搜索已建立索引的图片。</p>}
    <button type="button" disabled={disabled} onClick={() => void control(() => semanticSearch.index(paused || status.workerError ? "resume" : "pause"), "暂时无法调整索引进度，请重试。")}>{paused ? "继续索引" : status.workerError ? "重试索引" : "暂停索引"}</button>
  </div>;
}
