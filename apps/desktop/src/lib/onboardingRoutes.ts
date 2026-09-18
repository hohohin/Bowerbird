export const ONBOARDING_ROLES = [
  { id: "designer", name: "设计师", description: "大量收集灵感，重构脑海中的画面，快速测试想法" },
  { id: "marketing", name: "市场运营", description: "整理品牌规范，快速、批量生成营销内容" },
  { id: "director", name: "视频编导", description: "编写分镜脚本，制作分镜表，制作视频" },
] as const;
export type OnboardingRole = typeof ONBOARDING_ROLES[number]["id"];
export type GuideScene = "more-uses" | "pick-prompt" | "ready-to-create" | "activate-composer" | "sample-dimensions" | "create-project" | "source-scope" | "open-explore" | "expand-source" | "workspace" | "import" | "folder" | "explore" | "annotate" | "edit" | "analyse" | "dimensions" | "collections" | "profile" | "profile-select" | "batch" | "script" | "storyboard" | "video";
export interface GuideStep { scene: GuideScene; title: string; body: string; target: string; highlight?: string }
const workspace: GuideStep = { scene: "workspace", title: "认识真实工作台", body: "顶部可以导入和探索，左侧管理素材与项目，中央是本次创作的画板，下方输入需求。先在界面中找到这几个区域，再继续。", target: ".app-topbar, .app-sidebar, .canvas-source-panel, .canvas-board-toolbar, [data-tour=creation-editor]" };
const importStep: GuideStep = { scene: "import", title: "导入你的图片", body: "点击顶部「导入 → 导入图片」，从电脑选择一张参考图。导入成功后，图片会出现在左侧素材栏。", target: "[data-import-trigger], [data-tour=import-files], .canvas-source-panel" };
export const ONBOARDING_ROUTES: Record<OnboardingRole, GuideStep[]> = {
  designer: [
    { scene: "create-project", title: "创建第一个项目", body: "现在我们的巢里什么都没有，先来创建一个新的项目吧", target: "[data-tour=new-creation]" },
    { scene: "folder", title: "导入初始引导文件夹", body: "点击「导入 → 导入文件夹」，在打开的位置选择「初始引导」文件夹，将示例素材导入这个项目。", target: "[data-import-trigger], [role=menu][aria-label=导入素材]", highlight: "[data-tour=import-folder]" },
    { scene: "source-scope", title: "认识素材的归属", body: "目前我们在项目中进行导入，则素材默认归为所打开的项目。\n你也可以在主界面导入素材/文件夹，那所导入的素材则属于全局素材。", target: ".canvas-source-panel", highlight: "[data-tour=source-scope]" },
    { scene: "open-explore", title: "打开探索", body: "你可以点击这里，直接浏览常用网站，收集灵感", target: "[data-tour=explore]" },
    { scene: "explore", title: "把喜欢的素材拖到画板", body: "选一张喜欢的素材，按住图片拖到右侧画板并松开。", target: "[data-canvas-stage]" },
    { scene: "expand-source", title: "", body: "探索面板展开时，素材库面板会收起来\n点击这里即可重新打开", target: ".canvas-workspace", highlight: ".canvas-source-expand, .canvas-source-collapse" },
    { scene: "activate-composer", title: "激活创作模式", body: "点击对话框激活创作模式", target: "[data-onboarding-composer]" },
    { scene: "sample-dimensions", title: "认识反推和维度环", body: "对于一张图片，你可以通过**反推**来获得其风格、类型、技术细节等提示词或者反推提示词。\n当你不想图像模型过多参考原图片的时候，可以试着用维度来进行生成\n反推需要登录，所以我们先试试看这张已经有反推数据的图片", target: ".canvas-source-panel" },
    { scene: "pick-prompt", title: "添加反推提示词", body: "请点击选择「反推提示词」维度，将其添加到对话框", target: '[data-dim="反推提示词"]', highlight: '[data-dim="反推提示词"]' },
    { scene: "more-uses", title: "探索更多使用方法", body: "这里还有更多使用方法，一定要试试哦！", target: ".canvas-workspace" },
    { scene: "ready-to-create", title: "入门引导已完成", body: "恭喜你，已完成设计师入门引导！现在你已经准备好生成了，开始筑巢吧。", target: ".onboarding-completion" },
  ],
  marketing: [workspace, importStep,
    { scene: "collections", title: "整理一个品牌素材集合", body: "在左侧「集合」旁点击 +，按品牌命名；打开集合，通过「添加素材」选择图片，确认添加。也可以打开一个已有素材的品牌集合。", target: ".app-sidebar, [data-tour=collection-panel]" },
    { scene: "profile", title: "提炼并保存品牌规范", body: "在刚整理的集合中打开「视觉规范」，检查用量后开始提炼。查看提炼结果，点击「保存规范」。保存成功后再回到画板。", target: "[data-tour=collection-panel], .app-sidebar" },
    { scene: "profile-select", title: "在创作中选用规范", body: "回到这个项目，在创作输入的「品牌规范」中选择刚保存的规范。保存规范不会自动选用，需要在这里主动选择。", target: "select[aria-label=品牌视觉规范]" },
    { scene: "batch", title: "制作多张营销内容", body: "写下活动受众、产品和版式要求，加入产品参考图，使用刚选的品牌规范进行普通图片生成。制作至少两张营销图片；也可以分两次发送不同需求。等待实际结果后完成。", target: "[data-tour=creation-editor], .generation-toolbar" },
  ],
  director: [workspace, importStep,
    { scene: "script", title: "编写你的分镜脚本", body: "在下方创作输入中写下分镜脚本：按镜头列出主体、景别、动作、镜头运动与时长。先分行写至少两个镜头，保留脚本供下一步制作分镜表。", target: "[data-tour=creation-editor]" },
    { scene: "storyboard", title: "把脚本制作成分镜表", body: "在脚本后补充「制作分镜表图片，逐格列出镜号、景别、画面内容和镜头运动」，加入参考素材。选择普通图片生成，检查服务与用量后发送，等待分镜表结果。", target: "[data-tour=creation-editor], .generation-toolbar" },
    { scene: "video", title: "制作一个视频镜头", body: "选择视频生成，根据分镜表写出一个镜头的主体动作、镜头运动和场景变化；按当前模式加入参考，确认首尾帧顺序、时长、画幅与用量，主动发送并等待实际视频结果。", target: "[data-tour=creation-editor], .generation-toolbar" },
  ],
};
export interface RoleSession {
  designerRevision?: 2;
  designerEndingRevision?: 1;
  skippedSteps?: number[];
  stepVisit?: number;
  reviewUntil?: number;
  projectId: string; runId: string; step: number; stepStartedAt: number; ready: boolean;
  baselineText: string; collectionId: string | null; profileId: string | null; analysisAssetId: string | null;
  tasks: Record<string, number>;
  annotationAssetId: string | null;
}
export interface RoleGuideProgress {
  version: 2;
  role: OnboardingRole | null;
  status: "new" | "active" | "paused" | "skipped" | "completed";
  sessions: Partial<Record<OnboardingRole, RoleSession>>;
  completedRoles: OnboardingRole[];
}
export const freshRoleGuide = (): RoleGuideProgress => ({ version: 2, role: null, status: "new", sessions: {}, completedRoles: [] });
export function parseRoleGuide(value: unknown): RoleGuideProgress {
  const fresh = freshRoleGuide();
  if (!value || typeof value !== "object") return fresh;
  const p = value as Partial<RoleGuideProgress>;
  // The discarded demonstration never counts as completing practice.
  if (p.version !== 2) return fresh;
  const roles = ONBOARDING_ROLES.map(role => role.id);
  for (const id of roles) {
    const s = p.sessions?.[id];
    if (!s || (id === "designer" && s.designerRevision !== 2) || typeof s.projectId !== "string"
      || (!s.projectId && id !== "designer") || typeof s.runId !== "string" || !s.runId
      || !Number.isInteger(s.step) || s.step < 0 || s.step >= ONBOARDING_ROUTES[id].length) continue;
    fresh.sessions[id] = { ...s,
      ...(s.skippedSteps ? { skippedSteps: Array.isArray(s.skippedSteps) ? [...new Set(s.skippedSteps.filter(step => Number.isInteger(step) && step >= 0 && step < ONBOARDING_ROUTES[id].length))] : [] } : {}), stepStartedAt: Number.isFinite(s.stepStartedAt) ? s.stepStartedAt : Date.now(),
      ready: s.ready === true, baselineText: typeof s.baselineText === "string" ? s.baselineText : "",
      collectionId: typeof s.collectionId === "string" ? s.collectionId : null,
      profileId: typeof s.profileId === "string" ? s.profileId : null,
      analysisAssetId: typeof s.analysisAssetId === "string" ? s.analysisAssetId : null,
      annotationAssetId: typeof s.annotationAssetId === "string" ? s.annotationAssetId : null,
      tasks: Object.fromEntries(Object.entries(s.tasks ?? {}).filter(([, index]) => Number.isInteger(index) && index >= 0)) };
  }
  const designer = fresh.sessions.designer;
  if (designer && designer.designerEndingRevision !== 1) {
    // The discarded order put the completion modal before the canvas hint.
    // Resume unfinished endings at the hint; never reset the actual project.
    const endingCompleted = Array.isArray(p.completedRoles) && p.completedRoles.includes("designer") && designer.step === 10;
    fresh.sessions.designer = { ...designer, designerEndingRevision: 1,
      ...(endingCompleted ? { ready: !designer.skippedSteps?.includes(9) } : {}),
      ...(designer.step >= 9 && !endingCompleted ? { step: 9, ready: false, stepVisit: (designer.stepVisit ?? 0) + 1, stepStartedAt: Date.now(), tasks: {} } : {}),
      ...(designer.reviewUntil !== undefined && designer.reviewUntil >= 9 ? { reviewUntil: undefined } : {}),
      ...(designer.skippedSteps ? { skippedSteps: designer.skippedSteps.map(step => step === 9 ? 10 : step === 10 ? 9 : step) } : {}) };
  }
  // Append the new lessons after a previously completed six- or eight-step designer route.
  if (Array.isArray(p.completedRoles) && p.completedRoles.includes("designer") && [5, 7].includes(fresh.sessions.designer?.step ?? -1)) {
    fresh.sessions.designer = { ...fresh.sessions.designer!, step: fresh.sessions.designer!.step + 1, ready: false, stepStartedAt: Date.now(), tasks: {} };
  }
  fresh.completedRoles = roles.filter(id => Array.isArray(p.completedRoles) && p.completedRoles.includes(id) && (fresh.sessions[id]?.ready || fresh.sessions[id]?.skippedSteps?.includes(ONBOARDING_ROUTES[id].length - 1))
    && fresh.sessions[id]?.step === ONBOARDING_ROUTES[id].length - 1);
  fresh.role = roles.includes(p.role!) ? p.role! : null;
  fresh.status = fresh.completedRoles.length === roles.length ? "completed"
    : p.status === "completed" ? "paused" : ["active", "paused", "skipped"].includes(p.status!) ? p.status === "active" ? "paused" : p.status! : "new";
  return fresh;
}
export function advanceRoleGuide(guide: RoleGuideProgress, baselineText: string, now = Date.now(), skip = false): RoleGuideProgress {
  const role = guide.role;
  const original = role && guide.sessions[role];
  if (!role || !original || (!original.ready && !skip && !(original.reviewUntil !== undefined && original.step < original.reviewUntil)) || guide.status !== "active") return guide;
  const session = skip ? { ...original, skippedSteps: [...new Set([...(original.skippedSteps ?? []), original.step])] } : original;
  if (session.step < ONBOARDING_ROUTES[role].length - 1) return { ...guide,
    sessions: { ...guide.sessions, [role]: { ...session, step: session.step + 1, ready: false, baselineText, stepStartedAt: now, tasks: {}, stepVisit: (session.stepVisit ?? 0) + 1,
      ...(session.reviewUntil !== undefined ? { reviewUntil: session.step + 1 < session.reviewUntil ? session.reviewUntil : undefined } : {}) } } };
  const completedRoles = Array.from(new Set([...guide.completedRoles, role]));
  return { ...guide, sessions: { ...guide.sessions, [role]: session }, completedRoles, status: completedRoles.length === ONBOARDING_ROLES.length ? "completed" : "paused" };
}
/** Revisit without rerunning an operation or immediately auto-advancing again. */
export function previousRoleGuide(guide: RoleGuideProgress, now = Date.now()): RoleGuideProgress {
  const role = guide.role, session = role && guide.sessions[role];
  if (!role || !session || !session.step || guide.status !== "active") return guide;
  return { ...guide, sessions: { ...guide.sessions, [role]: { ...session, step: session.step - 1,
    ready: false, stepStartedAt: now, tasks: {}, stepVisit: (session.stepVisit ?? 0) + 1,
    reviewUntil: Math.max(session.reviewUntil ?? 0, session.step) } } };
}
export interface PracticeEvidence { onProject: boolean; text: string; hasDimensionOnly: boolean; imageCount: number; videoCount: number }
export function practiceReady(scene: GuideScene, session: RoleSession, evidence: PracticeEvidence): boolean {
  if (scene === "ready-to-create") return true;
  if (!evidence.onProject) return false;
  switch (scene) {
    case "workspace": case "source-scope": case "more-uses": return true;
    case "script": return evidence.text !== session.baselineText && evidence.text.trim().length >= 20 && evidence.text.trim().split(/\n+/).filter(Boolean).length >= 2;
    case "dimensions": return evidence.hasDimensionOnly;
    case "edit": case "storyboard": return evidence.imageCount >= 1;
    case "batch": return evidence.imageCount >= 2;
    case "video": return evidence.videoCount >= 1;
    default: return false;
  }
}
