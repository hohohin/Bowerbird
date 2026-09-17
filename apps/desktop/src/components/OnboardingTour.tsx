import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { useStore } from "../store";
import { LEARNING_TOPICS, useOnboarding } from "../lib/onboardingStore";
import { advanceRoleGuide, previousRoleGuide, ONBOARDING_ROLES, ONBOARDING_ROUTES, practiceReady } from "../lib/onboardingRoutes";
import { RoleOnboarding } from "./RoleOnboarding";
import { CollectionOnboarding } from "./CollectionOnboarding";
import { ExploreDragDemo, OnboardingSpotlight } from "./OnboardingSpotlight";
import { api } from "../lib/api";
import type { PromptedAsset } from "../lib/types";
import { createPortal } from "react-dom";
import { OnboardingCompletion } from "./OnboardingCompletion";
import "./OnboardingTour.css";

function visible(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
}
function hasBlockingModal() {
  return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'))
    .some(element => visible(element) && !element.hasAttribute("data-project-inspector") && !element.classList.contains("onboarding-completion"));
}
function editorState() {
  const root = document.querySelector<HTMLElement>(".canvas-workspace");
  const editor = root?.querySelector<HTMLElement>("[data-onboarding-composer] .ProseMirror");
  const copy = editor?.cloneNode(true) as HTMLElement | undefined;
  copy?.querySelectorAll('[contenteditable="false"]').forEach(node => node.remove());
  const paragraphs = copy?.querySelectorAll("p");
  const text = paragraphs?.length ? Array.from(paragraphs).map(p => p.textContent ?? "").join("\n") : copy?.textContent ?? "";
  return { root, editor, text };
}

export function LearningHint({ topic }: { topic: typeof LEARNING_TOPICS[number]["id"] }) {
  const { progress, guide, patch } = useOnboarding();
  const item = LEARNING_TOPICS.find(item => item.id === topic)!;
  if (progress.dismissed.includes(topic) || guide.status === "active") return null;
  return <aside className="learning-hint" aria-label={item.title}>
    <div><strong>{item.title}</strong><p>{item.body}</p></div>
    <button type="button" aria-label={"关闭" + item.title + "提示"} onClick={() => patch({ dismissed: [...progress.dismissed, topic] })}><X size={14} /></button>
  </aside>;
}

