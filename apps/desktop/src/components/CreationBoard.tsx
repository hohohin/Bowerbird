import { beginOnboardingOperation } from "../lib/onboardingStore";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { DEFAULT_VIDEO_OPTIONS, VIDEO_RATIOS, videoInputError, videoProvider, type GenerationSettings } from "../lib/videoGeneration";
import { VideoControls } from "./creation/VideoControls";
import { useStore } from "../store";
import { canStartAnotherAgentRun, canStartAnotherJob, canUseAgentRun, canUseByo } from "../lib/entitlement";
import { cloudProviderLabel, isCloudProvider, supportsAnnotationCoordinates } from "../lib/genProviders";
import { api } from "../lib/api";
import {
  acquireCreativeSubmission,
  resolveContinuationParent,
  type CreativeParentCandidate,
  type CreativeParentSelection,
  type CreativeThreadResolution,
} from "../lib/creativeGeneration";
import { AGENT_DS_ENABLED, AGENT_Z_ENABLED, PRESET_FEATURE_ENABLED } from "../lib/featureFlags";
import { notify, notifyError, notifySuccess } from "../lib/notify";
import { isWorkspaceOperationCurrent } from "../lib/workspaceRoute";
import { captureGenerationSubmissionAuthority } from "../lib/generationIntent";
import { DSH_AGENT_RUNTIME, UNIFIED_AGENT_SKILL } from "../lib/cloudAgentSelection";
import type { Asset } from "../lib/types";
import {
  BOARD_ASSET_PICK_EVENT,
  BOARD_PROMPT_LOADED_EVENT,
  useCreationEditor,
  type CreationEditorDraft,
} from "./creation/useCreationEditor";
import type { CreativePromptLoadRequest } from "../lib/creativeLaunch";
import { RATIOS } from "./creation/ratios";
import { RatioSelect } from "./creation/RatioSelect";
import { ImageGenOptions } from "./creation/ImageGenOptions";
import { ProviderSelect } from "./creation/ProviderSelect";
import { VisualProfileSelect } from "./creation/VisualProfileSelect";
import { BoardChipPreview } from "./creation/BoardChipPreview";
import { ChevronDown, Info, Sparkles } from "lucide-react";

// 画面比例偏好记忆（照 AssetDetail 的 localStorage 范式：bowerbird.<name> 前缀、try/catch 兜底）。
const BOARD_RATIO_KEY = "bowerbird.boardRatio";
function loadBoardRatio(): string | null {
  try {
    const v = localStorage.getItem(BOARD_RATIO_KEY);
    return v && RATIOS.some((r) => r.key === v) ? v : null;
  } catch {
    return null;
  }
}
function saveBoardRatio(v: string | null) {
  try {
    if (v) localStorage.setItem(BOARD_RATIO_KEY, v);
    else localStorage.removeItem(BOARD_RATIO_KEY);
  } catch {
    // ignore storage errors
  }
}

// Agent DS 一轮对话结束（done/error）的窗口事件：App 监听后端 agent-z://output 分流派发，
// CreationBoard 在此解除 agentDsBusy（一轮可长达数分钟，发送 invoke 本身立即返回）。
export const AGENT_DS_DONE_EVENT = "bowerbird://agent-ds-done";

/**
 * 创作板 UI 外壳（jimeng 网页端式底部浮动对话框，常驻显示）：宽而矮的黑色半透明
 * 毛玻璃卡片，浮在瀑布流下方居中、底边贴应用底边；工具栏在对话框内底部一行。编辑器
 * 内核（ProseMirror doc / 光标 / 序列化）下沉到 useCreationEditor + creation/* 模块，
 * 本组件只管「组稿周边」：用途（preset）CRUD / 复制 / 发送 / 预览。
 *
 * 两态：常驻未激活（普通浏览：点图开详情、筛选生效）⇄ 创作模式激活（store.boardOpen，
 * 等同旧「创作板」按钮：点图插参考图、瀑布流蓝线框 + 顶部「创作模式」刘海）。编辑框
 * 获得焦点（onFocus，ProseMirror contenteditable 冒泡）即激活；对话框右上角突出的
 * 档案标签页签（⌄ 退出创作模式，V 形下箭头示意「收起/退出」）退出。会话「重新编辑」坞期间本组件整体让位
 * （App 按 !genEditing 挂载）。
 *
 * 非创作模式未聚焦时向下收起 70%，点击露出区域或键盘聚焦后展开；创作模式保持展开。
 * 在工具栏与内部菜单间操作保持展开，草稿与创作模式不因失焦被清空。
 *
 * 参考图入口：创作模式激活时点瀑布流任意图即在光标处插 image chip；也可手输 @图名，
 * 空格/标点后自动识别为 image chip。维度环（CaptionRing）为全局组件（长按图片呼出），
 * 点环上扇区经 store.pendingKeyword 由本板编辑器消费插入 keyword chip。
 */
export interface CreationBoardProps {
  embedded?: boolean;
  projectId?: string;
  initialDraft?: CreationEditorDraft | null;
  initialAssetIds?: string[];
  continuationCandidates?: CreativeParentCandidate[];
  focusedContinuationNodeId?: string | null;
  focusedContinuationThreadId?: string | null;
  promptLoadRequest?: CreativePromptLoadRequest | null;
  onPromptLoadConsumed?: (requestId: string) => void;
  onDraftChange?: (draft: CreationEditorDraft) => void;
  registerDraftFlush?: (flush: (() => void) | null) => void;
  beforeGenerate?: () => Promise<void>;
  resolveCreativeThread?: (
    parentAssetId: string | null,
    prompt: string,
    routeRevision?: number,
    continuationRequestId?: string | null,
    parentNodeId?: string | null,
  ) => Promise<CreativeThreadResolution>;
}

