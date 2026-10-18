import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowRight, Copy, LoaderCircle, Plus } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { VideoPlayer } from "./VideoPlayer";
import { DouyinReferencePicker } from "./DouyinReferencePicker";
import { ReplicationFields, replicationTabs } from "./VideoReplicationForms";
import { REPLICATION_PERSONA, REPLICATION_RULES, replicationDuration, replicationRunning, replicationStateLabel, validateReplicationInput, type ReplicationInput, type ReplicationOperation, type ReplicationProduct, type ReplicationReference, type ReplicationTask } from "../lib/videoReplication";
import { DEFAULT_VIDEO_OPTIONS } from "../lib/videoGeneration";
import { notify } from "../lib/notify";
import { useStore } from "../store";
import type { Asset } from "../lib/types";
import "./VideoReplication.css";

interface Preferences { persona: string; rules: string; products: ReplicationProduct[] }
interface Capability { operation: "video-analysis" | "text-rewrite"; available: boolean; credits: number | null }
const fresh = (operation: Exclude<ReplicationOperation, "generate">, prefs: Preferences): ReplicationInput => ({ operation, title: operation === "analyze" ? "视频分析" : "内容改写", persona: prefs.persona, rules: prefs.rules, ratio: "9:16" });

export function VideoReplicationDialog({ projectId, onClose, ensureProject }: { projectId: string; onClose: () => void; ensureProject: () => Promise<void> }) {
  const call = <T,>(action: string, data: unknown = {}) => invoke<T>("video_replication", { projectId, action, data });
  const [prefs, setPrefs] = useState<Preferences>({ persona: REPLICATION_PERSONA, rules: REPLICATION_RULES, products: [] });
  const [input, setInput] = useState<ReplicationInput>(() => fresh("analyze", prefs));
  const [tasks, setTasks] = useState<ReplicationTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = tasks.find(task => task.id === selectedId) ?? null;
  const [reference, setReference] = useState<ReplicationReference | null>(null);
  const [mediaPath, setMediaPath] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState("");
  const [capabilities, setCapabilities] = useState<{ status: "loading" | "ready" | "error"; services: Capability[]; error: string }>({ status: "loading", services: [], error: "" });
  const [capabilityRefresh, setCapabilityRefresh] = useState(0);
  const authIdentity = useStore(state => `${state.cloudAuth?.user_id ?? ""}:${state.cloudAuth?.logged_in ?? false}`);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [picker, setPicker] = useState(false);
  const [douyinPicker, setDouyinPicker] = useState(false);
  const [sources, setSources] = useState<Asset[]>([]);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [productEditor, setProductEditor] = useState(false);
  const [productName, setProductName] = useState("");
  const [productText, setProductText] = useState("");
  const [edited, setEdited] = useState("");
  const dirty = useRef(false);
  const edits = useRef(new Map<string, string>());
  const operation = selected?.operation ?? input.operation;
  const available = capabilities.services.find(item => item.operation === (operation === "analyze" ? "video-analysis" : "text-rewrite"));

  const put = (task: ReplicationTask) => { setTasks(items => [task, ...items.filter(item => item.id !== task.id)]); setSelectedId(task.id); };
  async function action(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (e) { if (alive.current) setError(String(e)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    void call<Partial<Preferences>>("preferences").then(value => {
      if (disposed) return;
      const next = { persona: value.persona || REPLICATION_PERSONA, rules: value.rules || REPLICATION_RULES, products: value.products ?? [] };
      setPrefs(next); setInput(current => ({ ...current, persona: next.persona, rules: next.rules }));
    }).catch(e => !disposed && setError(String(e)));
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const value = await call<ReplicationTask[]>("list"); if (!disposed) setTasks(current => JSON.stringify(current) === JSON.stringify(value) ? current : value); }
      catch (e) { if (!disposed) setNotice(`历史刷新失败：${String(e)}`); }
      if (!disposed) timer = setTimeout(poll, 2500);
    }
    void poll();
    return () => { alive.current = false; disposed = true; clearTimeout(timer); };
  }, [projectId]);
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    let deadline: ReturnType<typeof setTimeout>;
    setCapabilities({ status: "loading", services: [], error: "" });
    async function refresh() {
      if (disposed || inFlight) return;
      inFlight = true;
      clearTimeout(timer);
      let delay = 30000;
      try {
        const value = await Promise.race([
          invoke<{ services: Capability[] }>("video_replication", { projectId, action: "capabilities", data: {} }),
          new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("读取 Cloud 价格超时，请重试")), 15000); }),
        ]);
        if (!["video-analysis", "text-rewrite"].every(operation => value?.services?.some(item => item.operation === operation && typeof item.available === "boolean" && (!item.available || (typeof item.credits === "number" && item.credits > 0))))) throw new Error("Cloud 返回的服务状态不完整，请重试");
        if (!disposed) setCapabilities(current => current.status === "ready" && JSON.stringify(current.services) === JSON.stringify(value.services) ? current : { status: "ready", services: value.services, error: "" });
      } catch (error) {
        delay = 5000;
        const message = String(error);
        if (!disposed) setCapabilities({ status: "error", services: [], error: message.includes("未知 action") ? "当前连接的 Cloud 接口不支持服务状态查询，请重试" : message });
      } finally {
        clearTimeout(deadline);
        inFlight = false;
        if (!disposed) timer = setTimeout(refresh, delay);
      }
    }
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => { disposed = true; clearTimeout(timer); clearTimeout(deadline); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisible); };
  }, [projectId, authIdentity, capabilityRefresh]);
  useEffect(() => {
    dirty.current = selectedId !== null && edits.current.has(selectedId);
    setEdited((selectedId ? edits.current.get(selectedId) : undefined) ?? selected?.rewrittenText ?? "");
  }, [selectedId]);
  useEffect(() => { if (!dirty.current) setEdited(selected?.rewrittenText ?? ""); }, [selected?.rewrittenText]);
  const referenceId = selected?.referenceId ?? (selected?.sourceAnalysisId ? tasks.find(task => task.id === selected.sourceAnalysisId)?.referenceId : undefined) ?? (!selected ? reference?.id : undefined);
  useEffect(() => {
    let disposed = false; setMediaPath(null); setMediaError("");
    if (referenceId) void call<string>("media", { id: referenceId }).then(value => !disposed && setMediaPath(value)).catch(e => !disposed && setMediaError(String(e)));
    return () => { disposed = true; };
  }, [referenceId, projectId]);
  useEffect(() => {
    if (!picker) return;
    let disposed = false;
    void call<Asset[]>("sources", { query, offset }).then(value => !disposed && setSources(value)).catch(e => !disposed && setError(String(e)));
    return () => { disposed = true; };
  }, [picker, query, offset, projectId]);

  function newDraft(next: Exclude<ReplicationOperation, "generate">, patch: Partial<ReplicationInput> = {}) {
    setSelectedId(null); setReference(null); setPicker(false); setDouyinPicker(false); setInput({ ...fresh(next, prefs), ...patch }); setError(""); setNotice("");
  }
  async function chooseReference(data: { path?: string; assetId?: string }) {
    await ensureProject();
    const value = await call<ReplicationReference>("reference", data);
    if (!alive.current) return;
    setReference(value); setInput(current => ({ ...current, referenceId: value.id, title: value.name.slice(0,100) })); setPicker(false);
  }
  async function submit() {
    const issue = validateReplicationInput(input); if (issue) throw new Error(issue);
    await ensureProject();
    const task = await call<ReplicationTask>("create", input);
    if (alive.current) put(task);
  }
  async function carryRewrite() {
    if ([...edited].length > 12000) throw new Error("改写结果超过 12000 字，请精简后带入生成");
    if (!edited.trim() || !selected) throw new Error("请先填写改写结果");
    const saved = await call<ReplicationTask>("save-result", { id: selected.id, text: edited });
    if (!alive.current || useStore.getState().activeProjectId !== projectId) return;
    edits.current.delete(selected.id);
    dirty.current = false;
    const duration = replicationDuration(saved.rewrittenText);
    useStore.getState().reusePromptToBoard(saved.rewrittenText, [], [], null, {
      media: "video", videoOptions: { ...DEFAULT_VIDEO_OPTIONS, duration: duration ?? DEFAULT_VIDEO_OPTIONS.duration }, ratio: saved.ratio ?? "9:16",
    });
    onClose();
    if (duration === null) notify("未识别到有效分镜时间，已填入默认 5 秒，请在发送前调整");
  }

  return <ModalShell title="视频复刻工具" eyebrow="工具箱" description="分析参考、改写分镜，插入画板对话框后生成。" width="lg" className="video-replication" onClose={onClose} preventClose={busy}
    headerActions={<button type="button" className="app-modal-button" onClick={() => setProductEditor(value => !value)}>产品资料</button>}>
    <aside className="vr-history" aria-label="复刻历史"><div className="vr-history-heading">本项目记录 <button type="button" aria-label="新建复刻记录" onClick={() => newDraft(operation === "generate" ? "rewrite" : operation)}><Plus size={15} /></button></div>
      {!tasks.length && <p className="vr-hint">执行记录会保存在这里</p>}
      {tasks.map(task => <button key={task.id} type="button" aria-current={selectedId === task.id} onClick={() => { setSelectedId(task.id); setError(""); }}><strong>{task.title}</strong><small>{replicationTabs.find(tab => tab.id === task.operation)?.label ?? "历史生成"} · {replicationStateLabel[task.state]}</small></button>)}
    </aside>
    <main className="vr-main">
      <nav className="vr-tabs" aria-label="复刻操作">{replicationTabs.map(tab => <button type="button" key={tab.id} aria-pressed={operation === tab.id} onClick={() => newDraft(tab.id)}><tab.icon size={20} /><span><strong>{tab.label}</strong><small>{tab.description}</small></span></button>)}</nav>
      {error && <div className="vr-message is-error" role="alert">{error}</div>}{notice && <div className="vr-message" role="status">{notice}</div>}
      {productEditor && <section className="vr-product-editor"><h3>产品资料</h3><p className="vr-hint">仅保存名称与文字信息；改写时冻结快照，生成时不自动附加。</p>
        {prefs.products.map(product => <p key={product.id} className="vr-hint">{product.name}</p>)}
        <label className="vr-field">产品名称<input value={productName} maxLength={100} onChange={e => setProductName(e.target.value)} /></label>
        <label className="vr-field">品牌、外观、卖点与注意事项<textarea rows={4} value={productText} maxLength={8000} onChange={e => setProductText(e.target.value)} /></label>
        <div className="vr-actions"><button type="button" disabled={busy || !productName.trim() || !productText.trim()} onClick={() => void action(async () => {
          const product = { id: crypto.randomUUID(), name: productName.trim(), description: productText.trim() };
          const next = { ...prefs, products: [...prefs.products, product] }; await call("save-preferences", next); setPrefs(next); setInput(current => ({ ...current, product })); setProductEditor(false); setProductName(""); setProductText("");
        })}>保存产品资料</button></div>
      </section>}
      {selected ? <>
        <h3>{selected.title}</h3><p className="vr-hint">{new Date(selected.createdAt).toLocaleString()} · {replicationStateLabel[selected.state]}</p>
        <div className="vr-message" role="status">{replicationRunning(selected) && <LoaderCircle size={14} className="animate-spin inline" />} {selected.message || replicationStateLabel[selected.state]}</div>
        {selected.error && <div className="vr-message is-error" role="alert">{selected.error}</div>}
        {(selected.reference || referenceId) && <p className="vr-hint">参考视频：{selected.reference?.name || tasks.find(task => task.id === selected.sourceAnalysisId)?.reference?.name}</p>}
        {selected.reference?.shareText && <p className="vr-hint">原分享：{selected.reference.shareText}<br />作品链接：{selected.reference.originalUrl}</p>}
        {mediaError && <div className="vr-message is-error">{mediaError}</div>}{mediaPath && <VideoPlayer key={mediaPath} path={mediaPath} />}
        {selected.analysis && <><pre className="vr-result">{selected.analysis}</pre><div className="vr-actions"><button type="button" onClick={() => newDraft("rewrite", { inputText: selected.analysis, sourceAnalysisId: selected.id })}>改写此分析 <ArrowRight size={14} /></button><button type="button" onClick={() => void action(async () => { await navigator.clipboard.writeText(selected.analysis); setNotice("已复制分析文本"); })}><Copy size={14} />复制</button></div></>}
        {selected.rewriteOriginalText && <>
          <label className="vr-field">改写结果（可编辑）<textarea rows={12} maxLength={50000} value={edited} onChange={e => { dirty.current = true; edits.current.set(selected.id, e.target.value); setEdited(e.target.value); }} /></label>
          <div className="vr-actions"><button type="button" disabled={busy} onClick={() => void action(async () => { const value = await call<ReplicationTask>("save-result", { id: selected.id, text: edited }); edits.current.delete(selected.id); dirty.current = false; put(value); setNotice("已保存修改"); })}>保存修改</button>
            <button type="button" onClick={() => void action(async () => { await navigator.clipboard.writeText(edited); setNotice("已复制改写结果"); })}>复制</button>
            <button type="button" disabled={busy} className="is-primary" onClick={() => void action(carryRewrite)}>插入到对话框 <ArrowRight size={14} /></button>
            <button type="button" onClick={() => newDraft("rewrite", { inputText: edited, persona: selected.persona, rules: selected.rules, product: selected.product, sourceAnalysisId: selected.sourceAnalysisId })}>调整后新建改写</button></div>
          <details><summary className="vr-hint">查看模型原文与提交快照</summary><pre className="vr-result">{selected.rewriteOriginalText}</pre><pre className="vr-result">{selected.persona}{"\n\n"}{selected.rules}{"\n\n"}{selected.inputText}</pre></details>
        </>}
        {selected.operation === "generate" && <><pre className="vr-result">{selected.prompt}</pre>
          <p className="vr-hint">视频生成已统一到项目画板。</p>
          {selected.generationJobId && <div className="vr-actions"><button type="button" onClick={() => { useStore.getState().openGenerationJob(selected.generationJobId!); onClose(); }}>查看画板生成会话</button></div>}</>}
        {selected.operation !== "generate" && ["failed", "interrupted"].includes(selected.state) && <div className="vr-actions"><button type="button" disabled={busy} onClick={() => void action(async () => put(await call<ReplicationTask>("resume", { id: selected.id }))) }>恢复原任务</button><button type="button" disabled={busy} onClick={() => { newDraft(selected.operation === "analyze" ? "analyze" : "rewrite", { title: selected.title, referenceId: selected.referenceId, inputText: selected.inputText, persona: selected.persona, rules: selected.rules, product: selected.product, sourceAnalysisId: selected.sourceAnalysisId }); setReference(selected.reference ?? null); }}>调整后新建任务</button></div>}
        <p className="vr-hint">模型用量：{selected.usage ? `输入 ${selected.usage.inputTokens ?? "未记录"} · 缓存输入 ${selected.usage.cachedInputTokens ?? "未记录"} · 输出 ${selected.usage.outputTokens ?? "未记录"}` : "未记录"}</p>
      </> : <>
        <ReplicationFields input={input} onChange={patch => setInput(current => ({ ...current, ...patch }))} products={prefs.products} reference={reference} disabled={busy}
          onUpload={() => void action(async () => { const path = await open({ multiple: false, filters: [{ name: "视频", extensions: ["mp4", "mov", "m4v", "webm", "mkv", "avi"] }] }); if (typeof path === "string") await chooseReference({ path }); })}
          onPickLibrary={() => { setPicker(value => !value); setDouyinPicker(false); setOffset(0); }}
          onPickDouyin={() => { setDouyinPicker(value => !value); setPicker(false); }}
          onSaveDefaults={() => void action(async () => { const next = { ...prefs, persona: input.persona!, rules: input.rules! }; await call("save-preferences", next); setPrefs(next); setNotice("默认人设与规范已保存"); })} />
        {douyinPicker && operation === "analyze" && <DouyinReferencePicker projectId={projectId} ensureProject={ensureProject} onUse={value => { setReference(value); setInput(current => ({ ...current, referenceId: value.id, title: value.name.slice(0,100) })); setDouyinPicker(false); }} />}
        {picker && <section className="vr-picker"><label className="vr-field">搜索素材库视频<input value={query} onChange={e => { setQuery(e.target.value); setOffset(0); }} /></label>{sources.map(asset => <button type="button" key={asset.id} disabled={busy} onClick={() => void action(() => chooseReference({ assetId: asset.id }))}>{asset.name} · {(asset.duration ?? 0).toFixed(1)} 秒</button>)}{!sources.length && <p className="vr-hint">没有匹配的视频</p>}<div className="vr-actions"><button type="button" disabled={!offset} onClick={() => setOffset(Math.max(0,offset-40))}>上一页</button><button type="button" disabled={sources.length<40} onClick={() => setOffset(offset+40)}>下一页</button></div></section>}
        {mediaError && <div className="vr-message is-error">{mediaError}</div>}{mediaPath && <VideoPlayer key={mediaPath} path={mediaPath} />}
        <>
            <p className="vr-hint" role="status">Bowerbird Cloud · {operation === "analyze" ? "视频分析" : "文本改写"} · {capabilities.status === "loading" ? "正在读取价格…" : capabilities.status === "error" ? "价格读取失败" : available?.available ? `${available.credits} 积分 / 次` : operation === "analyze" ? "分析服务暂不可用" : "改写尚未启用"}</p>
            {capabilities.status === "error" && <p className="vr-message is-error" role="alert">{capabilities.error}</p>}
            {capabilities.status !== "loading" && (capabilities.status === "error" || !available?.available) && <button type="button" className="vr-text-button" onClick={() => setCapabilityRefresh(value => value + 1)}>重新读取 Cloud 状态</button>}
        </>
        <div className="vr-actions"><button type="button" className="is-primary" disabled={busy || !available?.available} onClick={() => void action(submit)}>{busy ? "处理中…" : operation === "analyze" ? "开始豆包分析" : "提交 Cloud 改写"}</button></div>
      </>}
    </main>
  </ModalShell>;
}
