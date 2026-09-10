import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, Palette, Pencil, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { effectivePolicy } from "../lib/entitlement";
import { notifySuccess } from "../lib/notify";
import { brandOverview } from "../lib/brandVisual";
import { reminderStorageKey } from "../lib/taskReminders";
import { startVisualProfileTask, stopVisualProfileTask, useVisualProfileTasks, visualProfileTaskScope } from "../lib/visualProfileTasks";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";
import type { Asset, VisualProfileDetail, VisualProfileDraftRule, VisualProfileScopePreview, VisualProfileSummary } from "../lib/types";
import "./VisualProfileDialog.css";

const CATEGORIES: Record<string, string> = { mood: "整体气质", palette: "品牌色彩", composition: "画面构图", light: "光线与影调", material: "材质与质感", medium: "表现方式", layout: "文字与版式" };
const POLARITIES = { must: "保持", prefer: "偏好", avoid: "避免" };
const THEMES = ["静物台面", "室内一角", "自然场景", "抽象背景"];
type Rule = VisualProfileDraftRule & { deleted?: boolean };
type Validation = { imagePath: string; prompt: string; credits: number };
const errorMessage = (e: unknown) => typeof e === "string" ? e : e instanceof Error ? e.message : "暂时没有完成，请稍后再试";

export function VisualProfileDialog() {
  const folder = useStore((s) => s.visualProfileFolder);
  if (!folder) return null;
  return <BrandVisualSession key={`${folder.id}:${folder.profileId ?? ""}`} folder={folder} />;
}

