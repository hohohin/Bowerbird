import { create } from "zustand";
import { ONBOARDING_KEY, parseOnboarding, type OnboardingProgress } from "./onboarding";

function read() {
  try { return parseOnboarding(localStorage.getItem(ONBOARDING_KEY)); }
  catch { return parseOnboarding(null); }
}
export const useOnboarding = create<{
  progress: OnboardingProgress;
  panel: "welcome" | "lesson" | "update" | "done" | "closed" | "collections";
  patch: (patch: Partial<OnboardingProgress>) => void;
  open: () => void;
  show: (panel: "welcome" | "lesson" | "update" | "done" | "closed" | "collections") => void;
}>((set, get) => ({
  progress: read(), panel: "closed",
  patch: (patch) => {
    const progress = { ...get().progress, ...patch };
    try { localStorage.setItem(ONBOARDING_KEY, JSON.stringify(progress)); } catch { /* in-memory session remains usable */ }
    set({ progress });
  },
  open: () => set({ panel: "welcome" }),
  show: (panel) => set({ panel }),
}));

export const LEARNING_TOPICS = [
  { id: "explore", title: "探索：把灵感拖到画板", body: "Windows 支持从左侧网页拖图到右侧画板，松手的位置就是卡片落点。素材栏会自动收起，点击窄栏可重新展开。网站可能需要你先登录；也可以导入本地图片。" },
  { id: "dimensions", title: "反推：借用图片的某个特征", body: "素材库里长按图片，或在画板创作模式下点击图片，可查看已有维度；选择维度即可加入创作输入。没有维度时，可在右键菜单中反推；开始前查看所选模型和用量。" },
  { id: "visual-profile", title: "视觉规范：让一组作品保持一致", body: "在集合中开始提炼，查看分析用量与总结费用。保存规范后，在创作输入中主动选择；已保存的规范可以跨项目使用。" },
  { id: "classification", title: "本地分类：先用少量图片试试", body: "首次使用需下载约 756 MB 的模型包，分类在本机运行。先选少量素材检查标签，再决定是否开启自动处理。分类标签与反推维度分别管理。" },
  { id: "arrange", title: "画板整理：把相关素材放在一起", body: "空白拖动可框选，拖动选中卡片可整体移动。素材叠在另一张上停留 1 秒可建组；右键菜单可整理布局。画板素材组不会改变素材库文件夹。" },
] as const;
