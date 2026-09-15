import { useState } from "react";
import { Check, Clapperboard, Megaphone, Palette } from "lucide-react";
import { ONBOARDING_ROLES, type OnboardingRole } from "../lib/onboardingRoutes";
import { useOnboarding } from "../lib/onboardingStore";
import { useStore } from "../store";
import { api } from "../lib/api";
import { ModalShell } from "./ModalShell";

const ROLE_ICONS = { designer: Palette, marketing: Megaphone, director: Clapperboard };

export function RoleOnboarding() {
  const { guide, panel, setGuide, show, patch } = useOnboarding();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [missingRole, setMissingRole] = useState<OnboardingRole | null>(null);
  async function choose(role: OnboardingRole, restart = false) {
    if (busy) return;
    setBusy(true); setError(""); setMissingRole(null);
    try {
      await useStore.getState().projectCanvasFlush?.();
      let session = restart || guide.completedRoles.includes(role) ? undefined : guide.sessions[role];
      if (session && (!session.projectId || (role === "designer" && session.step === 0 && session.reviewUntil !== undefined))) {
        await useStore.getState().exitProject();
      } else if (session) {
        const projects = await api.listProjects();
        if (!projects.some(project => project.id === session!.projectId)) {
          setMissingRole(role); throw new Error("这条路线的项目已不存在，可以重新开始。其他项目和素材不会被删除。");
        }
        await useStore.getState().reloadProjects();
        await useStore.getState().enterProject(session.projectId);
      } else if (role === "designer") {
        await useStore.getState().exitProject();
        session = { designerRevision: 2, designerEndingRevision: 1, projectId: "", runId: crypto.randomUUID(), step: 0, stepStartedAt: Date.now(), ready: false,
          baselineText: "", collectionId: null, profileId: null, analysisAssetId: null, annotationAssetId: null, tasks: {} };
      } else {
        const name = ONBOARDING_ROLES.find(item => item.id === role)!.name + " · 入门创作";
        const projectId = await useStore.getState().beginProvisionalProject(name);
        await api.projectCanvasMaterialize({ projectId, name, workspacePath: "blank:" + projectId,
          workspaceKey: "blank:" + projectId, kind: "blank", titleSource: "manual", draftJson: '{"schema_version":1}' });
        useStore.setState(state => ({ projects: state.projects.map(project => project.id === projectId ? { ...project, provisional: false } : project) }));
        await api.setActiveProject(projectId);
        session = { projectId, runId: crypto.randomUUID(), step: 0, stepStartedAt: Date.now(), ready: false,
          baselineText: "", collectionId: null, profileId: null, analysisAssetId: null, annotationAssetId: null, tasks: {} };
      }
      setGuide({ ...guide, role, status: "active", sessions: { ...guide.sessions, [role]: session },
        completedRoles: guide.completedRoles.filter(id => id !== role) });
      patch({ updateSeen: true }); show("lesson");
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  function skip() {
    setGuide({ ...guide, status: guide.completedRoles.length === ONBOARDING_ROLES.length ? "completed" : "skipped" });
    patch({ updateSeen: true }); show("closed");
  }
  const done = panel === "done";
  const name = ONBOARDING_ROLES.find(item => item.id === guide.role)?.name;
  return <ModalShell
    title={done ? guide.completedRoles.length === 3 ? "你已完成所有身份的实操引导" : name + "路线已完成" : "请选择你的身份"}
    eyebrow="欢迎使用园丁鸟AI创作系统 · 入门引导"
    description={done ? "选择另一个身份，继续完成其他路线的实操，了解完整的园丁鸟AI创作系统。"
      : "选择最贴近你的一种身份开始，园丁鸟会根据你选择的身份选择更契合你的引导路线。当然，如果你是个全能人才，别担心，后续可以所有路线都走一遍，了解完整的园丁鸟AI创作系统。"}
    width="lg" className="role-onboarding" preventClose={busy} onClose={skip}
    footer={<button className="app-modal-button" disabled={busy} onClick={skip}>{done ? "继续使用" : "跳过入门引导"}</button>}>
    <div className="guide-role-grid">{ONBOARDING_ROLES.map(item => {
      const Icon = ROLE_ICONS[item.id];
      const complete = guide.completedRoles.includes(item.id);
      return <button key={item.id} className="guide-role-card" disabled={busy} onClick={() => void choose(item.id)} aria-label={"我是" + item.name}>
        <Icon size={25} /><strong>我是{item.name}</strong><p>{item.description}</p>
        {complete && <span><Check size={14} /> {guide.sessions[item.id]?.skippedSteps?.length ? "已走完 · 含跳过步骤" : "已完成实操"}</span>}
        {!complete && guide.sessions[item.id] && <small>进度已保留</small>}
      </button>;
    })}</div>
    {busy && <p className="mt-3 text-sm text-muted" role="status">正在准备入门引导…</p>}
    {error && <p className="mt-3 text-sm text-red-400" role="alert">{error}</p>}
    {missingRole && <button className="app-modal-button mt-3" onClick={() => void choose(missingRole, true)}>重新开始这个身份的实操</button>}
  </ModalShell>;
}