function BrandVisualSession({ folder }: { folder: { id: string; name: string; profileId?: string } }) {
  const close = useStore((s) => s.closeVisualProfile);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const entitlement = useStore((s) => s.cloudEntitlement);
  const [scope, setScope] = useState<VisualProfileScopePreview | null>(null);
  const [images, setImages] = useState<Asset[]>([]);
  const [history, setHistory] = useState<VisualProfileSummary[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [deleting, setDeleting] = useState<VisualProfileSummary | null>(null);
  const [sourceRetry, setSourceRetry] = useState(0);
  const [savedSources, setSavedSources] = useState<{ profileId: string; assets: Asset[]; error?: string } | null>(null);
  const deleteMessage = useRef<HTMLDivElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const [detail, setDetail] = useState<VisualProfileDetail | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [direction, setDirection] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [operationBusy, setBusy] = useState<string | null>("正在打开…");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [theme, setTheme] = useState(THEMES[0]!);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [rounds, setRounds] = useState<Record<string, number>>({});
  const [adopted, setAdopted] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const tasks = useVisualProfileTasks((s) => s.tasks);
  const taskScope = useStore((s) => reminderStorageKey(s.settings?.library_root, s.cloudAuth?.user_id));
  const [taskId, setTaskId] = useState(() => folder.profileId ? undefined : tasks.find((task) => task.folderId === folder.id && task.scopeKey === visualProfileTaskScope() && task.status === "running")?.id);
  const task = tasks.find((item) => item.id === taskId && item.scopeKey === taskScope);
  const taskRunning = task?.status === "running";
  const busy = operationBusy ?? (taskRunning ? task.progress : null);
  const alive = useRef(true);
  const lock = useRef(false);
  const pendingImage = useRef<string | null>(null);
  const adopting = useRef(false);
  const policy = effectivePolicy(entitlement);
  const connected = !!cloudAuth?.logged_in && !!cloudAuth.cloud_available;
  const cloudAvailable = connected && policy.can_use_visual_profiles;
  const canAnalyze = connected && policy.can_use_cloud;
  const credits = entitlement?.generation_services?.[0]?.credits ?? 1;
  const draft = detail?.status === "draft";

  function releaseImage() {
    const path = pendingImage.current;
    pendingImage.current = null;
    if (path) void api.visualProfileDiscardValidation(path).catch(() => {});
  }
  function clearValidation() {
    releaseImage(); setValidation(null); setAdopted(false); setImageFailed(false);
  }
  function apply(value: VisualProfileDetail) {
    setDetail(value); setRules(value.rules.map((r) => ({ ...r }))); setDirection(null); setEditing(false);
    setHistory((current) => [value, ...current.filter((p) => p.id !== value.id)].sort((a, b) => b.version - a.version));
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (!adopting.current) releaseImage();
    };
  }, []);
  useEffect(() => {
    if (taskId && !task) {
      setTaskId(undefined);
      setError("登录账号已变化或已切换素材库，请重新打开规范");
      return;
    }
    if (!task || task.status === "running") return;
    if (task.status === "succeeded" && task.result) { clearValidation(); apply(task.result); }
    else if (task.status === "failed") setError(task.error ?? "提炼失败");
    else if (task.status === "cancelled") setNotice(task.progress);
  }, [task, taskId]);

  async function readSource() {
    const preview = await api.visualProfilePreview(folder.id);
    const assets = await api.getAssetsByIds(preview.assetIds ?? []);
    if (alive.current) { setScope(preview); setImages(assets); }
    return preview;
  }
  useEffect(() => {
    let cancelled = false;
    lock.current = true;
    async function open() {
      const [source, list] = await Promise.allSettled([
        api.visualProfilePreview(folder.id), api.visualProfileList(folder.id),
      ]);
      if (cancelled) return;
      if (list.status === "fulfilled") setHistory(list.value);
      if (source.status === "fulfilled") {
        const assets = await api.getAssetsByIds(source.value.assetIds ?? []).catch((error) => {
          if (!cancelled) setError(errorMessage(error));
          return [];
        });
        if (cancelled) return;
        setScope(source.value); setImages(assets);
      }
      if (list.status === "fulfilled") {
        const latest = folder.profileId ? list.value.find((p) => p.id === folder.profileId) : null;
        if (latest) {
          const value = await api.visualProfileGet(latest.id);
          if (cancelled) return;
          apply(value);
        }
      }
      if (source.status === "rejected" && !(list.status === "fulfilled" && list.value.length)) throw source.reason;
      if (list.status === "rejected") throw list.reason;
    }
    open().catch((e) => { if (!cancelled) setError(errorMessage(e)); })
      .finally(() => { if (!cancelled) { lock.current = false; setBusy(null); } });
    return () => { cancelled = true; };
  }, [folder.id, folder.profileId]);

  useEffect(() => {
    if (!detail) { setSavedSources(null); return; }
    let cancelled = false;
    const profileId = detail.id;
    setSavedSources(null);
    api.getAssetsByIds(detail.sourceAssetIds ?? []).then((assets) => {
      if (!cancelled) setSavedSources({ profileId, assets });
    }).catch((error) => {
      if (!cancelled) setSavedSources({ profileId, assets: [], error: errorMessage(error) });
    });
    return () => { cancelled = true; };
  }, [detail?.id, detail?.sourceAssetIds, sourceRetry]);

  useEffect(() => {
    if (!deleting) return;
    deleteMessage.current?.scrollIntoView({ block: "nearest" });
    cancelDelete.current?.focus({ preventScroll: true });
  }, [deleting]);

  function backToCollection() {
    clearValidation(); setDetail(null); setRules([]); setDirection(null); setEditing(false);
    setTaskId(undefined); setHistoryExpanded(true); setError(null); setNotice(null);
  }
  function deleteProfile() {
    if (!deleting || taskRunning) return;
    const id = deleting.id;
    void perform("正在删除规范…", async () => {
      await api.visualProfileDelete(id);
      if (!alive.current) return;
      if (useStore.getState().activeVisualProfileId === id) useStore.getState().setActiveVisualProfile(null);
      useStore.setState((state) => ({ visualProfiles: state.visualProfiles.filter((item) => item.id !== id) }));
      setHistory((current) => current.filter((item) => item.id !== id));
      if (detail?.id === id) backToCollection();
      setDeleting(null);
      await useStore.getState().reloadVisualProfiles();
      if (alive.current) notifySuccess("视觉规范已删除");
    });
  }
  function historyRows() {
    return history.map((item) => <div className="bv-history-row" key={item.id}>
      <button className="bv-history-item" disabled={!!busy || !!deleting || detail?.id === item.id} onClick={() => openVersion(item.id)}>
        <span>{new Date(item.createdAt * 1000).toLocaleDateString()} · v{item.version}</span>
        <span>{detail?.id === item.id ? "当前查看" : item.status === "confirmed" ? "已保存" : "待保存"}</span>
      </button>
      <button className="bv-icon-button" disabled={!!busy || !!deleting} aria-label={"删除规范 v" + item.version} onClick={() => setDeleting(item)}><Trash2 size={15} /></button>
    </div>);
  }

  async function perform(label: string, action: () => Promise<void>) {
    if (lock.current || !alive.current) return false;
    lock.current = true; setBusy(label); setError(null); setNotice(null);
    try { await action(); return true; }
    catch (e) {
      if (alive.current) {
        if (e instanceof DOMException && e.name === "AbortError") setNotice("已停止提炼。正在分析的图片会完成，下次可接着继续。");
        else setError(errorMessage(e));
      }
      return false;
    } finally { lock.current = false; if (alive.current) setBusy(null); }
  }
  const visibleRules = useMemo(() => {
    const assets = direction === null ? null : new Set(detail?.candidateDirections.find((d) => d.label === direction)?.supportingAssetIds ?? []);
    return rules.filter((r) => !r.deleted && (!assets || r.value.startsWith("原图明确标注：") || r.value.startsWith("待核对的原图标注：") || r.supportingAssetIds.length === 0 || r.supportingAssetIds.some((id) => assets.has(id))));
  }, [rules, direction, detail]);
  const dirty = !!detail && (visibleRules.length !== detail.rules.length || visibleRules.some((r, i) => {
    const original = detail.rules[i];
    return !original || r.value !== original.value || r.polarity !== original.polarity || r.category !== original.category;
  }));
  const mixedRules = detail?.rules.some((rule, index) => detail.rules.slice(index + 1).some((other) =>
    other.category === rule.category && rule.supportingAssetIds.length > 0 && other.supportingAssetIds.length > 0 &&
    !rule.supportingAssetIds.some((id) => other.supportingAssetIds.includes(id)),
  ));
  const needsDirection = draft && mixedRules && detail.conflicts.length > 0 && detail.candidateDirections.length > 1 && direction === null;
  const invalid = visibleRules.some((rule) => rule.value.startsWith("待核对的原图标注：")) ? "品牌标注存在冲突，请在微调描述中核对，保留正确的标注。" : needsDirection ? "这些图片呈现不同风格，先选一种更接近品牌的感觉。" : visibleRules.length === 0 ? "还没有可用的风格描述，请补充更一致的品牌图片后重新总结。" : visibleRules.some((r) => !r.value.trim()) ? "请补充空白的描述，或将它移除。" : null;
  const ready = !!scope && scope.inFolder >= scope.minRequired && scope.inFolder <= 500 && cloudAvailable && (!scope.missing.length || canAnalyze);
  const round = detail ? rounds[detail.id] ?? 0 : 0;
  function navigate(action: () => void) {
    if (lock.current) return;
    if (dirty) setLeave(() => action); else action();
  }
  async function save(): Promise<VisualProfileDetail> {
    if (!detail) throw new Error("请先提炼视觉规范");
    if (invalid) throw new Error(invalid);
    if (!dirty) return detail;
    const saved = await api.visualProfileUpdateDraft(detail.id, visibleRules.map((r) => ({
      category: r.category, value: r.value.trim(), polarity: r.polarity, confidence: r.confidence,
      supportingAssetIds: r.supportingAssetIds, opposingAssetIds: r.opposingAssetIds, confirmedByUser: true,
    })));
    if (alive.current) apply(saved);
    return saved;
  }
  function summarize() {
    if (!scope || !ready || lock.current || taskRunning) return;
    setError(null); setNotice(null);
    setTaskId(startVisualProfileTask(folder, scope));
  }
  function confirmProfile() {
    if (!detail || invalid) return;
    void perform("正在保存规范…", async () => {
      const saved = await save();
      if (!alive.current) return;
      const confirmed = saved.status === "draft" ? await api.visualProfileConfirm(saved.id) : saved;
      if (!alive.current) return;
      apply(confirmed);
      useStore.setState((s) => ({ visualProfiles: [confirmed, ...s.visualProfiles.filter((p) => p.id !== confirmed.id)] }));
      await useStore.getState().reloadVisualProfiles();
      if (!alive.current) return;
      notifySuccess("规范已保存，可在创作对话框中选择使用");
      close();
    });
  }
  function openVersion(id: string) {
    navigate(() => void perform("正在打开…", async () => {
      const value = await api.visualProfileGet(id);
      if (alive.current) { setTaskId(undefined); clearValidation(); apply(value); }
    }));
  }
  function generate() {
    if (!draft || invalid || !canAnalyze || round >= 2 || !theme.trim()) return;
    void perform("正在试画品牌风格…", async () => {
      const saved = await save();
      if (!alive.current) return;
      const result = await api.visualProfileGenerateValidation(saved.id, theme.trim());
      if (!alive.current) { void api.visualProfileDiscardValidation(result.imagePath).catch(() => {}); return; }
      clearValidation(); pendingImage.current = result.imagePath; setValidation(result);
      setRounds((current) => ({ ...current, [saved.id]: (current[saved.id] ?? 0) + 1 }));
    });
  }
  function adopt() {
    if (!detail || !validation) return;
    void perform("正在保存图片…", async () => {
      adopting.current = true;
      try {
        await api.visualProfileConfirmValidation(detail.id, validation.imagePath);
        pendingImage.current = null;
        if (alive.current) { setAdopted(true); setValidation(null); notifySuccess("图片已保存到素材库"); }
      } finally { adopting.current = false; if (!alive.current) releaseImage(); }
    });
  }
  const accessHint = !cloudAuth?.logged_in ? "登录后即可提炼视觉规范。" : !cloudAuth.cloud_available ? "暂时无法连接，请稍后重试。" : !policy.can_use_visual_profiles ? "当前账号暂未开放品牌风格总结。" : !scope ? "" : scope.inFolder > 500 ? "一次最多总结 500 张图片，请将品牌作品分组后再试。" : scope.inFolder < scope.minRequired ? "这个集合还没有可提炼的图片，请先回到集合添加素材。" : "";
  const feeHint = scope?.missing.length ? `总结 2 积分 · 图片分析使用账号额度` : "总结 2 积分";

  return <ModalShell title={detail ? "视觉规范" : "提炼视觉规范"} width="lg" className={`visual-profile-dialog ${!detail ? "is-preparing" : ""}`}
    description={detail ? "保存后，可在创作对话框中选择使用。" : "从这个集合的素材中提炼共同的视觉风格。"}
    onClose={() => deleting ? setDeleting(null) : navigate(close)} preventClose={!!operationBusy}
    footer={deleting ? <>
      <span className="bv-footer-hint">仅删除所选规范版本</span>
      <button ref={cancelDelete} className="app-modal-button" disabled={!!busy} onClick={() => setDeleting(null)}>取消删除</button>
      <button className="app-modal-button bv-delete-button" disabled={!!busy} onClick={deleteProfile}>确认删除</button>
    </> : leave ? <>
      <span className="bv-footer-hint">修改还没有保存</span>
      <button className="app-modal-button" disabled={!!busy} onClick={() => setLeave(null)}>继续修改</button>
      <button className="app-modal-button" disabled={!!busy} onClick={() => { const action = leave; setLeave(null); action(); }}>放弃修改</button>
      <button className="app-modal-button is-primary" disabled={!!busy || !!invalid} onClick={async () => {
        const saved = await perform("正在保存…", async () => { await save(); });
        if (saved && alive.current) { const action = leave; setLeave(null); action(); }
      }}>保存后继续</button>
    </> : <>
      <span className="bv-footer-hint">{busy ? "" : detail ? editing && dirty ? "有未保存的修改" : "在创作对话框中选择使用" : feeHint}</span>
      {busy ? taskRunning && <>
        {task.canStop && <button className="app-modal-button" onClick={() => stopVisualProfileTask(task.id)}>停止提炼</button>}
        <button className="app-modal-button" onClick={() => navigate(close)}>后台继续</button>
      </> : detail ? <>
        <button className="app-modal-button" onClick={() => navigate(backToCollection)}><ArrowLeft size={15} />返回</button>
        <button className="app-modal-button bv-delete-button" onClick={() => setDeleting(detail)}><Trash2 size={15} />删除规范</button>
        {editing && <button className="app-modal-button" onClick={() => navigate(() => setEditing(false))}>返回预览</button>}
        <button className="app-modal-button is-primary" disabled={draft && !!invalid} onClick={draft ? confirmProfile : close}><Check size={15} />{draft ? "保存规范" : "完成"}</button>
      </> : <><button className="app-modal-button" onClick={close}>取消</button><button className="app-modal-button is-primary" disabled={!ready} onClick={summarize}><Sparkles size={15} />开始提炼</button></>}
    </>}>
    {error && <div className="bv-message is-error" role="alert"><span>{error}</span>{!detail && !busy && !deleting && <button onClick={() => void perform("正在重新读取…", async () => { await readSource(); })}>重新读取图片</button>}</div>}
    {deleting && <div ref={deleteMessage} className="bv-message" role="alert"><span>删除「{deleting.name} · v{deleting.version}」？删除后将无法在创作中选用；原素材和已生成内容会保留。</span></div>}
    {notice && <div className="bv-message" role="status">{notice}</div>}
    {busy && <div className="bv-working" role="status"><span className="app-spinner" /><div><strong>{busy}</strong><span>{taskRunning ? "可关闭面板，在任务中心查看进度；完成后会提醒你。" : "交给 Bowerbird，稍等片刻。"}</span></div></div>}
    <fieldset className="bv-fields" disabled={!!busy || !!leave || !!deleting}>
    {!detail ? <section className="bv-source">
      <div className="bv-collection-source"><div className="bv-brand-icon"><Palette size={23} /></div><div><h3>{folder.name}</h3><p>{scope ? scope.inFolder + " 张素材" : "正在读取集合…"}</p></div></div>
      {images.length > 0 && <div className="bv-image-grid bv-source-preview" aria-label="集合素材">{images.map((asset) => <figure key={asset.id} title={asset.name}>{asset.thumb_path || asset.store_path ? <img loading="lazy" src={convertFileSrc(asset.thumb_path || asset.store_path!)} alt={asset.name} /> : <Palette size={24} />}</figure>)}</div>}
      {accessHint && <p className="bv-hint">{accessHint}</p>}
      {scope && scope.missing.length > 0 && cloudAvailable && <p className="bv-disclosure">开始后将使用 Cloud 分析集合素材并提炼规范。</p>}
    </section> : <div className="bv-result">
      <section className="bv-brand-heading"><div className="bv-brand-icon"><Palette size={23} /></div><div><span>视觉规范 · v{detail.version}</span><h3>{detail.name}</h3></div>{draft && <button className="bv-text-button" onClick={() => setEditing(!editing)}><Pencil size={13} />{editing ? "预览" : "微调描述"}</button>}</section>
      <section className="bv-saved-sources" aria-label="提炼时的素材">
        <h4>提炼时的素材 <span>{detail.sourceAssetIds?.length ?? detail.sourceCount} 张</span></h4>
        {savedSources?.profileId !== detail.id ? <p className="bv-hint">正在读取当时的素材…</p> : savedSources.error ? <div className="bv-message" role="alert"><span>{savedSources.error}</span><button onClick={() => setSourceRetry((n) => n + 1)}>重新读取来源素材</button></div> : detail.sourceAssetIds?.length ? <div className="bv-image-grid">{detail.sourceAssetIds.map((id, index) => <SourceThumbnail key={id} asset={savedSources.assets.find((asset) => asset.id === id)} index={index} />)}</div> : <p className="bv-hint">该版本没有可读取的来源素材记录。</p>}
      </section>
      <p className="bv-overview">{needsDirection ? "发现了不止一种视觉风格。选择你想延续的感觉，我们会保留对应的品牌特征。" : brandOverview({ ...detail, summary: direction ? "" : detail.summary, rules: visibleRules })}</p>
      {detail.sourceCount < 3 && <p className="bv-hint">这是从当前图片总结的初步风格，补充更多品牌作品后可以进一步完善。</p>}
      {draft && detail.conflicts.length > 0 && detail.candidateDirections.length > 1 && <div className="bv-directions" aria-label="选择品牌感觉">{detail.candidateDirections.map((d) => <button key={d.label} aria-pressed={direction === d.label} onClick={() => setDirection(d.label)}>{d.label.replace(/\|/g, " · ")}</button>)}</div>}
      {invalid && <p className="bv-hint" role="alert">{invalid}</p>}
      <details className="bv-secondary bv-rule-details" open={editing || undefined}><summary>查看规范详情</summary>
      {editing ? <section className="bv-editing">
        {dirty && <button className="bv-text-button" onClick={() => { setRules(detail.rules.map((r) => ({ ...r }))); setDirection(null); }}><RotateCcw size={13} />撤销修改</button>}
        {visibleRules.map((rule) => { const index = rules.indexOf(rule); return <div className="bv-edit-rule" key={index}><label>{CATEGORIES[rule.category] ?? rule.category}<textarea aria-label={`风格描述 ${index + 1}`} maxLength={200} rows={2} value={rule.value} onChange={(e) => setRules((current) => current.map((r, i) => i === index ? { ...r, value: e.target.value } : r))} /></label><div><select aria-label={`描述 ${index + 1} 的使用方式`} value={rule.polarity} onChange={(e) => setRules((current) => current.map((r, i) => i === index ? { ...r, polarity: e.target.value as Rule["polarity"] } : r))}>{Object.entries(POLARITIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{rule.value.startsWith("待核对的原图标注：") && <button className="bv-text-button" onClick={() => setRules((current) => current.map((r, i) => i === index ? { ...r, value: r.value.replace(/^待核对的原图标注：/, "原图明确标注："), confirmedByUser: true } : r))}>已核对，保留</button>}<button className="bv-icon-button" aria-label={`移除描述 ${index + 1}`} onClick={() => setRules((current) => current.map((r, i) => i === index ? { ...r, deleted: true } : r))}><Trash2 size={15} /></button></div></div>; })}
      </section> : <div className="bv-style-grid">{Object.entries(CATEGORIES).map(([key, label]) => {
        const entries = visibleRules.filter((rule) => rule.category === key);
        return entries.length > 0 && <section className="bv-style-card" key={key}><h4>{label}</h4>{entries.map((rule, i) => <p key={i}>{rule.polarity === "avoid" && <span>避免 </span>}{rule.value}</p>)}</section>;
      })}</div>}
      {draft && detail.conflicts.length === 0 && detail.candidateDirections.length > 1 && <details className="bv-secondary"><summary>想偏向另一种感觉？</summary><p className="bv-hint">这些图片里有不同的风格，你可以选择更接近品牌的一种。</p><div className="bv-directions"><button aria-pressed={direction === null} onClick={() => setDirection(null)}>保留整体风格</button>{detail.candidateDirections.map((d) => <button key={d.label} aria-pressed={direction === d.label} onClick={() => setDirection(d.label)}>{d.label.replace(/\|/g, " · ")}</button>)}</div></details>}
      </details>
      {(draft || validation || adopted) && <details className="bv-secondary bv-try"><summary>先试画一张 <span>可选</span></summary><p className="bv-hint">看看这个风格用在新画面里的感觉。</p>{adopted ? <p>图片已保存到素材库。</p> : <>
        {validation && <div className="bv-trial-result">{imageFailed ? <p>图片暂时无法显示。</p> : <img src={convertFileSrc(validation.imagePath)} alt="品牌风格试画" onError={() => setImageFailed(true)} />}<div className="bv-inline-actions"><button className="app-modal-button" onClick={clearValidation}>丢弃</button><button className="app-modal-button" onClick={adopt}>保存图片</button></div></div>}
        {draft && <><label className="bv-theme">画什么<input value={theme} maxLength={120} onChange={(e) => setTheme(e.target.value)} /></label><div className="bv-directions">{THEMES.map((preset) => <button key={preset} aria-pressed={theme === preset} onClick={() => setTheme(preset)}>{preset}</button>)}</div><button className="app-modal-button" disabled={!canAnalyze || !!invalid || round >= 2 || !theme.trim()} onClick={generate}>{validation ? "再试一次" : "试画一张"} · {credits} 积分</button>{round >= 2 && <p className="bv-hint">本次试画已用完，可以直接使用风格继续创作。</p>}</>}
      </>}</details>}
      <details className="bv-secondary"><summary>历史版本 <ChevronDown size={13} /></summary>{historyRows()}</details>
    </div>}
    </fieldset>
    {!detail && history.length > 0 && <details className="bv-secondary" open={historyExpanded} onToggle={(event) => setHistoryExpanded(event.currentTarget.open)}><summary>已有规范</summary>{historyRows()}</details>}
  </ModalShell>;
}

function SourceThumbnail({ asset, index }: { asset?: Asset; index: number }) {
  const [failed, setFailed] = useState(false);
  const path = asset?.thumb_path || asset?.store_path;
  return <figure title={asset?.name ?? "素材已移除"}>{path && !failed ? <img loading="lazy" src={convertFileSrc(path)} alt={asset!.name} onError={() => setFailed(true)} /> : <span className="bv-source-missing"><Palette size={22} /><span>{asset ? "预览不可用" : "素材 " + (index + 1) + " 已移除"}</span></span>}</figure>;
}
