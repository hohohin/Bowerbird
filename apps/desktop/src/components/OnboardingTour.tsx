import { useEffect, useRef, useState } from "react";
import { BookOpen, Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { nextLessonStep } from "../lib/onboarding";
import { LEARNING_TOPICS, useOnboarding } from "../lib/onboardingStore";
import { ModalShell } from "./ModalShell";
import { CollectionOnboarding } from "./CollectionOnboarding";
import "./OnboardingTour.css";

const STEPS = [
  ["放一张参考到画板", "从左侧素材栏拖一张图片到画板。素材库保存图片，画板组织这次创作；同一张图可以用于多个项目。", ".canvas-source-panel"],
  ["安排你的创作空间", "拖动画板上的素材卡片，或选中后按方向键移动。一个项目就是一块画板，布局会自动保存。", "[data-canvas-stage]"],
  ["写下目标，加入参考", "点击下方输入框，写清楚想制作什么，再点击产品图加入参考。比如：为这款护发产品制作宣传图，保留产品外观，顶部留出标题空间。", '[data-tour="creation-editor"]'],
  ["借用一个图片特征", "把配色参考也拖到画板，在创作模式下点击它，打开维度环。选择「色调」等一个维度，看看输入中增加了什么。", '.canvas-source-panel'],
  ["检查并开始生成", "检查需求与参考图，选择普通图片生成，再主动点击发送。生成会使用所选服务的额度；登录或配置完成后，可以回到这份草稿继续。", ".generation-toolbar"],
] as const;

function visible(element: Element | null): element is HTMLElement {
  return !!element && element instanceof HTMLElement && element.getBoundingClientRect().width > 0
    && element.getBoundingClientRect().height > 0;
}
function hasBlockingModal() {
  return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'))
    .some(element => visible(element) && !element.hasAttribute("data-project-inspector"));
}
function editorEvidence(root: Element | null) {
  const editor = root?.querySelector('.ProseMirror');
  const copy = editor?.cloneNode(true) as HTMLElement | undefined;
  copy?.querySelectorAll('[contenteditable="false"]').forEach(node => node.remove());
  const text = copy?.textContent?.trim() ?? "";
  return { hasText: !!text && text !== "请参考", hasReference: !!editor?.querySelector('[data-asset-id]'),
    hasDimension: !!editor?.querySelector('[data-keyword]') };
}

export function LearningHint({ topic }: { topic: typeof LEARNING_TOPICS[number]["id"] }) {
  const { progress, patch } = useOnboarding();
  const item = LEARNING_TOPICS.find(item => item.id === topic)!;
  if (progress.dismissed.includes(topic) || progress.status === "active") return null;
  return <aside className="learning-hint" aria-label={item.title}>
    <div><strong>{item.title}</strong><p>{item.body}</p></div>
    <button type="button" aria-label={`关闭${item.title}提示`} onClick={() => patch({ dismissed: [...progress.dismissed, topic] })}><X size={14} /></button>
  </aside>;
}

export function OnboardingTour() {
  const { progress, panel, patch, show } = useOnboarding();
  const activeProjectId = useStore(s => s.activeProjectId);
  const routePending = useStore(s => s.projectRoutePending);
  const genJobs = useStore(s => s.genJobs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [minimized, setMinimized] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [missingDimension, setMissingDimension] = useState(false);
  const [generationReady, setGenerationReady] = useState(false);
  const moving = useRef(new Map<string, string>());
  const job = progress.jobId ? genJobs[progress.jobId] : null;
  const onProject = activeProjectId === progress.projectId && !routePending;

  // Both the lesson and the paused reminder must yield to login/settings dialogs.
  useEffect(() => {
    if (panel !== "lesson" && !(panel === "closed" && progress.status === "paused")) return;
    const inspect = () => setBlocked(hasBlockingModal());
    inspect();
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["role", "aria-modal", "hidden", "style", "class"] });
    return () => observer.disconnect();
  }, [panel, progress.status]);

  // Only the mounted lesson project and its new task can advance progress.
  useEffect(() => {
    if (panel !== "lesson" || progress.status !== "active") return;
    moving.current.clear();
    let highlighted: HTMLElement | null = null;
    const inspect = () => {
      const current = useOnboarding.getState().progress;
      const state = useStore.getState();
      const root = document.querySelector<HTMLElement>('.canvas-workspace');
      const modal = hasBlockingModal();
      const ready = state.activeProjectId === current.projectId && !state.projectRoutePending
        && root?.dataset.onboardingProject === current.projectId && root.getAttribute("aria-busy") !== "true";
      const target = ready && !modal ? (current.step === 4
        ? Array.from(document.querySelectorAll('[data-tour="creation-keywords"]')).find(visible) : null)
        ?? Array.from(root?.querySelectorAll(STEPS[current.step - 1][2]) ?? []).find(visible) : null;
      if (highlighted !== target) {
        highlighted?.classList.remove("onboarding-target");
        highlighted = target instanceof HTMLElement ? target : null;
        highlighted?.classList.add("onboarding-target");
      }
      if (!ready || modal || !root) { setGenerationReady(false); return; }
      const cards = Array.from(root.querySelectorAll<HTMLElement>('.canvas-node.is-asset')).filter(visible);
      let movedCard = false;
      for (const card of cards) {
        const id = card.dataset.canvasNodeId!;
        if (moving.current.has(id) && moving.current.get(id) !== card.style.transform) movedCard = true;
        moving.current.set(id, card.style.transform);
      }
      const editor = editorEvidence(root.querySelector('[data-onboarding-composer]'));
      const previous = current.jobId ? state.genJobs[current.jobId] : null;
      const candidate = previous && (previous.running || previous.turns.some(turn => turn.images.length)) ? previous : Object.values(state.genJobs)
        .filter(job => job.projectId === current.projectId && job.createdAt >= current.startedAt && job.media !== "video")
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (current.step === 5 && candidate && current.jobId !== candidate.id) patch({ jobId: candidate.id });
      const generated = !!candidate && !candidate.running && candidate.turns.some(turn => turn.images.length > 0)
        && candidate.projectId === current.projectId;
      setMissingDimension(current.step === 4 && !!state.captionRing && state.promptedAssetsLoaded
        && !state.promptedAssets.find(asset => asset.id === state.captionRing)?.sections?.length);
      const next = nextLessonStep(current.step, { onProject: true, hasCard: cards.length > 0, movedCard,
        ...editor, generated });
      setGenerationReady(next === 6);
      if (next !== 6 && next !== current.step) patch({ step: next });
    };
    inspect();
    const timer = setInterval(inspect, 300);
    return () => { clearInterval(timer); highlighted?.classList.remove("onboarding-target"); };
  }, [panel, progress.status, progress.step, patch, show]);

  async function start(mode: "sample" | "own" | "resume") {
    if (busy) return;
    setBusy(true); setError("");
    const origin = useStore.getState();
    const originId = origin.activeProjectId, revision = origin.projectRouteRevision;
    try {
      let id = progress.projectId;
      if (mode === "sample") {
        id = progress.sampleProjectId ?? `onboarding-${crypto.randomUUID()}`;
        patch({ sampleProjectId: id });
        const result = await api.createOnboardingProject(id);
        useStore.setState(s => ({ projects: s.projects.some(p => p.id === result.project.id)
          ? s.projects.map(p => p.id === result.project.id ? result.project : p)
          : [result.project, ...s.projects] }));
      } else if (mode === "own") {
        id = originId;
        if (!id) id = await origin.beginProvisionalProject();
      } else {
        const projects = await api.listProjects();
        if (!projects.some(project => project.id === id) && !origin.projects.some(project => project.id === id && project.provisional))
          throw new Error("原引导项目已不存在。可以使用示例或自己的图片重新开始。");
        await useStore.getState().reloadProjects();
      }
      if (!id) throw new Error("请先创建或打开一个项目");
      const route = useStore.getState();
      if (mode !== "own" && (route.projectRoutePending || route.activeProjectId !== originId || route.projectRouteRevision !== revision))
        throw new Error("页面已切换，项目已保留。请回到入门引导后继续。");
      await useStore.getState().enterProject(id);
      patch({ status: "active", projectId: id, updateSeen: true,
        ...(mode === "resume" ? {} : { step: 1, startedAt: Date.now(), jobId: null, outcome: null, skippedSteps: [] }) });
      setMinimized(false); show("lesson");
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  async function pause(prepared = false) {
    try {
      await useStore.getState().projectCanvasFlush?.();
      if (useOnboarding.getState().progress.status !== "active" || useOnboarding.getState().panel !== "lesson") return;
      patch({ status: "paused", ...(prepared ? { outcome: "prepared" as const } : {}) });
      show(prepared ? "done" : "closed");
    } catch { setError("草稿尚未保存，学习进度仍保留。请重试或查看画板保存提示。"); }
  }

  function skip() {
    // Dismissing help does not navigate away or discard the canvas draft.
    patch({ status: progress.status === "completed" ? "completed" : "skipped", updateSeen: true });
    setError(""); show("closed");
  }

  async function learnCollections() {
    try {
      await useStore.getState().projectCanvasFlush?.();
      patch({ updateSeen: true, ...(useOnboarding.getState().progress.status === "active" ? { status: "paused" as const } : {}) });
      show("collections");
    } catch { setError("草稿尚未保存，请保存后再学习集合。"); }
  }

  if (panel === "collections") return <CollectionOnboarding />;
  if (panel === "closed") return progress.status === "paused" && !blocked
    ? <aside className="onboarding-resume" aria-label="入门引导提醒">
      <button onClick={() => show("welcome")}><BookOpen size={14} />继续入门引导</button>
      <button aria-label="跳过入门引导" title="跳过入门引导，可在设置中重新打开" onClick={skip}><X size={14} /></button>
    </aside> : null;
  if (panel === "welcome") return <ModalShell title="把参考图里的灵感，变成你的作品" eyebrow="入门引导"
    description="在一块画板上，试一次放入参考、借用特征和生成作品。示例准备无需登录或调用模型。"
    width="md" preventClose={busy} onClose={skip}
    footer={<><button className="app-modal-button" disabled={busy} onClick={skip}>跳过入门引导</button>
      <button className="app-modal-button is-primary" disabled={busy} onClick={() => void start("sample")}>{busy ? "准备中…" : "跟着示例做一次"}</button></>}>
    <p className="mb-3 text-sm text-muted">示例包含护发产品和蓝色配色参考，已有可借用的图片维度。生成前由你确认使用的模型和额度。</p>
    <div className="flex flex-wrap gap-2">
      {progress.projectId && progress.status !== "completed" && <button className="app-modal-button" disabled={busy} onClick={() => void start("resume")}>继续上次进度 · {progress.step}/{STEPS.length}</button>}
      <button className="app-modal-button" disabled={busy} onClick={() => void start("own")}>用自己的图片开始</button>
    </div>
    <button className="app-modal-button mt-4" disabled={busy} onClick={() => void learnCollections()}>学习集合与视觉规范</button>
    {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
    <div className="mt-5 space-y-2"><strong className="text-sm">按需学习</strong>{LEARNING_TOPICS.map(item => <details className="onboarding-topic" key={item.id}><summary>{item.title}</summary><p>{item.body}</p></details>)}</div>
  </ModalShell>;
  if (panel === "update") return <ModalShell title="新版创作，从项目画板开始" eyebrow="新版变化" width="sm"
    onClose={() => { patch({ updateSeen: true }); show("closed"); }}
    footer={<><button className="app-modal-button" onClick={() => { patch({ updateSeen: true }); show("closed"); }}>知道了</button><button className="app-modal-button is-primary" onClick={() => { patch({ updateSeen: true }); show("welcome"); }}>体验新版引导</button></>}>
    <ol className="space-y-4 text-sm"><li><strong>项目就是画板</strong><p className="text-muted">参考、创作过程和多次结果，在一个空间里组织。</p></li>
      <li><strong>探索就在创作旁边</strong><p className="text-muted">边浏览边收集。Windows 可直接拖图到画板落点。</p></li>
      <li><strong>集合整理参考，规范跨项目用</strong><p className="text-muted">创建集合并加入图片；按需提炼、保存规范，再到创作输入中主动选择。</p></li></ol>
  </ModalShell>;
  if (panel === "done") return <ModalShell title={progress.outcome === "generated" ? "第一条创作路径已完成" : "你已学会准备一次创作"}
    eyebrow="入门引导" width="sm" onClose={() => show("closed")}
    footer={<><button className="app-modal-button" onClick={() => void learnCollections()}>学习集合与视觉规范</button><button className="app-modal-button is-primary" onClick={() => show("closed")}>继续使用</button></>}>
    <p className="text-sm text-muted">{progress.outcome === "generated" ? "结果已生成并保留在项目中。你已完成这次从参考到作品的创作。" : "参考与需求留在项目里。准备好模型或账号后，可继续入门引导并尝试生成。"}</p>
    <p className="mt-4 text-sm">下一步：把相关图片整理成集合，按需提炼视觉规范。更多教程在「设置 → 系统设置 → 入门引导」。</p>
    {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
  </ModalShell>;
  if (blocked) return null;
  return <aside className={`onboarding-lesson${minimized ? " is-minimized" : ""}`} aria-label="入门任务清单">
    <header><span><BookOpen size={14} /> 入门引导 · {progress.step}/{STEPS.length}</span><div>
      <button aria-label={minimized ? "展开入门引导" : "收起入门引导"} onClick={() => setMinimized(!minimized)}>{minimized ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</button>
      <button aria-label="暂停入门引导" onClick={() => void pause()}><X size={15} /></button></div></header>
    {!minimized && <>
      <ol>{STEPS.map(([title], index) => <li key={title} aria-current={progress.step === index + 1 ? "step" : undefined} className={index + 1 < progress.step ? "is-complete" : ""}><span>{progress.skippedSteps.includes(index + 1) ? "–" : index + 1 < progress.step ? <Check size={12} /> : index + 1}</span>{title}{progress.skippedSteps.includes(index + 1) && " · 已跳过"}</li>)}</ol>
      <p aria-live="polite">{onProject ? generationReady ? "已收到这次生成的结果。可以完成入门引导，或接着学习如何用集合整理参考。" : STEPS[progress.step - 1][1] : "你已离开引导项目，学习进度已保留。回到原项目后继续。"}</p>
      {!onProject && <button className="app-modal-button" disabled={busy} onClick={() => void start("resume")}>回到引导项目</button>}
      {onProject && progress.step === 1 && <small>没有素材时，可先导入本地图片，再从素材栏拖入。</small>}
      {onProject && missingDimension && <div><small>这张图片还没有可用维度。可换一张已有反推的图片，或稍后再分析。</small><button className="app-modal-button" onClick={() => void pause()}>稍后学习维度</button></div>}
      {onProject && progress.step === 4 && <button className="app-modal-button" onClick={() => patch({ step: 5, skippedSteps: [4] })}>暂不借用维度，继续准备</button>}
      {onProject && progress.step === 5 && !generationReady && <div className="space-y-2">
        {job?.running && <p role="status">任务进行中。可以暂停教程，结果不会因此取消。</p>}
        {job && !job.running && !job.turns.some(turn => turn.images.length) && <p role="status">尚未取得生成结果。请查看任务提示，重试后继续。</p>}
        <button className="app-modal-button" onClick={() => void pause(true)}>先完成准备，稍后生成</button>
      </div>}
      {onProject && progress.step === 5 && generationReady && <div className="space-y-2">
        <button className="app-modal-button is-primary" disabled={!generationReady} onClick={() => {
          patch({ status: "completed", outcome: "generated" }); show("done");
        }}>完成入门引导</button>
      </div>}
      {error && <p role="alert" className="text-red-400">{error}</p>}
      <button className="onboarding-pause" onClick={() => void pause()}>稍后继续</button>
    </>}
    <button className="onboarding-skip" disabled={busy} title="跳过后可在设置 → 系统设置 → 入门引导中继续" onClick={skip}>跳过入门引导</button>
  </aside>;
}
