import { create } from "zustand";
import { ONBOARDING_KEY, parseOnboarding, type OnboardingProgress } from "./onboarding";
import { freshRoleGuide, ONBOARDING_ROUTES, parseRoleGuide, type GuideScene, type RoleGuideProgress, type RoleSession } from "./onboardingRoutes";

const ROLE_GUIDE_KEY = "bowerbird.onboarding.roles.v2";
function readGuide() {
  try { return parseRoleGuide(JSON.parse(localStorage.getItem(ROLE_GUIDE_KEY) ?? "null")); }
  catch { return freshRoleGuide(); }
}
type OnboardingPanel = "welcome" | "lesson" | "done" | "closed" | "collections";

function read() {
  try { return parseOnboarding(localStorage.getItem(ONBOARDING_KEY)); }
  catch { return parseOnboarding(null); }
}
export const useOnboarding = create<{
  progress: OnboardingProgress;
  guide: RoleGuideProgress;
  setGuide: (guide: RoleGuideProgress) => void;
  panel: OnboardingPanel;
  patch: (patch: Partial<OnboardingProgress>) => void;
  open: () => void;
  show: (panel: OnboardingPanel) => void;
}>((set, get) => ({
  progress: read(), guide: readGuide(), panel: "closed",
  setGuide: (guide) => {
    try { localStorage.setItem(ROLE_GUIDE_KEY, JSON.stringify(guide)); } catch { /* Keep this session usable. */ }
    set({ guide });
  },
  patch: (patch) => {
    const progress = { ...get().progress, ...patch };
    try { localStorage.setItem(ONBOARDING_KEY, JSON.stringify(progress)); } catch { /* in-memory session remains usable */ }
    set({ progress });
  },
  open: () => set({ panel: "welcome" }),
  show: (panel) => set({ panel }),
}));

/** Capture before an operation; late success cannot advance another project, step or replay. */
export function beginOnboardingOperation(scene: GuideScene, projectId: string | null) {
  const initial = useOnboarding.getState().guide;
  const role = initial.role;
  const session = role && initial.sessions[role];
  return (details: Partial<Pick<RoleSession, "projectId" | "collectionId" | "profileId" | "analysisAssetId" | "annotationAssetId">> = {}) => {
    const store = useOnboarding.getState();
    const current = role && store.guide.sessions[role];
    if (!role || !session || !current || initial.status !== "active" || store.guide.role !== role
      || !["active", "paused"].includes(store.guide.status) || (current.projectId || null) !== projectId
      || current.runId !== session.runId || current.step !== session.step
      || (ONBOARDING_ROUTES[role][current.step].scene !== scene && !(scene === "create-project" && role === "designer" && !current.projectId))) return;
    if (scene === "create-project" && !details.projectId) return;
    if (scene === "profile" && details.collectionId !== current.collectionId) return;
    if (scene === "profile-select" && details.profileId !== current.profileId) return;
    store.setGuide({ ...store.guide, sessions: { ...store.guide.sessions, [role]: { ...current, ...details, ready: scene === "create-project" && current.step !== 0 ? current.ready : true } } });
  };
}

export const LEARNING_TOPICS = [
  { id: "explore", title: "探索：把灵感拖到画板", body: "Windows 支持从左侧网页拖图到右侧画板，松手的位置就是卡片落点。素材栏会自动收起，点击窄栏可重新展开。网站可能需要你先登录；也可以导入本地图片。" },
  { id: "dimensions", title: "反推：借用图片的某个特征", body: "素材库里长按图片，或在画板创作模式下点击图片，可查看已有维度；选择维度即可加入创作输入。没有维度时，可在右键菜单中反推；开始前查看所选模型和用量。" },
  { id: "visual-profile", title: "视觉规范：让一组作品保持一致", body: "在集合中开始提炼，查看分析用量与总结费用。保存规范后，在创作输入中主动选择；已保存的规范可以跨项目使用。" },
  { id: "classification", title: "本地分类：先用少量图片试试", body: "首次使用需下载约 756 MB 的模型包，分类在本机运行。先选少量素材检查标签，再决定是否开启自动处理。分类标签与反推维度分别管理。" },
  { id: "arrange", title: "画板整理：把相关素材放在一起", body: "空白拖动可框选，拖动选中卡片可整体移动。素材叠在另一张上停留 1 秒可建组；右键菜单可整理布局。画板素材组不会改变素材库文件夹。" },
] as const;