export function OnboardingTour() {
  const { guide, panel, setGuide, show, patch } = useOnboarding();
  const activeProjectId = useStore(s => s.activeProjectId);
  const routePending = useStore(s => s.projectRoutePending);
  const [blocked, setBlocked] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [error, setError] = useState("");
  const [exploring, setExploring] = useState(false);
  const [sample, setSample] = useState<PromptedAsset | null>(null);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleAttempt, setSampleAttempt] = useState(0);
  const captionRing = useStore(state => state.captionRing);
  const boardOpen = useStore(state => state.boardOpen);
  const session = guide.role && guide.sessions[guide.role];
  const steps = guide.role ? ONBOARDING_ROUTES[guide.role] : [];
  const step = session ? steps[session.step] : null;
  const reviewing = !!session && session.reviewUntil !== undefined && session.step < session.reviewUntil;
  const onProject = !!session && !routePending && ((session.projectId || null) === activeProjectId
    || (reviewing && step?.scene === "create-project" && !activeProjectId));
  const sampleStep = step?.scene === "sample-dimensions" || step?.scene === "pick-prompt";

  useEffect(() => {
    if (guide.role !== "designer" || guide.status !== "active" || panel !== "lesson" || step?.scene !== "more-uses" || !onProject) return;
    document.querySelector<HTMLButtonElement>('[data-tour=explore][aria-pressed=true]')?.click();
  }, [guide.role, guide.status, panel, step?.scene, onProject]);

  useEffect(() => {
    setSample(null);
    if (!sampleStep || !session?.projectId || !onProject) return;
    let alive = true;
    setSampleLoading(true);
    void api.listPromptedAssets(session.projectId).then(assets => {
      if (!alive) return;
      const candidates = assets.filter(asset => asset.sections?.some(section => section.title === "反推提示词") && /(?:^|[\\/])初始引导[\\/](?:sample-dimensions\.(?:webp|png|jpe?g)|asset-01[46]\.webp)$/i.test(asset.origin_path ?? ""));
      const selected = candidates.find(asset => /sample-dimensions\./i.test(asset.origin_path ?? "")) ?? candidates[0] ?? null;
      setSample(selected);
      // Left-click uses the existing cached dimension data; never start analysis.
      if (selected) useStore.setState(state => ({ promptedAssets: [...state.promptedAssets.filter(asset => asset.id !== selected.id), selected] }));
    }).catch(() => { if (alive) setSample(null); }).finally(() => { if (alive) setSampleLoading(false); });
    return () => { alive = false; };
  }, [sampleStep, session && session.runId, session && session.projectId, onProject, sampleAttempt]);

  useEffect(() => {
    if (step?.scene === "pick-prompt" && !session?.ready && sample && onProject && panel === "lesson") useStore.getState().openCaptionRing(sample.id);
  }, [step?.scene, sample?.id, onProject, panel]);

  useEffect(() => {
    if (!sample || !onProject) return;
    const timer = setInterval(() => {
      const element = document.querySelector<HTMLElement>(`.canvas-source-panel [data-asset-id="${CSS.escape(sample.id)}"]`);
      if (element) { element.scrollIntoView({ block: "nearest" }); clearInterval(timer); }
    }, 150);
    return () => clearInterval(timer);
  }, [sample?.id, onProject]);

  useEffect(() => {
    const inspect = () => setBlocked(hasBlockingModal());
    inspect();
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "aria-modal", "hidden", "style"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (step?.scene === "pick-prompt" && session?.ready) useStore.getState().closeCaptionRing();
  }, [step?.scene, session?.ready]);

  useEffect(() => {
    if (!session || !["active", "paused"].includes(guide.status)) return;
    function inspect() {
      const store = useOnboarding.getState();
      const current = store.guide;
      const role = current.role;
      const lesson = role && current.sessions[role];
      if (!role || !lesson) return;
      const state = useStore.getState();
      const modal = hasBlockingModal();
      setBlocked(modal);
      const { root, editor, text } = editorState();
      const readyProject = state.activeProjectId === lesson.projectId && !state.projectRoutePending
        && root?.dataset.onboardingProject === lesson.projectId && root.getAttribute("aria-busy") !== "true";
      const currentStep = ONBOARDING_ROUTES[role][lesson.step];
      // Freeze participating turn indices so a restart can recover real outcomes,
      // without accepting an old result merely because its history was opened.
      const tasks = { ...lesson.tasks };
      let tasksChanged = false, imageCount = 0, videoCount = 0;
      for (const job of Object.values(state.genJobs)) {
        if (job.projectId !== lesson.projectId) continue;
        const from = job.turns.findIndex(turn => typeof turn.startedAt === "number" && turn.startedAt >= lesson.stepStartedAt);
        if (from >= 0 && tasks[job.id] === undefined) { tasks[job.id] = from; tasksChanged = true; }
        const start = tasks[job.id];
        if (start === undefined) continue;
        job.turns.slice(start).forEach((turn, index) => {
          if (turn.error || (job.running && start + index === job.turns.length - 1)) return;
          if (currentStep.scene === "edit" && !turn.refAssets?.some(asset => asset.id === lesson.annotationAssetId)) return;
          if ((turn.media ?? job.media) === "video") videoCount += turn.images.length;
          else if (currentStep.scene !== "batch" || (job.visualProfileId ?? job.visualProfile?.profileId) === lesson.profileId)
            imageCount += turn.images.length;
        });
      }
      const images = new Set(Array.from(editor?.querySelectorAll<HTMLElement>("[data-asset-id]") ?? []).map(node => node.dataset.assetId));
      const hasDimensionOnly = !!lesson.analysisAssetId && Array.from(editor?.querySelectorAll<HTMLElement>("[data-keyword]") ?? [])
        .some(node => node.dataset.sourceAssetId === lesson.analysisAssetId && !images.has(node.dataset.sourceAssetId));
      const explorerOpen = !!document.querySelector('[data-tour=explore][aria-pressed=true]');
      setExploring(explorerOpen);
      const sourcesExpanded = Array.from(document.querySelectorAll(".canvas-source-collapse")).some(visible);
      const hasPrompt = !!sample && Array.from(editor?.querySelectorAll<HTMLElement>("[data-keyword]") ?? [])
        .some(node => node.dataset.sourceAssetId === sample.id && node.textContent === "【反推提示词】");
      const ready = lesson.ready || (readyProject && ((currentStep.scene === "open-explore" && explorerOpen)
        || (currentStep.scene === "expand-source" && sourcesExpanded)
        || (currentStep.scene === "pick-prompt" && hasPrompt)
        || (currentStep.scene === "sample-dimensions" && !!sample && state.captionRing === sample.id && !!document.querySelector(".caption-ring-svg [data-dim]")))) || practiceReady(currentStep.scene, lesson, {
        onProject: !!readyProject, text, hasDimensionOnly, imageCount, videoCount,
      });
      const updated = { ...current, sessions: { ...current.sessions, [role]: { ...lesson, tasks, ready } } };
      // Successful real operations immediately reveal the next control. Reading
      // the source explanation and finishing the route remain explicit actions.
      if (role === "designer" && !(lesson.reviewUntil !== undefined && lesson.step < lesson.reviewUntil) && ready && readyProject && !modal && current.status === "active" && store.panel === "lesson"
        && ["create-project", "folder", "open-explore", "explore", "activate-composer", "sample-dimensions"].includes(currentStep.scene)) {
        store.setGuide(advanceRoleGuide(updated, text));
      } else if (tasksChanged || ready !== lesson.ready) store.setGuide(updated);
    }
    inspect();
    const timer = setInterval(inspect, 250);
    return () => clearInterval(timer);
  }, [guide.role, session && session.runId, session && session.step, guide.status, panel, sample?.id]);

  async function nextStep(skipStep = false) {
    const before = useOnboarding.getState();
    const role = before.guide.role, lesson = role && before.guide.sessions[role];
    if (!role || !lesson) return;
    try {
      if (lesson.step === 0 && lesson.projectId && !activeProjectId) await useStore.getState().enterProject(lesson.projectId);
      const current = useOnboarding.getState();
      if (current.guide !== before.guide) return;
      const next = advanceRoleGuide(current.guide, editorState().text, Date.now(), skipStep);
      current.setGuide(next);
      if (next.status !== "active") {
        useStore.getState().closeCaptionRing();
        if (role === "designer") {
          // Return to the creative workspace when dismissing the completion dialog.
          document.querySelector<HTMLButtonElement>('[data-tour=explore][aria-pressed=true]')?.click();
          current.show("closed");
        } else current.show("done");
      } else if (ONBOARDING_ROUTES[role][next.sessions[role]!.step].scene === "ready-to-create") useStore.getState().closeCaptionRing();
    } catch { setError("项目尚未打开，请重试。"); }
  }
  async function previousStep() {
    const before = useOnboarding.getState();
    const next = previousRoleGuide(before.guide);
    if (next === before.guide) return;
    try {
      if (next.role === "designer" && next.sessions.designer?.step === 0) await useStore.getState().exitProject();
      const current = useOnboarding.getState();
      if (current.guide !== before.guide) return;
      useStore.getState().closeCaptionRing();
      current.setGuide(next);
    } catch { setError("草稿尚未保存，请重试。"); }
  }

  function skip() {
    setGuide({ ...guide, status: guide.completedRoles.length === 3 ? "completed" : "skipped" });
    patch({ updateSeen: true }); setError(""); show("closed");
  }
  async function pause(switchRole = false) {
    const before = useOnboarding.getState();
    try {
      await useStore.getState().projectCanvasFlush?.();
      const current = useOnboarding.getState();
      if (current.guide.role !== before.guide.role || current.guide.status !== "active" || current.panel !== "lesson") return;
      current.setGuide({ ...current.guide, status: "paused" }); setError(""); current.show(switchRole ? "welcome" : "closed");
    } catch { setError("草稿尚未保存，请重试。也可以跳过引导，当前草稿和进度会保留。"); }
  }
  if (panel === "collections") return <CollectionOnboarding />;
  if (panel === "welcome" || panel === "done") return <RoleOnboarding />;
  if (panel === "closed") return guide.status === "paused" && !blocked
    ? <OnboardingResumeHint onResume={() => show("welcome")} onSkip={skip} /> : null;
  if (!session || !step || blocked) return null;
  if (guide.role === "designer" && step.scene === "ready-to-create") return <OnboardingCompletion
    onComplete={() => void nextStep()} onPrevious={() => void previousStep()} onSkip={() => void nextStep(true)}
    disabled={routePending || !session.ready} error={error} stepNumber={session.step + 1} totalSteps={steps.length} />;
  const roleName = ONBOARDING_ROLES.find(role => role.id === guide.role)!.name;
  const designer = guide.role === "designer";
  const needsProject = designer && !session.projectId && step.scene !== "create-project";
  const sampleTarget = sample ? `.canvas-source-panel [data-asset-id="${CSS.escape(sample.id)}"]` : ".canvas-source-panel";
  const promptAdded = step.scene === "pick-prompt" && session.ready;
  const displayStep = promptAdded ? { ...step, target: "[data-onboarding-composer]", highlight: undefined, title: "维度已加入对话框", body: "所选的「反推提示词」维度已经添加到了对话框。你可以继续补充创作需求。" } : needsProject ? { ...step, target: "[data-tour=new-creation]", highlight: undefined }
    : sampleStep && (step.scene === "sample-dimensions" || !captionRing) ? { ...step, target: sampleTarget, highlight: sample ? sampleTarget : undefined } : step;
  const content = <>
    <header><span><BookOpen size={18} />{roleName} · {session.step + 1}/{steps.length}</span><div>
      <button aria-label="上一步" title="上一步" disabled={session.step === 0 || routePending} onClick={() => void previousStep()}><ArrowLeft size={20} /></button>
      <button aria-label="跳过此步" title="跳过此步" disabled={routePending} onClick={() => void nextStep(true)}><ArrowRight size={20} /></button>
      <button aria-label={minimized ? "展开入门引导" : "收起入门引导"} onClick={() => setMinimized(!minimized)}>{minimized ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</button>
      <button aria-label="暂停入门引导" onClick={() => void pause()}><X size={15} /></button></div></header>
    {!minimized && <>
      {designer ? <h2>{displayStep.title}</h2> : <ol>{steps.map((item, index) => <li key={item.scene} aria-current={session.step === index ? "step" : undefined} className={index < session.step ? "is-complete" : ""}>
        <span>{session.skippedSteps?.includes(index) ? "—" : index < session.step ? <Check size={12} /> : index + 1}</span>{item.title}{session.skippedSteps?.includes(index) ? "（已跳过）" : ""}</li>)}</ol>}
      <p className="onboarding-step-copy">{(onProject ? displayStep.body : "你已离开本路线的项目。进度已保留，请回到实操项目继续。").split("**").map((text, index) => index % 2 ? <strong key={index}>{text}</strong> : text)}</p>
      {needsProject && <p>这一步需要项目。请点击「新建创作」继续，也可以跳过此步。</p>}
      {onProject && !needsProject && sampleStep && !promptAdded && <>
        {sample ? !captionRing && <p>请左键点击框选的「初始引导」示例图，打开维度环。</p>
          : <p role="status">{sampleLoading ? "正在查找示例图…" : "未找到带反推数据的示例图。请先导入「初始引导」文件夹，再重新查找；也可以跳过此步。"}</p>}
        {!sample && !sampleLoading && <button className="app-modal-button" onClick={() => setSampleAttempt(value => value + 1)}>重新查找示例图</button>}
        {!boardOpen && <button className="app-modal-button" onClick={() => document.querySelector<HTMLElement>("[data-onboarding-composer] .ProseMirror")?.focus()}>激活创作模式</button>}
      </>}
      {designer && onProject && step.scene === "explore" && <>
        {!exploring && <button className="app-modal-button" onClick={() => document.querySelector<HTMLButtonElement>("[data-tour=explore]")?.click()}>打开探索继续采集</button>}
        <ExploreDragDemo />
      </>}
      {!onProject && <button className="app-modal-button" onClick={() => show("welcome")}>返回身份页并继续项目</button>}
      {onProject && <>
        {step.scene !== "more-uses" && <p role="status">{reviewing ? "点击下一步继续。" : session.ready ? step.scene === "workspace" || step.scene === "source-scope" ? "了解后继续下一步。" : "已检测到本步操作完成，可以继续。" : designer ? "请在界面中完成这一步操作。" : "完成上面的实际操作后，才能继续。"}</p>}
        {(!designer || reviewing || ["source-scope", "expand-source", "pick-prompt", "more-uses"].includes(step.scene)) && <button className="app-modal-button is-primary" disabled={!session.ready && !reviewing} onClick={() => void nextStep()}>{session.step === steps.length - 1 ? "完成这条路线" : "下一步"}</button>}
      </>}
      {error && <p role="alert" className="text-red-400">{error}</p>}
      <div className="onboarding-lesson-actions"><button className="onboarding-pause" onClick={() => void pause(true)}>切换身份</button><button className="onboarding-pause" onClick={() => void pause()}>稍后继续</button></div>
    </>}
    <button className="onboarding-skip" onClick={skip}>跳过入门引导</button>
  </>;
  return designer && onProject ? <OnboardingSpotlight step={displayStep} minimized={minimized} ringOpen={sampleStep && !promptAdded && !!captionRing}>{content}</OnboardingSpotlight>
    : <aside className={"onboarding-lesson" + (minimized ? " is-minimized" : "")} aria-label="入门任务清单">{content}</aside>;
}

function OnboardingResumeHint({ onResume, onSkip }: { onResume: () => void; onSkip: () => void }) {
  const [top, setTop] = useState(80);
  useEffect(() => {
    const measure = () => setTop((document.querySelector("[data-tour=app-status]")?.getBoundingClientRect().bottom ?? 64) + 12);
    measure();
    const timer = setInterval(measure, 200);
    return () => clearInterval(timer);
  }, []);
  return createPortal(<aside className="onboarding-resume" style={{ top }} aria-label="入门引导提醒">
    <button onClick={onResume}><BookOpen size={14} />继续入门引导</button>
    <button aria-label="跳过入门引导" onClick={onSkip}><X size={14} /></button>
  </aside>, document.body);
}