export function CreationBoard({
  embedded = false,
  projectId,
  initialDraft,
  initialAssetIds = [],
  continuationCandidates = [],
  focusedContinuationNodeId = null,
  focusedContinuationThreadId = null,
  promptLoadRequest = null,
  onPromptLoadConsumed,
  onDraftChange,
  registerDraftFlush,
  beforeGenerate,
  resolveCreativeThread,
}: CreationBoardProps = {}) {
  const [submitting, setSubmitting] = useState(false);
  const codexHealth = useStore((s) => s.codexHealth);
  const creating = useStore((s) => s.boardOpen);
  const setBoardActive = useStore((s) => s.setBoardActive);
  const dreaminaHealth = useStore((s) => s.dreaminaHealth);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudAvailable = cloudAuth?.cloud_available ?? false;
  const isTestAccount = cloudEntitlement?.is_test_account === true;
  const runningJobCount = useStore((s) => Object.values(s.genJobs).filter((j) => j.running).length);
  // 会话卡片生成成功 → 自动退出创作模式的观察目标（普通生成路径提交时登记，
  // 见 send()；成功/失败结算时清除，详见下方 useEffect）。按值选择器只暴露
  // 结算结果，避免生成期间流式 delta 触发对话框整树重渲染。
  const [successExitJobId, setSuccessExitJobId] = useState<string | null>(null);
  const successExitOutcome = useStore((s): "idle" | "pending" | "succeeded" | "failed" => {
    if (!successExitJobId) return "idle";
    const job = s.genJobs[successExitJobId];
    if (!job || job.running) return "pending";
    const last = job.turns[job.turns.length - 1];
    return last && last.images.length > 0 ? "succeeded" : "failed";
  });
  const selectedImageProvider = useStore((s) => s.activeGenProvider);
  const [generation, setGeneration] = useState<GenerationSettings>(() => initialDraft?.generation ?? { media: "image" });
  const isVideo = generation.media === "video";
  const videoOptions = generation.videoOptions ?? DEFAULT_VIDEO_OPTIONS;
  const activeGenProvider = isVideo ? videoProvider(generation.videoChannel, videoOptions) : selectedImageProvider;
  const draftRef = useRef<CreationEditorDraft | null>(initialDraft ?? null);
  const generationRef = useRef(generation);
  generationRef.current = generation;
  const persistGenerationDraft = (draft: CreationEditorDraft) => {
    draftRef.current = draft;
    onDraftChange?.({ ...draft, generation: generationRef.current });
  };
  useEffect(() => {
    if (draftRef.current) onDraftChange?.({ ...draftRef.current, generation });
  }, [generation]);
  const setActiveGenProvider = useStore((s) => s.setActiveGenProvider);
  const defaultProvider = useStore((s) => s.defaultProvider);
  const setDefaultProvider = useStore((s) => s.setDefaultProvider);
  const startGeneration = useStore((s) => s.startGeneration);
  const presets = useStore((s) => s.presets);
  const activePresetId = useStore((s) => s.activePresetId);
  const setActivePreset = useStore((s) => s.setActivePreset);
  const reloadPresets = useStore((s) => s.reloadPresets);
  const updateCloudAgentRun = useStore((s) => s.updateCloudAgentRun);
  const cloudAgentRuns = useStore((s) => s.cloudAgentRuns);
  const pendingComposerMode = useStore((s) => s.pendingComposerMode);
  const clearPendingComposerMode = useStore((s) => s.clearPendingComposerMode);
  const ackPendingCreativeContinuation = useStore((s) => s.ackPendingCreativeContinuation);
  const settings = useStore((s) => s.settings);
  const activeVisualProfileId = useStore((s) => s.activeVisualProfileId);
  const setActiveVisualProfile = useStore((s) => s.setActiveVisualProfile);

  // consumePendingKeyword：本板是维度环点选（pendingKeyword）的唯一消费方（编辑坞不抢）。
  // initialEmpty：空文档开局（配 is-empty 占位「描述你的意图，开始创作吧」；有草稿仍恢复），
  // 取代旧「请参考」预填——提示职责交给占位文字。
  const {
    hostRef,
    focus,
    flushDraft,
    loadPrompt,
    finalPrompt,
    rawPrompt,
    references,
    referenceNodeIds,
    dimensionSources,
    graphSources,
    agentPromptReferences,
  } = useCreationEditor({
    consumePendingKeyword: true,
    initialEmpty: true,
    draftKey: embedded ? null : undefined,
    initialDraft,
    onDraftChange: persistGenerationDraft,
  });

  useEffect(() => {
    registerDraftFlush?.(flushDraft);
    return () => registerDraftFlush?.(null);
  }, [flushDraft, registerDraftFlush]);

  const initialAssetsAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!embedded || !projectId || initialAssetsAppliedRef.current === projectId) return;
    initialAssetsAppliedRef.current = projectId;
    if (initialAssetIds.length === 0) return;
    const timer = window.setTimeout(() => {
      for (const assetId of initialAssetIds) {
        // 新建项目的参考图预填不代表用户已点击对话框。
        window.dispatchEvent(new CustomEvent(BOARD_ASSET_PICK_EVENT, { detail: { assetId, focus: false } }));
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [projectId, embedded, initialAssetIds]);

  const appliedPromptLoadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!embedded || !promptLoadRequest || appliedPromptLoadRef.current === promptLoadRequest.id) return;
    // 避开开发态 StrictMode 的首次挂载重放：首次 timer 会在 cleanup 中取消，稳定实例
    // 才真正覆盖草稿并确认请求，避免同一 prompt 被两个临时编辑器重复消费。
    const timer = window.setTimeout(() => {
      if (!loadPrompt(promptLoadRequest)) return;
      setGeneration(promptLoadRequest.generation ?? { media: "image" });
      if (promptLoadRequest.generation?.ratio !== undefined) setRatio(promptLoadRequest.generation.ratio ?? null);
      appliedPromptLoadRef.current = promptLoadRequest.id;
      setBoardActive(true);
      window.dispatchEvent(new CustomEvent(BOARD_PROMPT_LOADED_EVENT, {
        detail: { requestId: promptLoadRequest.id },
      }));
      notifySuccess("生成提示词已载入创作框");
      onPromptLoadConsumed?.(promptLoadRequest.id);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [embedded, loadPrompt, onPromptLoadConsumed, promptLoadRequest, setBoardActive]);

  // 画面比例（null=自动/不指定，发送时不注入 instruction）。记忆进 localStorage，跨会话保留。
  const [ratio, setRatio] = useState<string | null>(() => initialDraft?.generation?.ratio ?? loadBoardRatio());
  const selectRatio = (v: string | null) => {
    setRatio(v);
    setGeneration((current) => ({ ...current, ratio: v }));
    saveBoardRatio(v);
  };
  // 生成选项（仅即梦 / Cloud 生图引擎）：张数（1–4）与透明图层（background:
  // transparent）都不再常驻工具条，统一收进「生成选项」弹层（ImageGenOptions）；
  // codex 沿用提示词驱动张数、不支持透明参数。
  const [genCount, setGenCount] = useState<number>(() => initialDraft?.generation?.count ?? 1);
  const [transparentLayer, setTransparentLayer] = useState<boolean>(() => initialDraft?.generation?.transparent ?? false);
  const selectGenCount = (v: number) => {
    setGenCount(v);
    setGeneration((current) => ({ ...current, count: v }));
  };
  const selectTransparentLayer = (v: boolean) => {
    setTransparentLayer(v);
    setGeneration((current) => ({ ...current, transparent: v }));
  };
  // 创作板「用途」（preset）登记：只需用途名，body 取当前编辑框内容
  const [creatingPreset, setCreatingPreset] = useState(false);
  const [newName, setNewName] = useState("");
  // 用途编辑/删除（inline）
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editBody, setEditBody] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Agent 方案开关：off = 直发；a = 方案A（子句挑选）；b = 方案B（skill 审查修复）。两者互斥。
  const [agentMode, setAgentMode] = useState<"off" | "a" | "b">("off");
  const [agentAvailable, setAgentAvailable] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  // 正式 Agent 只有一个开关；新 Run 固定使用统一 DSH，历史 runtime 由各 Run 快照保留。
  // 失去权限时保留用户的 Agent 意图并禁用发送，避免静默改走普通生成。
  const [cloudAgentMode, setCloudAgentMode] = useState(false);
  const [cloudAgentBusy, setCloudAgentBusy] = useState(false);
  // Agent Z（dev-only）：创作板消息投递到 Claude Code TUI 终端，Bowerbird 侧不走生图链路；与 A/B 互斥。
  const [agentZMode, setAgentZMode] = useState(false);
  const [agentZAvailable, setAgentZAvailable] = useState(false);
  const [agentZBusy, setAgentZBusy] = useState(false);
  // Agent G（dev-only）：同机制投递到 codex TUI 终端（独立窗口会话）；与 A/B/Z/DS 互斥。
  // busy 与 Z 共用（同一后端命令通路）。可用性 = Z 通道探活（release 构建后端拒绝 → 不渲染，
  // 约定 30/36 同款门控）+ codexHealth（codex CLI 安装 + 登录态）。
  const [agentGMode, setAgentGMode] = useState(false);
  // Agent DS（dev-only）：把编辑器内容 + 参考图投递到本机 DSH 队列（.agent-z/ds-inbox/pending/），
  // 由用户自己那条 DSH 会话接住（借用其全量工具与既有上下文）；回传不回流创作板，故投递成功即
  // 立即解除 busy。与 A/B/Z/G 互斥；可用性仍沿用 A/B 同源的 agent-worker 探活。
  const agentDsAvailable = agentAvailable && AGENT_DS_ENABLED;
  const [agentDsMode, setAgentDsMode] = useState(false);
  const [agentDsBusy, setAgentDsBusy] = useState(false);
  // 设置「开发者选项」的对话框模式开关（settings 未加载 = 默认：仅正式 Agent 开）。
  // 关闭的模式按钮不渲染；可用性健康检查（agentAvailable / agentZAvailable / codexHealth）照常叠加。
  const agentModeOn = !isVideo && (settings?.agent_mode_enabled ?? true);
  const agentAOn = !isVideo && (settings?.agent_a_mode_enabled ?? false);
  const agentBOn = !isVideo && (settings?.agent_b_mode_enabled ?? false);
  const agentZOn = !isVideo && (settings?.agent_z_mode_enabled ?? false);
  const agentGOn = !isVideo && (settings?.agent_g_mode_enabled ?? false);
  const agentDsOn = !isVideo && (settings?.agent_ds_mode_enabled ?? false);
  // 生成选项（张数 + 透明图层）只在即梦 / Cloud 生图（且非 Agent 模式）下显示。
  const countSupported = !isVideo && !cloudAgentMode
    && (activeGenProvider === "jimeng" || isCloudProvider(activeGenProvider));
  const activePreset = useMemo(
    () => presets.find((p) => p.id === activePresetId) ?? null,
    [presets, activePresetId]
  );

  useEffect(() => {
    api.localAgentHealth().then(setAgentAvailable).catch(() => setAgentAvailable(false));
    if (AGENT_Z_ENABLED) {
      api.agentZHealth().then((status) => setAgentZAvailable(status.ok)).catch(() => setAgentZAvailable(false));
    }
  }, []);

  // Agent DS 一轮结束（harness 落 done/error 状态事件 → App 派发）即解除 busy
  useEffect(() => {
    const onDone = () => setAgentDsBusy(false);
    window.addEventListener(AGENT_DS_DONE_EVENT, onDone);
    return () => window.removeEventListener(AGENT_DS_DONE_EVENT, onDone);
  }, []);

  // 执行结果回到创作器时显式恢复 Agent / 普通生成模式；消费即清，防止重挂载误触发。
  useEffect(() => {
    if (!pendingComposerMode) return;
    setCloudAgentMode(pendingComposerMode === "agent");
    setAgentMode("off");
    setAgentZMode(false);
    setAgentGMode(false);
    setAgentDsMode(false);
    clearPendingComposerMode();
  }, [pendingComposerMode, clearPendingComposerMode]);

  // 设置里关闭的模式：隐藏按钮同时复位其激活态（含「开启 Agent 模式再试」等异步置位路径）。
  useEffect(() => {
    if (!agentModeOn && cloudAgentMode) {
      setCloudAgentMode(false);
    }
    if (!agentAOn && agentMode === "a") setAgentMode("off");
    if (!agentBOn && agentMode === "b") setAgentMode("off");
    if (!agentZOn && agentZMode) setAgentZMode(false);
    if (!agentGOn && agentGMode) setAgentGMode(false);
    if (!agentDsOn && agentDsMode) setAgentDsMode(false);
  }, [
    agentModeOn, agentAOn, agentBOn, agentZOn, agentGOn, agentDsOn,
    cloudAgentMode, agentMode, agentZMode, agentGMode, agentDsMode,
  ]);

  // 记录焦点收起状态；创作模式优先保持展开，退出后恢复收起。
  const dockRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !dockRef.current?.contains(event.target)) setCollapsed(true);
    }
    const onWindowBlur = () => setCollapsed(true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);
  function exitCreationMode() {
    setBoardActive(false);
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && dockRef.current?.contains(focused)) focused.blur();
    setCollapsed(true);
  }

  const exitCreationModeRef = useRef(exitCreationMode);
  exitCreationModeRef.current = exitCreationMode;

  // 会话卡片生成成功 → 自动退出创作模式：普通生成（生成图像/生成视频按钮）提交后
  // 创作模式保持激活（生成期间可继续挑图组下一轮稿），job 结算时成功（末轮有产出
  // 图）才退出，回普通浏览；失败/被拒则保持创作模式继续组稿或重试。只跟踪最近一次
  // 提交的 job：更早的 job 成功时用户多半已在组新稿，不再打断。
  useEffect(() => {
    if (successExitOutcome !== "succeeded" && successExitOutcome !== "failed") return;
    setSuccessExitJobId(null);
    if (successExitOutcome === "succeeded" && useStore.getState().boardOpen) {
      exitCreationModeRef.current();
    }
  }, [successExitOutcome]);

  useEffect(() => {
    let composing = false;
    let escapeBlocked = false;
    const onCompositionStart = () => { composing = true; };
    const onCompositionEnd = () => { composing = false; };
    function captureEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // 在弹层处理按键前记录状态，防止同一次 Esc 关闭弹层后继续退出创作。
      const state = useStore.getState();
      escapeBlocked = composing || event.isComposing || event.keyCode === 229
        || !!state.captionRing || !!state.contextMenu
        || !!document.querySelector(
          '[role="dialog"][aria-modal="true"], [role="menu"], [role="listbox"], [aria-haspopup][aria-expanded="true"]',
        );
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.repeat || event.defaultPrevented
        || escapeBlocked || !useStore.getState().boardOpen) return;
      event.preventDefault();
      // 与点击退出页签一致地离开编辑焦点，之后再次点击编辑框可重新激活。
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && hostRef.current?.contains(focused)) focused.blur();
      exitCreationModeRef.current();
    }
    window.addEventListener("compositionstart", onCompositionStart, true);
    window.addEventListener("compositionend", onCompositionEnd, true);
    window.addEventListener("keydown", captureEscape, true);
    // ProseMirror 会消费 Escape 来选择父节点；创作框中用退出创作替代该默认动作。
    const editorHost = hostRef.current;
    editorHost?.addEventListener("keydown", onEscape, true);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("compositionstart", onCompositionStart, true);
      window.removeEventListener("compositionend", onCompositionEnd, true);
      window.removeEventListener("keydown", captureEscape, true);
      editorHost?.removeEventListener("keydown", onEscape, true);
      window.removeEventListener("keydown", onEscape);
    };
  }, [hostRef]);

  // 对话框高度 → --board-dock-h：瀑布流滚动容器据此留底部 padding，最后一行素材
  // 不被对话框盖住（与会话编辑坞 --gen-dock-h 同款；收起是纯 transform，高度不变）。
  useEffect(() => {
    if (embedded) return;
    const el = dockRef.current;
    if (!el) return;
    const apply = () =>
      document.documentElement.style.setProperty("--board-dock-h", `${el.offsetHeight}px`);
    apply();
    const obs = new ResizeObserver(apply);
    obs.observe(el);
    return () => {
      obs.disconnect();
      document.documentElement.style.removeProperty("--board-dock-h");
    };
  }, [embedded]);

  // 按当前选中的 provider 判健康（云端需开关+登录+余额，其余读各自 health）。
  const cloudBalance = cloudEntitlement
    ? cloudEntitlement.balances.daily + cloudEntitlement.balances.sub + cloudEntitlement.balances.topup
    : 0;
  const targetHealth = activeGenProvider === "jimeng" ? dreaminaHealth : codexHealth;
  const targetCliLabel = activeGenProvider === "jimeng" ? "即梦 CLI" : "Codex CLI";
  const targetUnavailableReason = isCloudProvider(activeGenProvider)
    ? !cloudAvailable
      ? "当前版本未配置 Bowerbird Cloud，请在设置中选择可用引擎。"
      : !cloudAuth?.logged_in
        ? "尚未登录 Bowerbird 账号，请通过左侧账号入口登录。"
        : cloudBalance <= 0
          ? "Bowerbird 积分不足，请补充积分后重试。"
          : null
    : !canUseByo(cloudEntitlement)
      ? !cloudAuth?.logged_in
        ? "请先登录具有自备引擎权限的 Bowerbird 账号。"
        : "当前账号未开放自备引擎权限，请升级 Pro 后使用。"
      : !targetHealth?.ok
        ? `${targetCliLabel} 未就绪：${targetHealth?.reason?.trim() || "尚未取得可用的检测结果"}。请前往「设置 → 模型设置」检查安装和登录状态，并重新检测。`
        : null;
  const targetReady = targetUnavailableReason === null;
  // 统一 Agent 使用云端工具；普通生成的引擎选择不改变 Agent 路线。
  const activeCloudAgentRunCount = Object.values(cloudAgentRuns).filter((run) =>
    !["succeeded", "failed", "cancelled"].includes(run.status)
  ).length;
  const cloudAgentEntitled = isTestAccount && cloudEntitlement?.user_id === cloudAuth?.user_id &&
    canUseAgentRun(cloudEntitlement, UNIFIED_AGENT_SKILL);
  const cloudAgentHasCapacity = canStartAnotherAgentRun(cloudEntitlement, activeCloudAgentRunCount, UNIFIED_AGENT_SKILL);
  const cloudAgentRequiredBalance = 30;
  const projectAgentContextReady = !!projectId && !!resolveCreativeThread;
  const cloudAgentReady =
    projectAgentContextReady &&
    cloudAgentEntitled &&
    cloudAgentHasCapacity &&
    cloudAvailable &&
    !!cloudAuth?.logged_in &&
    cloudBalance >= cloudAgentRequiredBalance;
  const targetProviderLabel = isCloudProvider(activeGenProvider)
    ? (cloudProviderLabel(activeGenProvider, cloudEntitlement) ?? "Bowerbird Cloud")
    : activeGenProvider === "jimeng"
      ? "即梦"
      : "codex";
  const sendTooltipId = useId();
  const sendDisabledReason = submitting
    ? "正在提交指令，任务启动后即可继续生成。"
    : agentZBusy
      ? "正在投递到 Agent 终端，请等待投递完成。"
      : agentDsBusy
        ? "正在投递到 DSH 队列，请等待投递完成。"
        : cloudAgentBusy
          ? "正在创建 Agent 会话，请稍候。"
          : cloudAgentMode
            ? !projectAgentContextReady
              ? "Bowerbird Agent 需要在项目画板中启动，请先打开一个项目。"
              : !cloudAvailable
                ? "当前版本未配置 Bowerbird Cloud，暂时无法使用 Agent。"
                : !cloudAuth?.logged_in
                  ? "请通过左侧账号入口登录 Bowerbird 账号后使用 Agent。"
                  : !cloudAgentEntitled
                    ? "当前账号暂未开放 Agent，仅已获授权的测试账号可用。"
                    : !cloudAgentHasCapacity
                      ? "Agent 并发任务已达上限，请等待已有任务完成或取消任务。"
                      : cloudBalance < cloudAgentRequiredBalance
                        ? "积分不足：Agent 需要预授权 30 积分，请补充积分后重试。"
                        : !(rawPrompt || finalPrompt).trim() ? "请先输入创作要求。" : null
            : agentZMode || agentGMode || agentDsMode
              ? !(rawPrompt || finalPrompt).trim() ? "请先输入创作要求。" : null
              : agentBusy
                ? "Agent 正在整理意图，请等待处理完成。"
                : targetUnavailableReason
                  ?? (!canStartAnotherJob(cloudEntitlement, runningJobCount)
                    ? "已达当前档位的并行生成上限，请等待已有任务完成或取消任务。"
                    : !finalPrompt ? "请先输入创作要求或添加参考内容。" : null);
  const hasAnnotationDimension = graphSources.some((source) =>
    source.dimensions.some((title) => title === "标注" || title === "标记")
  );
  const annotationWarning =
    !cloudAgentMode && !agentZMode && !agentGMode && !agentDsMode && hasAnnotationDimension && !supportsAnnotationCoordinates(activeGenProvider);

  // 把当前组稿发 provider 生成。生成期间编辑器仍可继续组下一轮稿（prompt 在此快照进 store）。
  // provider / visual profile 与 prompt、refs 一样在点击时冻结；异步 Agent
  // 整理或画板准备期间的 UI 切换只影响下一次发送。
  // 普通生成（生成图像/生成视频）提交后创作模式保持激活，会话卡片生成成功时自动退出
  // （同「退出创作模式」页签：回普通浏览，左键恢复开详情）；校验不过/提交失败/生成失败
  // 则保持创作模式继续组稿或重试。终端型 / Cloud Agent 路径完成即退出（无生成会话卡片）。
  async function send() {
    const originRoute = useStore.getState();
    const originProjectId = projectId ?? originRoute.activeProjectId;
    const originRouteRevision = originRoute.projectRouteRevision;
    const submissionClaim = acquireCreativeSubmission(originProjectId);
    if (!submissionClaim) {
      notify("上一条指令正在提交，请稍候再试", "info");
      return;
    }
    setSubmitting(true);
    try {
    const submissionAuthority = captureGenerationSubmissionAuthority({
      provider: isVideo ? activeGenProvider : originRoute.activeGenProvider,
      visualProfileId: originRoute.activeVisualProfileId,
    });
    const originContinuation = originRoute.pendingCreativeContinuation?.projectId === originProjectId
      ? { ...originRoute.pendingCreativeContinuation }
      : null;
    const isCurrentWorkspace = () => {
      const state = useStore.getState();
      return isWorkspaceOperationCurrent(
        originProjectId,
        state.activeProjectId,
        state.projectRoutePending,
        originRouteRevision,
        state.projectRouteRevision,
      );
    };
    const isCurrentSubmission = () => submissionClaim.isCurrent() && isCurrentWorkspace();
    if (!isCurrentSubmission()) return;
    if (isVideo) {
      const error = videoInputError(videoOptions, references, ratio, activeGenProvider);
      if (error) { notifyError(error, "视频参数无效"); return; }
    }

    if (cloudAgentMode) {
      const body = (rawPrompt || finalPrompt).trim();
      if (!body || cloudAgentBusy || !cloudAgentReady) return;
      setCloudAgentBusy(true);
      try {
        await beforeGenerate?.();
        if (!isCurrentSubmission()) return;
        const parentSelection = resolveContinuationParent(
          references,
          continuationCandidates,
          {
            sidecar: originContinuation,
            focusedNodeId: focusedContinuationNodeId,
            focusedThreadId: focusedContinuationThreadId,
          },
        );
        const parentAsset = parentSelection?.asset ?? null;
        const continuation = await resolveCreativeThread?.(
          parentAsset?.id ?? null,
          body,
          originRouteRevision,
          originContinuation?.requestId ?? null,
          parentSelection?.nodeId ?? null,
        ) ?? null;
        if (!isCurrentSubmission()) return;
        const currentAccount = useStore.getState();
        if (currentAccount.cloudAuth?.user_id !== originRoute.cloudAuth?.user_id ||
          !currentAccount.cloudAuth?.logged_in ||
          !currentAccount.cloudEntitlement?.is_test_account ||
          currentAccount.cloudEntitlement.user_id !== currentAccount.cloudAuth.user_id ||
          !canUseAgentRun(currentAccount.cloudEntitlement, UNIFIED_AGENT_SKILL)) {
          notify("账号或 Agent 权限已变化，请确认当前账号后重新发送", "info");
          return;
        }
        const threadId = continuation?.threadId ?? null;
        const run = await api.cloudAgentStart({
          intentPrompt: body,
          references: references.map((reference, index) => ({
            assetId: reference.id,
            nodeId: referenceNodeIds[index] ?? null,
            promptToken: agentPromptReferences.find((item) => item.assetId === reference.id)?.name ?? reference.name,
          })),
          ratio,
          projectId: originProjectId,
          threadId,
          parentNodeId: continuation?.parentNodeId ?? null,
          parentAssetId: parentAsset?.id ?? null,
          imageProvider: "cloud",
          visualProfileId: submissionAuthority.visualProfileId,
          skillId: UNIFIED_AGENT_SKILL,
          agentRuntime: DSH_AGENT_RUNTIME,
          htmlOptions: {
            viewportWidth: 900,
            viewportHeight: 700,
            deviceScaleFactor: 1,
            captureMode: "full_page_and_slices",
            sliceHeight: 900,
            overlap: 0,
            background: "opaque",
          },
        });
        if (continuation?.continuationRequestId) {
          ackPendingCreativeContinuation(continuation.continuationRequestId);
        }
        if (!isCurrentSubmission()) {
          updateCloudAgentRun(run);
          return;
        }
        updateCloudAgentRun(run);
        notifySuccess("Agent 会话已创建，将根据目标选择所需工具");
        exitCreationMode();
      } catch (error) {
        if (isCurrentSubmission()) notifyError(error, "启动 Bowerbird Agent 失败");
      } finally {
        setCloudAgentBusy(false);
      }
      return;
    }
    // Agent Z：不走生图链路（无 job/ratio/provider，不受引擎可用性与并行配额限制），
    // 把编辑器原文 + 参考图路径投递到 Claude Code TUI 终端。
    if (agentZMode) {
      const body = (rawPrompt || finalPrompt).trim();
      if (!body || agentZBusy) return;
      setAgentZBusy(true);
      try {
        const refPairs = references
          .map((r) => ({ path: r.store_path, name: r.name }))
          .filter((p): p is { path: string; name: string } => !!p.path);
        await api.agentZSend(
          body,
          refPairs.map((p) => p.path),
          refPairs.map((p) => p.name),
          "z",
          submissionAuthority.visualProfileId,
        );
        if (!isCurrentSubmission()) return;
        notifySuccess("已发送到 Agent Z 终端");
        exitCreationMode();
      } catch (error) {
        if (isCurrentSubmission()) notifyError(error, "发送到 Agent Z 失败");
      } finally {
        setAgentZBusy(false);
      }
      return;
    }
    // Agent G：同 Z 的投递机制，终端会话为 codex TUI（engine 参数区分，独立窗口）。
    if (agentGMode) {
      const body = (rawPrompt || finalPrompt).trim();
      if (!body || agentZBusy) return;
      setAgentZBusy(true);
      try {
        const refPairs = references
          .map((r) => ({ path: r.store_path, name: r.name }))
          .filter((p): p is { path: string; name: string } => !!p.path);
        await api.agentZSend(
          body,
          refPairs.map((p) => p.path),
          refPairs.map((p) => p.name),
          "g",
          submissionAuthority.visualProfileId,
        );
        if (!isCurrentSubmission()) return;
        notifySuccess("已发送到 Agent G 终端");
        exitCreationMode();
      } catch (error) {
        if (isCurrentSubmission()) notifyError(error, "发送到 Agent G 失败");
      } finally {
        setAgentZBusy(false);
      }
      return;
    }
    // Agent DS：DeepSeek harness 对话（不走生图链路）。invoke 只负责拉起 detached 子进程
    // 即返回；busy 保持到本轮 done/error 状态事件回来（工具轮里含即梦生图可长达数分钟）。
    if (agentDsMode) {
      const body = (rawPrompt || finalPrompt).trim();
      if (!body || agentDsBusy) return;
      setAgentDsBusy(true);
      try {
        const refPairs = references
          .map((reference) => ({
            path: reference.store_path,
            name: agentPromptReferences.find((item) => item.assetId === reference.id)?.name ?? reference.name,
          }))
          .filter((pair): pair is { path: string; name: string } => !!pair.path);
        const outcome = await api.agentDsChat(
          body,
          refPairs.map((pair) => pair.path),
          refPairs.map((pair) => pair.name),
          submissionAuthority.visualProfileId,
        );
        if (!isCurrentSubmission()) return;
        setAgentDsBusy(false);
        notifySuccess(
          outcome.autoDelivered
            ? `已送达 DSH 会话${outcome.sessionTitle ? `「${outcome.sessionTitle}」` : ""}`
            : `已投递到 DSH 队列（未自动送达：${outcome.notice ?? "未知原因"}）；可在 DSH 里说「看队列」`,
        );
        exitCreationMode();
      } catch (error) {
        if (isCurrentSubmission()) notifyError(error, "投递到 DSH 队列失败");
        setAgentDsBusy(false);
      }
      return;
    }
    if (!targetReady || !finalPrompt) return;
    if (!canStartAnotherJob(cloudEntitlement, runningJobCount)) return;
    let prompt = finalPrompt;
    if (agentMode !== "off") {
      setAgentBusy(true);
      try {
        const result = await api.localAgentCompilePrompt({
          originalPrompt: rawPrompt || finalPrompt,
          // 方案 B 需要模板展开后的完整 prompt（= 直发版），Agent 在其上做审查修复。
          ...(agentMode === "b" ? { expandedPrompt: finalPrompt } : {}),
          references: agentPromptReferences,
          output: { kind: "图片", ...(ratio ? { ratio } : {}) },
        });
        if (!isCurrentSubmission()) return;
        prompt = result.prompt;
      } catch (error) {
        if (isCurrentSubmission()) notifyError(error, "Agent 意图分析失败");
        return;
      } finally {
        setAgentBusy(false);
      }
    }
    try {
      await beforeGenerate?.();
    } catch (error) {
      if (isCurrentSubmission()) notifyError(error, "无法准备项目画板");
      return;
    }
    if (!isCurrentSubmission()) return;
    let parentSelection: CreativeParentSelection<Asset> | null;
    let continuation: CreativeThreadResolution | null;
    try {
      parentSelection = resolveContinuationParent(
        references,
        continuationCandidates,
        {
          sidecar: originContinuation,
          focusedNodeId: focusedContinuationNodeId,
          focusedThreadId: focusedContinuationThreadId,
        },
      );
      const parentAsset = parentSelection?.asset ?? null;
      continuation = await resolveCreativeThread?.(
        parentAsset?.id ?? null,
        rawPrompt || prompt,
        originRouteRevision,
        originContinuation?.requestId ?? null,
        parentSelection?.nodeId ?? null,
      ) ?? null;
    } catch (error) {
      if (isCurrentSubmission()) notifyError(error, "无法确定要继续的画板结果");
      return;
    }
    if (!isCurrentSubmission()) return;
    const parentAsset = parentSelection?.asset ?? null;
    const threadId = continuation?.threadId ?? null;
    const startedGeneration = await startGeneration(
      prompt,
      references,
      ratio,
      submissionAuthority.provider,
      rawPrompt,
      undefined,
      undefined,
      dimensionSources,
      submissionAuthority.visualProfileId,
      projectId && threadId ? {
        projectId,
        threadId,
        parentNodeId: continuation?.parentNodeId ?? null,
        parentAssetPath: parentAsset?.store_path ?? null,
        referenceNodeIds,
        relation: parentAsset ? "continued" : null,
      } : undefined,
      true,
      isVideo ? { media: "video", videoOptions: { ...videoOptions }, videoChannel: generation.videoChannel }
        : { media: "image", ...(countSupported && genCount > 1 ? { count: genCount } : {}), ...(countSupported && transparentLayer ? { transparent: true } : {}) },
    );
    if (!startedGeneration.accepted) {
      if (isCurrentSubmission()) notifyError(startedGeneration.error, "生成任务启动失败，请重试");
      return;
    }
    if (continuation?.continuationRequestId) {
      ackPendingCreativeContinuation(continuation.continuationRequestId);
    }
    // 提交成功不立即退出创作模式：登记本次 job，会话卡片生成成功（末轮有产出图）
    // 时由上方 effect 自动退出；失败/被拒则保持创作模式继续组稿或重试。
    if (isCurrentSubmission()) setSuccessExitJobId(startedGeneration.jobId);
    } catch (error) {
      if (submissionClaim.isCurrent()) notifyError(error, "无法提交生成任务");
    } finally {
      submissionClaim.release();
      setSubmitting(false);
    }
  }

  // 登记=把当前编辑框内容（finalPrompt）存为用途，只需用户给个名字。
  async function savePreset() {
    const name = newName.trim();
    const body = finalPrompt.trim();
    if (!name || !body) return;
    try {
      const id = await api.createPreset(name, body);
      await reloadPresets();
      setActivePreset(id);
      setCreatingPreset(false);
      setNewName("");
      notifySuccess("用途已保存");
    } catch (e) {
      console.error("createPreset failed", e);
      notifyError(e, "保存用途失败");
    }
  }

  function startEditPreset() {
    if (!activePreset) return;
    setEditingPresetId(activePreset.id);
    setEditName(activePreset.name);
    setEditBody(activePreset.body);
    setConfirmDeleteId(null);
  }

  async function saveEditPreset() {
    if (!editingPresetId) return;
    const name = editName.trim();
    const body = editBody.trim();
    if (!name || !body) return;
    try {
      await api.updatePreset(editingPresetId, name, body);
      setEditingPresetId(null);
      notifySuccess("用途已更新");
    } catch (e) {
      console.error("updatePreset failed", e);
      notifyError(e, "更新用途失败");
    }
  }

  async function deletePresetById(id: string) {
    try {
      await api.deletePreset(id);
      if (activePreset?.id === id) setActivePreset(null);
      notifySuccess("用途已删除");
    } catch (e) {
      console.error("deletePreset failed", e);
      notifyError(e, "删除用途失败");
    }
  }

  return (
    // 外层横向定位条（pointer-events-none 不挡瀑布流点击），section 内 pointer-events-auto。
    // z-20：盖过瀑布流与生成会话面板（z-10，发送后面板弹出、板仍可继续组稿），
    // 让位右键菜单(60)/维度环(65)/tour(70)。
    <div className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center ${embedded ? "canvas-composer-host" : ""}`}>
      <section
        ref={dockRef}
        onPointerDown={(e) => {
          if (!(e.target instanceof Element && e.target.closest(".creation-exit-tab"))) {
            setCollapsed(false);
          }
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) focus();
        }}
        onFocusCapture={() => setCollapsed(false)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setCollapsed(true);
        }}
        aria-label="创作板"
        className={`creation-dock pointer-events-auto relative w-[min(760px,calc(100%-24px))] rounded-t-2xl p-2.5 pb-2 ${creating ? "is-creating" : ""} ${embedded ? "is-canvas-composer" : ""} ${
          !creating && collapsed ? "is-collapsed" : ""
        }`}
      >
        {/* 退出创作模式：素材库与项目画板共用同一显式退出入口。 */}
        {creating && (
          <button
            type="button"
            onClick={exitCreationMode}
            className="creation-exit-tab"
            data-tour="board-exit"
            title={embedded
              ? "退出创作模式（回到画板浏览：点图放大，按住空白拖动框选）"
              : "退出创作模式（回普通浏览并收起对话框）"}
            aria-label="退出创作模式"
          >
            <ChevronDown size={13} aria-hidden="true" />
            退出创作模式
          </button>
        )}
        {/* 用途（preset）：发送时作为基底注入；登记=把当前编辑框内容存为用途（只需用途名）。
            功能未完成，PRESET_FEATURE_ENABLED 关闭整块 UI（store 注入逻辑随之不可达）。 */}
        {PRESET_FEATURE_ENABLED && (
        <>
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="shrink-0 text-muted">用途</span>
          <select
            value={activePresetId ?? ""}
            onChange={(e) => setActivePreset(e.target.value || null)}
            className="min-w-0 flex-1 rounded bg-panel2 px-1.5 py-1 text-ink outline-none ring-1 ring-edge focus:ring-accent"
          >
            <option value="">默认</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {creatingPreset ? (
            <>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void savePreset();
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setCreatingPreset(false);
                  }
                }}
                placeholder="用途名"
                className="w-24 rounded bg-panel2 px-1.5 py-1 text-ink outline-none ring-1 ring-edge focus:ring-accent"
              />
              <button
                onClick={savePreset}
                disabled={!newName.trim() || !finalPrompt.trim()}
                className="shrink-0 rounded bg-accent px-2 py-1 font-semibold text-black disabled:opacity-50"
                title="把当前编辑框内容存为该用途"
              >
                ✓
              </button>
              <button
                onClick={() => {
                  setCreatingPreset(false);
                  setNewName("");
                }}
                className="shrink-0 rounded bg-panel2 px-2 py-1 text-ink hover:bg-edge"
              >
                ✕
              </button>
            </>
          ) : (
            <button
              onClick={() => setCreatingPreset(true)}
              disabled={!finalPrompt.trim()}
              className="shrink-0 rounded bg-panel2 px-2 py-1 text-ink hover:bg-edge disabled:opacity-50"
              title={finalPrompt.trim() ? "把当前编辑框内容登记为一个用途" : "编辑框为空，无内容可登记"}
            >
              登记
            </button>
          )}
        </div>
        {activePreset && editingPresetId === activePreset.id ? (
          <div className="mb-2 space-y-1.5 rounded bg-panel2 p-2">
            <input
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="用途名"
              className="w-full rounded bg-panel px-1.5 py-1 text-xs text-ink outline-none ring-1 ring-edge focus:ring-accent"
            />
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              rows={4}
              placeholder="用途内容（发送时作为基底注入）"
              className="max-h-40 w-full resize-y overflow-y-auto rounded bg-panel px-1.5 py-1 text-[11px] leading-5 text-ink outline-none ring-1 ring-edge focus:ring-accent"
            />
            <div className="flex gap-1.5">
              <button
                onClick={saveEditPreset}
                disabled={!editName.trim() || !editBody.trim()}
                className="shrink-0 rounded bg-accent px-2 py-1 text-xs font-semibold text-black disabled:opacity-50"
              >
                保存
              </button>
              <button
                onClick={() => setEditingPresetId(null)}
                className="shrink-0 rounded bg-panel px-2 py-1 text-xs text-ink hover:bg-edge"
              >
                取消
              </button>
            </div>
          </div>
        ) : activePreset ? (
          <div className="mb-2 space-y-1">
            <div className="flex items-start gap-2">
              <div
                className="line-clamp-2 flex-1 text-[10px] leading-4 text-muted"
                title={activePreset.body}
              >
                基底：{activePreset.body}
              </div>
              <button
                onClick={startEditPreset}
                className="shrink-0 text-[10px] text-accent hover:underline"
                title="编辑该用途的名字与内容"
              >
                编辑
              </button>
              {confirmDeleteId === activePreset.id ? (
                <>
                  <button
                    onClick={() => {
                      void deletePresetById(activePreset.id);
                      setConfirmDeleteId(null);
                    }}
                    className="shrink-0 text-[10px] text-red-400 hover:underline"
                  >
                    确认删除
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="shrink-0 text-[10px] text-muted hover:underline"
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmDeleteId(activePreset.id)}
                  className="shrink-0 text-[10px] text-muted hover:text-red-400 hover:underline"
                  title="删除该用途"
                >
                  删除
                </button>
              )}
            </div>
          </div>
        ) : null}
        </>
        )}
        {/* 编辑框：随主题切换的独立输入区；超高后内部滚动（不触发主区滚动收起）。
            获得焦点（contenteditable 冒泡）= 激活创作模式（等同旧「创作板」按钮）。 */}
        <div
          ref={hostRef}
          onClick={(event) => {
            // 正文点击完全交给 ProseMirror 原生定位：冒泡后再 focus() 会把编辑器
            // 旧选区写回 DOM、覆盖点击落点（光标跳到别行，同官网 2026-08-02 踩坑）。
            // 只有点到内容区外的宿主空白（内边距）才手动聚焦。
            if (!(event.target instanceof Element && event.target.closest(".ProseMirror"))) focus();
          }}
          onFocus={() => { setBoardActive(true); beginOnboardingOperation("activate-composer", useStore.getState().activeProjectId)(); }}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              void send();
            }
          }}
          data-onboarding-composer
          data-tour="creation-editor"
          className="creation-editor generation-input min-h-16 max-h-56 cursor-text overflow-y-auto px-3 py-2 text-sm leading-8 text-ink"
        />
        {/* 编辑框内 image/keyword chip 的交互浮层（hover 放大图/维度正文 + 点击定位瀑布流） */}
        <BoardChipPreview hostRef={hostRef} />
        {/* 工具栏：对话框底部一行——左端帮助，中间快捷参数，右端发送（主题自适应按钮）。 */}
        <div className="generation-toolbar flex flex-wrap items-center gap-2">
          <div className="group relative flex shrink-0 items-center">
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-white/10 hover:text-ink"
              aria-label="使用说明"
            >
              <Info size={13} />
            </button>
            <div className="pointer-events-none absolute bottom-full left-0 z-10 mb-1.5 hidden w-60 rounded-lg bg-panel2 p-2 text-[11px] leading-4 text-muted ring-1 ring-edge group-hover:block group-focus-within:block">
              像跟 AI 输入 prompt 一样书写；<span className="text-accent">点瀑布流图片</span>，有维度数据时打开维度环，仅添加所选维度，不自动插入参考图；无维度数据时插入参考图。也可输入 <span className="text-accent">@图名</span> 插入参考图（空格/标点后自动识别）。<span className="text-accent">长按任意图片</span>四周会出现<span className="text-accent">维度环</span>，点环上扇区即可把该维度加入创作板（创作板未打开会自动打开）；无维度数据的图会提示先右键反推。
              {isVideo && <p className="mt-2 text-[11px] leading-4 text-muted">{videoOptions.kind === "frames2video" ? "按编辑框中的参考顺序：第 1 张为首帧，第 2 张为尾帧。" : videoOptions.kind === "multimodal2video" ? "支持图片与视频参考；参考视频每段及总时长均须为 2–30 秒。" : ""}{generation.videoChannel === "cloud" ? "使用 Bowerbird 积分，按成功任务实际用量结算。" : "使用即梦 VIP 及即梦会员积分。"}提交后停止等待，远端任务仍可能完成并计费。</p>}
              {cloudAgentMode && (
                <p className="mt-2 text-[10px] leading-4 text-muted">
                  隐私说明：本次文字和所选参考图会加密上传至 Bowerbird Cloud，仅用于规划与执行。输入和过程内容通常最长保留 24 小时，最终结果最长保留 7 天；取消会停止后续调用，已上传副本仍按上述期限清理。接受后的图片保存到本地素材库，其余素材和本地数据库不会上传。
                </p>
              )}
            </div>
          </div>
          <select aria-label="生成媒体" value={isVideo ? "video" : "image"}
            className="h-7 rounded border border-edge bg-panel2 px-2 text-xs text-ink"
            onChange={(event) => {
              const media = event.target.value === "video" ? "video" : "image";
              const nextRatio = media === "video" && !VIDEO_RATIOS.includes(ratio ?? "") ? "16:9" : ratio;
              setRatio(nextRatio);
              setGeneration({ ...generation, media, videoOptions, ratio: nextRatio });
              if (media === "video") { setCloudAgentMode(false); setAgentMode("off"); setAgentZMode(false); setAgentGMode(false); setAgentDsMode(false); }
            }}><option value="image">图片</option><option value="video">视频</option></select>
          {isVideo && <VideoControls channel={generation.videoChannel} onChannelChange={(videoChannel) => setGeneration({ ...generation, videoChannel, videoOptions: videoChannel === "jimeng" && videoOptions.video_resolution === "1080p" ? { ...videoOptions, video_resolution: "720p" } : videoOptions })} options={videoOptions} onChange={(options) => setGeneration({ ...generation, media: "video", videoOptions: options, ratio })} ratio={ratio} onRatioChange={selectRatio} />}
          {/* Cloud Agent 仍接受显式比例；仅终端型 Agent 不走 Bowerbird 生图参数。
              flex：比例 / 生成选项两个选择器水平并排（外层缺 flex 时 block 根会竖着叠成
              两行，按钮挤在同一列）。 */}
          <div className={`flex shrink-0 items-center gap-2 ${agentZMode || agentGMode || agentDsMode ? "pointer-events-none opacity-40" : ""}`}>
            {!isVideo && <RatioSelect value={ratio} onChange={selectRatio} />}
            {countSupported && (
              <ImageGenOptions
                count={genCount}
                onCountChange={selectGenCount}
                transparent={transparentLayer}
                onTransparentChange={selectTransparentLayer}
              />
            )}
          </div>
          <VisualProfileSelect
            value={activeVisualProfileId}
            onChange={setActiveVisualProfile}
          />
          {isVideo ? null : cloudAgentMode ? (
            <span className="text-[11px] text-muted" title="Agent 使用 Bowerbird Cloud 工具">Bowerbird Cloud</span>
          ) : (
          <div className={`${agentZMode || agentGMode || agentDsMode ? "pointer-events-none opacity-40" : ""}`}>
            <ProviderSelect
              value={activeGenProvider}
              onChange={setActiveGenProvider}
              codexHealth={codexHealth}
              dreaminaHealth={dreaminaHealth}
              cloudAvailable={cloudAvailable}
              cloudAuth={cloudAuth}
              cloudEntitlement={cloudEntitlement}
              defaultProvider={defaultProvider}
              onSetDefaultProvider={setDefaultProvider}
            />
          </div>
          )}
          {agentModeOn && (
          <div className="flex items-center gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={cloudAgentMode}
            disabled={cloudAgentBusy || (!cloudAgentMode && !cloudAgentReady)}
            onClick={() => {
              setCloudAgentMode((enabled) => !enabled);
              setAgentMode("off");
              setAgentZMode(false);
              setAgentGMode(false);
              setAgentDsMode(false);
            }}
            title={!projectAgentContextReady
              ? "Bowerbird Agent 需要在项目画板中启动，才能固定线程与结果归属"
              : !cloudAuth?.logged_in
                ? "请先登录 Bowerbird 账号"
                : !cloudAgentEntitled
                  ? "当前账号暂未开放 Agent，仅已获授权的测试账号可用"
                  : !cloudAgentHasCapacity
                    ? "当前 Agent 并发任务已达上限，请等待已有任务完成"
                    : cloudBalance < cloudAgentRequiredBalance
                      ? "积分不足：Agent 需要预授权 30 积分，结束后按实际模型与工具调用结算"
                      : "根据目标选择生图、排版和检查工具；获得授权后执行"}
            className={`generation-mode-button flex h-7 items-center rounded-[3px] px-2.5 text-xs font-medium disabled:opacity-40 ${
              cloudAgentMode ? "" : "is-off"
            }`}
          >
            <span className="generation-button-content gap-1.5">
              <span className={`h-2 w-2 rounded-full ${cloudAgentMode ? "bg-lime" : "bg-muted/50"}`} />
              Agent
            </span>
          </button>
          </div>
          )}
          {agentAvailable && (agentAOn || agentBOn) && (
            <>
              {agentAOn && (
              <button
                type="button"
                role="switch"
                aria-checked={agentMode === "a"}
                disabled={agentBusy}
                onClick={() => { setAgentMode((mode) => (mode === "a" ? "off" : "a")); setCloudAgentMode(false); setAgentZMode(false); setAgentGMode(false); setAgentDsMode(false); }}
                title="方案A（子句挑选）：Agent 按你的意图从参考图维度原文中挑选子句，确定性拼合后再发送"
                className={`generation-mode-button flex h-7 items-center rounded-[3px] px-2.5 text-xs font-medium disabled:opacity-40 ${
                  agentMode === "a" ? "" : "is-off"
                }`}
              >
                <span className="generation-button-content gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${agentMode === "a" ? "bg-lime" : "bg-muted/50"}`} />
                  Agent A
                </span>
              </button>
              )}
              {agentBOn && (
              <button
                type="button"
                role="switch"
                aria-checked={agentMode === "b"}
                disabled={agentBusy}
                onClick={() => { setAgentMode((mode) => (mode === "b" ? "off" : "b")); setCloudAgentMode(false); setAgentZMode(false); setAgentGMode(false); setAgentDsMode(false); }}
                title="方案B（skill 审查）：Agent 按官方 skill 审查并修复展开后的完整 prompt，再发送"
                className={`generation-mode-button flex h-7 items-center rounded-[3px] px-2.5 text-xs font-medium disabled:opacity-40 ${
                  agentMode === "b" ? "" : "is-off"
                }`}
              >
                <span className="generation-button-content gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${agentMode === "b" ? "bg-lime" : "bg-muted/50"}`} />
                  Agent B
                </span>
              </button>
              )}
            </>
          )}
          {agentZAvailable && agentZOn && (
            <button
              type="button"
              role="switch"
              aria-checked={agentZMode}
              disabled={agentZBusy}
              onClick={() => {
                setAgentZMode((on) => !on);
                setCloudAgentMode(false);
                setAgentMode("off");
                setAgentGMode(false);
                setAgentDsMode(false);
              }}
              title="Agent Z（dev）：把编辑器内容 + 参考图发到 Claude Code 终端（TUI）对话；涉及生图由 Claude Code 理解后自行调用 dreamina CLI，不占 Bowerbird 生成会话"
              className={`generation-mode-button flex h-7 items-center rounded-[3px] px-2.5 text-xs font-medium disabled:opacity-40 ${
                agentZMode ? "" : "is-off"
              }`}
            >
              <span className="generation-button-content gap-1.5">
                <span className={`h-2 w-2 rounded-full ${agentZMode ? "bg-lime" : "bg-muted/50"}`} />
                Agent Z
              </span>
            </button>
          )}
          {agentZAvailable && codexHealth?.ok && agentGOn && (
            <button
              type="button"
              role="switch"
              aria-checked={agentGMode}
              disabled={agentZBusy}
              onClick={() => {
                setAgentGMode((on) => !on);
                setCloudAgentMode(false);
                setAgentMode("off");
                setAgentZMode(false);
                setAgentDsMode(false);
              }}
              title="Agent G（dev）：把编辑器内容 + 参考图发到 codex 终端（TUI）对话；涉及生图/反推由 codex 调用 Bowerbird 的 MCP 工具（即梦/反推链路），不占 Bowerbird 生成会话"
              className={`generation-mode-button flex h-7 items-center rounded-[3px] px-2.5 text-xs font-medium disabled:opacity-40 ${
                agentGMode ? "" : "is-off"
              }`}
            >
              <span className="generation-button-content gap-1.5">
                <span className={`h-2 w-2 rounded-full ${agentGMode ? "bg-lime" : "bg-muted/50"}`} />
                Agent G
              </span>
            </button>
          )}
          {agentDsAvailable && agentDsOn && (
            <button
              type="button"
              role="switch"
              aria-checked={agentDsMode}
              disabled={agentDsBusy}
              onClick={() => {
                setAgentDsMode((on) => !on);
                setCloudAgentMode(false);
                setAgentMode("off");
                setAgentZMode(false);
                setAgentGMode(false);
              }}
              title="Agent DS（dev）：把编辑器内容 + 参考图投递到本机 DSH 队列（.agent-z/ds-inbox/pending/），由你自己开着的 DSH 会话接住（参考图给绝对路径与素材名，能否直接看图取决于该会话模型）；不占生成会话、不经 DeepSeek key"
              className={`generation-mode-button flex h-7 items-center rounded-[3px] px-2.5 text-xs font-medium disabled:opacity-40 ${
                agentDsMode ? "" : "is-off"
              }`}
            >
              <span className="generation-button-content gap-1.5">
                <span className={`h-2 w-2 rounded-full ${agentDsMode ? "bg-lime" : "bg-muted/50"}`} />
                Agent DS
              </span>
            </button>
          )}
          {annotationWarning && (
            <span className="flex shrink-0 items-center text-red-400" title="该模型不支持标注参数，标注图可以被发送，但控制效果可能不及预期。">
              <Info size={14} aria-label="该模型不支持标注参数，标注图可以被发送，但控制效果可能不及预期。" />
            </span>
          )}
          <div
            className="group relative ml-auto"
            tabIndex={sendDisabledReason ? 0 : undefined}
            aria-label={sendDisabledReason ? "生成暂不可用" : undefined}
            aria-describedby={sendDisabledReason ? sendTooltipId : undefined}
          >
            <button
              onClick={() => void send()}
              disabled={sendDisabledReason !== null}
              aria-describedby={sendDisabledReason ? sendTooltipId : undefined}
              title={sendDisabledReason ? undefined : cloudAgentMode
                ? "创建 Bowerbird Agent 会话：明确目标并获得授权后执行"
                : agentZMode
                  ? "发送到 Agent Z 终端（Claude Code TUI）"
                  : agentGMode
                    ? "发送到 Agent G 终端（Codex TUI）"
                    : agentDsMode
                      ? "投递到 DSH 队列（本机 harness 会话接住）"
                      : agentMode !== "off"
                        ? `先由 Agent（${agentMode === "a" ? "方案A" : "方案B"}）整理意图，再发 ${targetProviderLabel} 生成${isVideo ? "视频" : "图像"}`
                        : `把当前 prompt + 参考图发 ${targetProviderLabel} 生成${isVideo ? "视频" : "图像"}`}
              className={`generation-send-button ${sendDisabledReason ? "pointer-events-none" : ""}`}
            >
              <span className="generation-button-content gap-1.5">
                <Sparkles size={13} />
                {submitting && !cloudAgentBusy && !agentZBusy && !agentDsBusy && !agentBusy
                  ? "正在提交…"
                  : cloudAgentBusy
                  ? "正在创建 Agent 会话…"
                  : cloudAgentMode
                    ? "交给 Agent"
                    : agentZBusy
                  ? "正在投递到 Agent…"
                  : agentZMode
                    ? "发送到 Agent Z"
                    : agentGMode
                      ? "发送到 Agent G"
                      : agentDsBusy
                        ? "正在投递…"
                        : agentDsMode
                          ? "投递到 DSH"
                          : agentBusy
                            ? "Agent 正在整理意图…"
                            : isVideo ? "生成视频" : "生成图像"}
              </span>
            </button>
            {sendDisabledReason && (
              <div id={sendTooltipId} role="tooltip" className="pointer-events-none absolute bottom-full right-0 z-40 mb-2 hidden w-72 max-w-[calc(100vw-2rem)] whitespace-normal rounded-lg bg-panel2 p-2.5 text-xs leading-5 text-ink shadow-lg ring-1 ring-edge group-hover:block group-focus-within:block">
                {sendDisabledReason}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
