import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { canStartAnotherAgentRun, canStartAnotherJob, canUseAgentRun, canUseByo } from "../lib/entitlement";
import { cloudProviderLabel, isCloudProvider, supportsAnnotationCoordinates } from "../lib/genProviders";
import { api } from "../lib/api";
import { AGENT_DS_ENABLED, AGENT_Z_ENABLED, PRESET_FEATURE_ENABLED } from "../lib/featureFlags";
import { notify, notifyError, notifySuccess } from "../lib/notify";
import {
  CONTROLLED_AGENT_SKILL,
  HTML_LAYOUT_AGENT_SKILL,
  activateCloudAgentSkill,
  cloudAgentSkill as resolveCloudAgentSkill,
  toggleCloudAgent,
  type CloudAgentSelection,
} from "../lib/cloudAgentSelection";
import { useCreationEditor } from "./creation/useCreationEditor";
import { RATIOS } from "./creation/ratios";
import { RatioSelect } from "./creation/RatioSelect";
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
 * 主区滚动时整体下沉收起（.is-collapsed：只露编辑框第一行，其余被应用底边截断）。
 * 收起/展开规则（优先级从高到低）：① 退出创作模式 = 取消在途自动浮回，非首屏收起、
 * 首屏保持展开；② 滚回顶部立即展开；③ 未激活态非首屏收起后不自动弹出，hover/点击
 * 展开；④ 激活态滚动停 350ms 自动浮回。对话框高度经 ResizeObserver 写入
 * --board-dock-h，瀑布流据此留底部 padding（同会话编辑坞 --gen-dock-h 模式）。
 *
 * 参考图入口：创作模式激活时点瀑布流任意图即在光标处插 image chip；也可手输 @图名，
 * 空格/标点后自动识别为 image chip。维度环（CaptionRing）为全局组件（长按图片呼出），
 * 点环上扇区经 store.pendingKeyword 由本板编辑器消费插入 keyword chip。
 */
export function CreationBoard() {
  const codexHealth = useStore((s) => s.codexHealth);
  const creating = useStore((s) => s.boardOpen);
  const setBoardActive = useStore((s) => s.setBoardActive);
  const dreaminaHealth = useStore((s) => s.dreaminaHealth);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudAvailable = cloudAuth?.cloud_available ?? false;
  const runningJobCount = useStore((s) => Object.values(s.genJobs).filter((j) => j.running).length);
  const activeGenProvider = useStore((s) => s.activeGenProvider);
  const setActiveGenProvider = useStore((s) => s.setActiveGenProvider);
  const defaultProvider = useStore((s) => s.defaultProvider);
  const setDefaultProvider = useStore((s) => s.setDefaultProvider);
  const startGeneration = useStore((s) => s.startGeneration);
  const presets = useStore((s) => s.presets);
  const activePresetId = useStore((s) => s.activePresetId);
  const setActivePreset = useStore((s) => s.setActivePreset);
  const reloadPresets = useStore((s) => s.reloadPresets);
  const openCloudAgentRun = useStore((s) => s.openCloudAgentRun);
  const cloudAgentRuns = useStore((s) => s.cloudAgentRuns);
  const pendingAgentArm = useStore((s) => s.pendingAgentArm);
  const clearPendingAgentArm = useStore((s) => s.clearPendingAgentArm);
  const settings = useStore((s) => s.settings);
  const activeVisualProfileId = useStore((s) => s.activeVisualProfileId);
  const setActiveVisualProfile = useStore((s) => s.setActiveVisualProfile);

  // consumePendingKeyword：本板是维度环点选（pendingKeyword）的唯一消费方（编辑坞不抢）。
  // initialEmpty：空文档开局（配 is-empty 占位「描述你的意图，开始创作吧」；有草稿仍恢复），
  // 取代旧「请参考」预填——提示职责交给占位文字。
  const {
    hostRef,
    focus,
    finalPrompt,
    rawPrompt,
    references,
    dimensionSources,
    graphSources,
    agentPromptReferences,
  } = useCreationEditor({ consumePendingKeyword: true, initialEmpty: true });

  // 画面比例（null=自动/不指定，发送时不注入 instruction）。记忆进 localStorage，跨会话保留。
  const [ratio, setRatio] = useState<string | null>(loadBoardRatio);
  const selectRatio = (v: string | null) => {
    setRatio(v);
    saveBoardRatio(v);
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
  // 正式用户侧 Agent：受服务端 skill allowlist 控制；HTML 排版仅对已开放账号显示。
  // A/B/Z/G/DS 继续保留为 dev 基线，但与正式模式互斥。
  // null = 正式 Agent 关闭；skill id = Agent 已开启。单状态建模避免 UI 选中 HTML、发送却走普通生图。
  const [cloudAgentSelection, setCloudAgentSelection] = useState<CloudAgentSelection>(null);
  const cloudAgentMode = cloudAgentSelection !== null;
  const cloudAgentSkill = resolveCloudAgentSkill(cloudAgentSelection);
  const [cloudAgentBusy, setCloudAgentBusy] = useState(false);
  const [htmlViewportWidth, setHtmlViewportWidth] = useState(900);
  const [htmlViewportHeight, setHtmlViewportHeight] = useState(700);
  const [htmlDeviceScaleFactor, setHtmlDeviceScaleFactor] = useState<1 | 2>(1);
  const [htmlCaptureMode, setHtmlCaptureMode] = useState<"viewport" | "full_page" | "full_page_and_slices">("full_page_and_slices");
  const [htmlSliceHeight, setHtmlSliceHeight] = useState(900);
  const [htmlOverlap, setHtmlOverlap] = useState(0);
  const [htmlBackground, setHtmlBackground] = useState<"opaque" | "transparent">("opaque");
  // Agent Z（dev-only）：创作板消息投递到 Claude Code TUI 终端，Bowerbird 侧不走生图链路；与 A/B 互斥。
  const [agentZMode, setAgentZMode] = useState(false);
  const [agentZAvailable, setAgentZAvailable] = useState(false);
  const [agentZBusy, setAgentZBusy] = useState(false);
  // Agent G（dev-only）：同机制投递到 codex TUI 终端（独立窗口会话）；与 A/B/Z/DS 互斥。
  // busy 与 Z 共用（同一后端命令通路）。可用性 = Z 通道探活（release 构建后端拒绝 → 不渲染，
  // 约定 30/36 同款门控）+ codexHealth（codex CLI 安装 + 登录态）。
  const [agentGMode, setAgentGMode] = useState(false);
  // Agent DS（dev-only）：DeepSeek 对话 harness，对话发生在创作板内（回复追加进编辑器）；
  // 与 A/B/Z 互斥。可用性与 Agent A/B 同源（agent-worker + cloud/.env）。
  const agentDsAvailable = agentAvailable && AGENT_DS_ENABLED;
  const [agentDsMode, setAgentDsMode] = useState(false);
  const [agentDsBusy, setAgentDsBusy] = useState(false);
  // 设置「开发者选项」的对话框模式开关（settings 未加载 = 默认：仅正式 Agent 开）。
  // 关闭的模式按钮不渲染；可用性健康检查（agentAvailable / agentZAvailable / codexHealth）照常叠加。
  const agentModeOn = settings?.agent_mode_enabled ?? true;
  const agentAOn = settings?.agent_a_mode_enabled ?? false;
  const agentBOn = settings?.agent_b_mode_enabled ?? false;
  const agentZOn = settings?.agent_z_mode_enabled ?? false;
  const agentGOn = settings?.agent_g_mode_enabled ?? false;
  const agentDsOn = settings?.agent_ds_mode_enabled ?? false;
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

  // 会话详情「开启 Agent 模式再试」：链接点击置位 pendingAgentArm 并关面板回主界面，
  // 本板随 genPanelOpen=false 才挂载 → 在挂载/更新时消费信号，打开正式 Agent 开关并
  // 复位其余 Agent 开关（与 Agent 按钮点击同款互斥复位）；消费即清，防止重挂载误触发。
  useEffect(() => {
    if (!pendingAgentArm) return;
    setCloudAgentSelection(CONTROLLED_AGENT_SKILL);
    setAgentMode("off");
    setAgentZMode(false);
    setAgentGMode(false);
    setAgentDsMode(false);
    clearPendingAgentArm();
  }, [pendingAgentArm, clearPendingAgentArm]);

  // 设置里关闭的模式：隐藏按钮同时复位其激活态（含「开启 Agent 模式再试」等异步置位路径）。
  useEffect(() => {
    if (!agentModeOn && cloudAgentMode) setCloudAgentSelection(null);
    if (!agentAOn && agentMode === "a") setAgentMode("off");
    if (!agentBOn && agentMode === "b") setAgentMode("off");
    if (!agentZOn && agentZMode) setAgentZMode(false);
    if (!agentGOn && agentGMode) setAgentGMode(false);
    if (!agentDsOn && agentDsMode) setAgentDsMode(false);
  }, [
    agentModeOn, agentAOn, agentBOn, agentZOn, agentGOn, agentDsOn,
    cloudAgentMode, agentMode, agentZMode, agentGMode, agentDsMode,
  ]);

  // —— 底部浮动对话框形态（收起/展开规则，优先级从高到低；改这里先核对不打架）——
  // ① 退出创作模式（exitCreationMode）：取消在途自动浮回；非首屏立即收起、首屏保持展开；
  // ② 滚动：滚回顶部（library-scroller 在顶）立即展开并取消在途浮回；非顶部收起；
  // ③ 未激活态非首屏：收起后不自动弹出，hover 或点击展开（点击编辑框同时激活）；
  // ④ 激活态滚动停 350ms 自动浮回。①③④都可能「展开」，共享 cancelAutoExpand 防串场。
  const dockRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  // 滚动监听 [] 只注册一次；creatingRef 读当前激活态。
  const creatingRef = useRef(creating);
  creatingRef.current = creating;
  const expandTimerRef = useRef<number | undefined>(undefined);
  const cancelAutoExpand = () => {
    if (expandTimerRef.current !== undefined) {
      window.clearTimeout(expandTimerRef.current);
      expandTimerRef.current = undefined;
    }
  };
  useEffect(() => {
    function onScroll(e: Event) {
      const target = e.target;
      const dock = dockRef.current;
      if (!(target instanceof Node) || !dock) return;
      if (dock.contains(target)) return;
      if (!dock.closest(".app-workspace")?.contains(target)) return;
      // 回滚到首屏（滚动容器已在顶部）：取消在途浮回，立即弹出。
      if (target instanceof Element && target.scrollTop <= 0) {
        cancelAutoExpand();
        setCollapsed(false);
        return;
      }
      setCollapsed(true);
      cancelAutoExpand();
      if (!creatingRef.current) return; // 未激活非首屏：保持收起，等 hover / 点击展开
      expandTimerRef.current = window.setTimeout(() => {
        expandTimerRef.current = undefined;
        setCollapsed(false);
      }, 350);
    }
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      cancelAutoExpand();
    };
  }, []);
  // 主区（瀑布流）滚动容器是否在顶 = 「首屏」；空库无滚动容器时视作首屏。
  function atLibraryTop(): boolean {
    const scroller = dockRef.current
      ?.closest(".app-workspace")
      ?.querySelector(".library-scroller");
    return !scroller || scroller.scrollTop <= 0;
  }
  // 退出创作模式：先取消在途自动浮回（否则 350ms 后又弹开，与收起打架）；
  // 非首屏收起让位浏览（滚回顶部会再自动弹出），首屏保持展开（欢迎态）。
  function exitCreationMode() {
    setBoardActive(false);
    cancelAutoExpand();
    setCollapsed(!atLibraryTop());
  }

  // 对话框高度 → --board-dock-h：瀑布流滚动容器据此留底部 padding，最后一行素材
  // 不被对话框盖住（与会话编辑坞 --gen-dock-h 同款；收起是纯 transform，高度不变）。
  useEffect(() => {
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
  }, []);

  // 按当前选中的 provider 判健康（云端需开关+登录+余额，其余读各自 health）。
  const cloudBalance = cloudEntitlement
    ? cloudEntitlement.balances.daily + cloudEntitlement.balances.sub + cloudEntitlement.balances.topup
    : 0;
  const targetReady = isCloudProvider(activeGenProvider)
    ? cloudAvailable && !!cloudAuth?.logged_in && cloudBalance > 0
    : activeGenProvider === "jimeng"
      ? canUseByo(cloudEntitlement) && !!dreaminaHealth?.ok
      : canUseByo(cloudEntitlement) && !!codexHealth?.ok;
  // 正式 Agent 的生图引擎跟随当前选择：Cloud 各档 → 云端方舟 Seedream；即梦 / Codex →
  // 桌面本地 CLI（文本、审批与编排仍在云端，生图步骤经 awaiting_local_task 委托本机）。
  const agentImageProvider = activeGenProvider === "jimeng"
    ? "jimeng"
    : activeGenProvider === "codex"
      ? "codex"
      : isCloudProvider(activeGenProvider)
        ? "cloud"
        : null;
  const localAgentProviderReady = agentImageProvider === "jimeng"
    ? canUseByo(cloudEntitlement) && !!dreaminaHealth?.ok
    : agentImageProvider === "codex"
      ? canUseByo(cloudEntitlement) && !!codexHealth?.ok
      : true;
  // 预授权门控暂缓（0029）：不再要求余额 ≥48，云端按可用余额回落低档（≥5 即可启动）；
  // 真正的余额校验由服务端 credit_hold 权威执行。
  const activeCloudAgentRunCount = Object.values(cloudAgentRuns).filter((run) =>
    !["succeeded", "failed", "cancelled"].includes(run.status)
  ).length;
  const htmlAgentEntitled = canUseAgentRun(cloudEntitlement, HTML_LAYOUT_AGENT_SKILL);
  const cloudAgentEntitled = canUseAgentRun(cloudEntitlement, cloudAgentSkill);
  const cloudAgentHasCapacity = canStartAnotherAgentRun(cloudEntitlement, activeCloudAgentRunCount, cloudAgentSkill);
  const htmlAgentSelected = cloudAgentSkill === HTML_LAYOUT_AGENT_SKILL;
  // Codex 自身已有思考/对话编排，叠加 Bowerbird Agent 会形成重复规划且耗时过长。
  // 暂时禁止新建 Codex + Agent 组合；即梦与 Cloud 路径保持不变。
  const cloudAgentProviderCompatible = htmlAgentSelected || activeGenProvider !== "codex";
  const cloudAgentRequiredBalance = htmlAgentSelected ? 15 : 5;
  const htmlOptionsValid = !htmlAgentSelected || (
    htmlViewportWidth >= 320 && htmlViewportWidth <= 2400 &&
    htmlViewportHeight >= 240 && htmlViewportHeight <= 4000 &&
    (htmlCaptureMode !== "full_page_and_slices" || (
      htmlSliceHeight >= 200 && htmlSliceHeight <= 4000 && htmlOverlap >= 0 && htmlOverlap <= 200 && htmlOverlap < htmlSliceHeight
    ))
  );
  const cloudAgentReady =
    cloudAgentProviderCompatible &&
    (htmlAgentSelected || !!agentImageProvider) &&
    cloudAgentHasCapacity &&
    cloudAvailable &&
    !!cloudAuth?.logged_in &&
    cloudBalance >= cloudAgentRequiredBalance &&
    htmlOptionsValid &&
    (htmlAgentSelected || localAgentProviderReady);
  const targetProviderLabel = isCloudProvider(activeGenProvider)
    ? (cloudProviderLabel(activeGenProvider, cloudEntitlement) ?? "Bowerbird Cloud")
    : activeGenProvider === "jimeng"
      ? "即梦"
      : "codex";
  const hasAnnotationDimension = graphSources.some((source) =>
    source.dimensions.some((title) => title === "标注" || title === "标记")
  );
  const annotationWarning =
    !cloudAgentMode && !agentZMode && !agentGMode && !agentDsMode && hasAnnotationDimension && !supportsAnnotationCoordinates(activeGenProvider);

  useEffect(() => {
    if (!cloudAgentMode || cloudAgentProviderCompatible) return;
    setCloudAgentSelection(null);
    notify("已关闭 Agent：Codex 与 Bowerbird Agent 暂时互斥，请改用 Codex 直接生成或选择 Cloud / 即梦 Agent。", "info");
  }, [activeGenProvider, cloudAgentMode, cloudAgentProviderCompatible]);

  // 把当前组稿发 provider 生成。生成期间编辑器仍可继续组下一轮稿（prompt 在此快照进 store）。
  // provider 由 store 内 activeGenProvider 兜底（send 不显式传）。
  // 发送成功即退出创作模式（同「退出创作模式」页签：回普通浏览，左键恢复开详情；
  // 校验不过/发送失败则保持创作模式继续组稿）。
  async function send() {
    if (cloudAgentMode) {
      const body = (rawPrompt || finalPrompt).trim();
      if (!body || cloudAgentBusy || !cloudAgentReady) return;
      setCloudAgentBusy(true);
      try {
        const run = await api.cloudAgentStart({
          intentPrompt: body,
          references: references.map((reference) => ({
            assetId: reference.id,
            promptToken: agentPromptReferences.find((item) => item.assetId === reference.id)?.name ?? reference.name,
          })),
          ratio,
          projectId: useStore.getState().currentProjectId,
          imageProvider: agentImageProvider,
          visualProfileId: activeVisualProfileId,
          skillId: cloudAgentSkill,
          htmlOptions: htmlAgentSelected ? {
            viewportWidth: htmlViewportWidth,
            viewportHeight: htmlViewportHeight,
            deviceScaleFactor: htmlDeviceScaleFactor,
            captureMode: htmlCaptureMode,
            sliceHeight: htmlCaptureMode === "full_page_and_slices" ? htmlSliceHeight : null,
            overlap: htmlCaptureMode === "full_page_and_slices" ? htmlOverlap : null,
            background: htmlBackground,
          } : null,
        });
        openCloudAgentRun(run);
        notifySuccess(htmlAgentSelected ? "HTML 排版会话已创建，正在生成离线排版文档" : "Agent 会话已创建，正在进行纯文本意图分析");
        exitCreationMode();
      } catch (error) {
        notifyError(error, "启动 Bowerbird Agent 失败");
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
        );
        notifySuccess("已发送到 Agent Z 终端");
        exitCreationMode();
      } catch (error) {
        notifyError(error, "发送到 Agent Z 失败");
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
        );
        notifySuccess("已发送到 Agent G 终端");
        exitCreationMode();
      } catch (error) {
        notifyError(error, "发送到 Agent G 失败");
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
        const refPaths = references.map((r) => r.store_path).filter((p): p is string => !!p);
        await api.agentDsChat(body, refPaths);
        notifySuccess("Agent DS 正在思考，回复将追加到创作板");
        exitCreationMode();
      } catch (error) {
        notifyError(error, "发送到 Agent DS 失败");
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
        prompt = result.prompt;
      } catch (error) {
        notifyError(error, "Agent 意图分析失败");
        return;
      } finally {
        setAgentBusy(false);
      }
    }
    await startGeneration(
      prompt,
      references,
      ratio,
      undefined,
      rawPrompt,
      undefined,
      undefined,
      dimensionSources,
    );
    exitCreationMode();
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
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center">
      <section
        ref={dockRef}
        onPointerDown={(e) => {
          // 退出页签的 pointerdown 不展开（其 click 自带收起/展开决策），
          // 避免「先弹又收」打架；其余任意处点击 = 展开。
          if (!(e.target instanceof Element && e.target.closest(".creation-exit-tab"))) {
            setCollapsed(false);
          }
        }}
        onMouseEnter={() => {
          // 未激活：收起态 hover 展开（激活态由滚动停 350ms 自动浮回，不抢）。
          if (!creating) setCollapsed(false);
        }}
        aria-label="创作板"
        className={`creation-dock pointer-events-auto relative w-[min(760px,calc(100%-24px))] rounded-t-2xl p-2.5 pb-2 ${
          collapsed ? "is-collapsed" : ""
        }`}
      >
        {/* 退出创作模式：对话框右上角向上突出的档案标签页签（仅激活态出现）。 */}
        {creating && (
          <button
            type="button"
            onClick={exitCreationMode}
            className="creation-exit-tab"
            data-tour="board-exit"
            title="退出创作模式（回普通浏览：点图开详情；非首屏会先收起，滚回顶部自动弹出）"
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
                  if (e.key === "Escape") setCreatingPreset(false);
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
        {/* 编辑框：毛玻璃上一块更深的输入区；超高后内部滚动（不触发主区滚动收起）。
            获得焦点（contenteditable 冒泡）= 激活创作模式（等同旧「创作板」按钮）。 */}
        <div
          ref={hostRef}
          onClick={focus}
          onFocus={() => setBoardActive(true)}
          data-tour="creation-editor"
          className="creation-editor min-h-16 max-h-56 cursor-text overflow-y-auto rounded-lg bg-black/30 px-3 py-2 text-sm leading-8 text-ink focus-within:ring-1 focus-within:ring-accent/70"
        />
        {/* 编辑框内 image/keyword chip 的交互浮层（hover 放大图/维度正文 + 点击定位瀑布流） */}
        <BoardChipPreview hostRef={hostRef} />
        {cloudAgentMode && htmlAgentSelected && (
          <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg border border-edge bg-black/20 p-2 text-[10px] text-muted sm:grid-cols-4">
            <label className="space-y-1">视口宽度
              <input type="number" min={320} max={2400} value={htmlViewportWidth} onChange={(event) => setHtmlViewportWidth(Number(event.target.value))} className="w-full rounded bg-panel px-2 py-1 text-xs text-ink ring-1 ring-edge" />
            </label>
            <label className="space-y-1">视口高度
              <input type="number" min={240} max={4000} value={htmlViewportHeight} onChange={(event) => setHtmlViewportHeight(Number(event.target.value))} className="w-full rounded bg-panel px-2 py-1 text-xs text-ink ring-1 ring-edge" />
            </label>
            <label className="space-y-1">像素倍率
              <select value={htmlDeviceScaleFactor} onChange={(event) => setHtmlDeviceScaleFactor(Number(event.target.value) as 1 | 2)} className="w-full rounded bg-panel px-2 py-1 text-xs text-ink ring-1 ring-edge">
                <option value={1}>1×</option><option value={2}>2×</option>
              </select>
            </label>
            <label className="space-y-1">背景
              <select value={htmlBackground} onChange={(event) => setHtmlBackground(event.target.value as "opaque" | "transparent")} className="w-full rounded bg-panel px-2 py-1 text-xs text-ink ring-1 ring-edge">
                <option value="opaque">不透明</option><option value="transparent">透明</option>
              </select>
            </label>
            <label className="col-span-2 space-y-1">截图方式
              <select value={htmlCaptureMode} onChange={(event) => setHtmlCaptureMode(event.target.value as typeof htmlCaptureMode)} className="w-full rounded bg-panel px-2 py-1 text-xs text-ink ring-1 ring-edge">
                <option value="viewport">仅视口</option>
                <option value="full_page">整页</option>
                <option value="full_page_and_slices">整页 + 切片</option>
              </select>
            </label>
            {htmlCaptureMode === "full_page_and_slices" && (
              <>
                <label className="space-y-1">切片高度
                  <input type="number" min={200} max={4000} value={htmlSliceHeight} onChange={(event) => setHtmlSliceHeight(Number(event.target.value))} className="w-full rounded bg-panel px-2 py-1 text-xs text-ink ring-1 ring-edge" />
                </label>
                <label className="space-y-1">重叠像素
                  <input type="number" min={0} max={200} value={htmlOverlap} onChange={(event) => setHtmlOverlap(Number(event.target.value))} className="w-full rounded bg-panel px-2 py-1 text-xs text-ink ring-1 ring-edge" />
                </label>
              </>
            )}
            {!htmlOptionsValid && <span className="col-span-full text-red-300">参数超出安全范围，请检查视口和切片尺寸。</span>}
          </div>
        )}
        {/* 工具栏：对话框底部一行——左端帮助，中间快捷参数，右端发送（同款光晕按钮）。 */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="group relative flex shrink-0 items-center">
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-white/10 hover:text-ink"
              aria-label="使用说明"
            >
              <Info size={13} />
            </button>
            <div className="pointer-events-none absolute bottom-full left-0 z-10 mb-1.5 hidden w-60 rounded-lg bg-panel2 p-2 text-[11px] leading-4 text-muted ring-1 ring-edge group-hover:block">
              像跟 AI 输入 prompt 一样书写；<span className="text-accent">点瀑布流图片</span> 在光标处插入参考图，或输入 <span className="text-accent">@图名</span>（空格/标点后自动识别）。<span className="text-accent">长按任意图片</span>四周会出现<span className="text-accent">维度环</span>，点环上扇区即可把该维度加入创作板（创作板未打开会自动打开）；无维度数据的图会提示先右键反推。
            </div>
          </div>
          {/* Cloud Agent 仍接受显式比例；仅终端型 Agent 不走 Bowerbird 生图参数。 */}
          <div className={`${agentZMode || agentGMode || agentDsMode || (htmlAgentSelected && cloudAgentMode) ? "pointer-events-none opacity-40" : ""}`}>
            <RatioSelect value={ratio} onChange={selectRatio} />
          </div>
          <VisualProfileSelect
            value={activeVisualProfileId}
            onChange={setActiveVisualProfile}
            disabled={agentZMode || agentGMode || agentDsMode || (htmlAgentSelected && cloudAgentMode)}
          />
          <div className={`${agentZMode || agentGMode || agentDsMode || (htmlAgentSelected && cloudAgentMode) ? "pointer-events-none opacity-40" : ""}`}>
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
          {agentModeOn && (
          <div className="flex items-center gap-1">
          {htmlAgentEntitled && (
            <select
              aria-label="Agent Skill"
              value={cloudAgentSkill}
              disabled={cloudAgentBusy}
              onChange={(event) => {
                setCloudAgentSelection(activateCloudAgentSkill(event.target.value));
                setAgentMode("off");
                setAgentZMode(false);
                setAgentGMode(false);
                setAgentDsMode(false);
              }}
              className="h-7 rounded-[3px] border border-edge bg-panel2 px-2 text-[11px] text-ink outline-none focus:border-accent"
            >
              <option value={CONTROLLED_AGENT_SKILL}>受控生图</option>
              <option value={HTML_LAYOUT_AGENT_SKILL}>HTML 排版截图</option>
            </select>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={cloudAgentMode}
            disabled={cloudAgentBusy || (!cloudAgentMode && !cloudAgentReady)}
            onClick={() => {
              setCloudAgentSelection((selection) => toggleCloudAgent(selection));
              setAgentMode("off");
              setAgentZMode(false);
              setAgentGMode(false);
              setAgentDsMode(false);
            }}
            title={!cloudAgentProviderCompatible
              ? "Codex 与 Bowerbird Agent 暂时互斥：Codex 已有思考与对话能力，请直接使用 Codex，或为 Agent 选择 Cloud / 即梦"
              : !cloudAuth?.logged_in
                ? "请先登录 Bowerbird 账号"
                : !cloudAgentEntitled
                  ? "当前账号未开放 Bowerbird Agent"
                  : !cloudAgentHasCapacity
                    ? "当前 Agent 并发任务已达上限，请等待已有任务完成"
                    : htmlAgentSelected
                      ? cloudBalance < cloudAgentRequiredBalance
                        ? "积分不足：HTML 排版 Run 需要预授权 15 积分，结束后按实际文本调用结算"
                        : "把当前文字与显式参考图编译为受限 HTML/CSS，并在断网 renderer 中输出整图或切片；每个 Run 只渲染一次"
                    : !agentImageProvider
                      ? "当前生图引擎不支持 Agent"
                      : agentImageProvider !== "cloud" && !canUseByo(cloudEntitlement)
                        ? "升级 Pro 解锁本机 Codex / 即梦 CLI Agent 生图"
                        : agentImageProvider === "jimeng" && !dreaminaHealth?.ok
                          ? "即梦 CLI 不可用：请先在「设置 · 模型设置」完成安装与登录"
                          : cloudBalance < cloudAgentRequiredBalance
                        ? "积分不足：Agent Run 启动时会预授权积分，结束后按实际工具调用结算"
                        : agentImageProvider === "jimeng"
                          ? "先只从文字分析真实意图，给出可审批计划；批准后生图步骤用本机即梦执行（不消耗 Bowerbird 积分）"
                          : "先只从文字分析真实意图，给出可审批计划；批准后才调用方舟工具，结果反馈会形成新的修订计划"}
            className={`generation-glow-button flex h-7 items-center rounded-[3px] px-2.5 text-xs font-medium disabled:opacity-40 ${
              cloudAgentMode ? "" : "is-off"
            }`}
          >
            <span className="generation-glow-button__content gap-1.5">
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
                onClick={() => { setAgentMode((mode) => (mode === "a" ? "off" : "a")); setCloudAgentSelection(null); setAgentZMode(false); setAgentGMode(false); setAgentDsMode(false); }}
                title="方案A（子句挑选）：Agent 按你的意图从参考图维度原文中挑选子句，确定性拼合后再发送"
                className={`generation-glow-button flex h-7 items-center rounded-[3px] px-2.5 text-xs font-medium disabled:opacity-40 ${
                  agentMode === "a" ? "" : "is-off"
                }`}
              >
                <span className="generation-glow-button__content gap-1.5">
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
                onClick={() => { setAgentMode((mode) => (mode === "b" ? "off" : "b")); setCloudAgentSelection(null); setAgentZMode(false); setAgentGMode(false); setAgentDsMode(false); }}
                title="方案B（skill 审查）：Agent 按官方 skill 审查并修复展开后的完整 prompt，再发送"
                className={`generation-glow-button flex h-7 items-center rounded-[3px] px-2.5 text-xs font-medium disabled:opacity-40 ${
                  agentMode === "b" ? "" : "is-off"
                }`}
              >
                <span className="generation-glow-button__content gap-1.5">
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
                setCloudAgentSelection(null);
                setAgentMode("off");
                setAgentGMode(false);
                setAgentDsMode(false);
              }}
              title="Agent Z（dev）：把编辑器内容 + 参考图发到 Claude Code 终端（TUI）对话；涉及生图由 Claude Code 理解后自行调用 dreamina CLI，不占 Bowerbird 生成会话"
              className={`generation-glow-button flex h-7 items-center rounded-[3px] px-2.5 text-xs font-medium disabled:opacity-40 ${
                agentZMode ? "" : "is-off"
              }`}
            >
              <span className="generation-glow-button__content gap-1.5">
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
                setCloudAgentSelection(null);
                setAgentMode("off");
                setAgentZMode(false);
                setAgentDsMode(false);
              }}
              title="Agent G（dev）：把编辑器内容 + 参考图发到 codex 终端（TUI）对话；涉及生图/反推由 codex 调用 Bowerbird 的 MCP 工具（即梦/反推链路），不占 Bowerbird 生成会话"
              className={`generation-glow-button flex h-7 items-center rounded-[3px] px-2.5 text-xs font-medium disabled:opacity-40 ${
                agentGMode ? "" : "is-off"
              }`}
            >
              <span className="generation-glow-button__content gap-1.5">
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
                setCloudAgentSelection(null);
                setAgentMode("off");
                setAgentZMode(false);
                setAgentGMode(false);
              }}
              title="Agent DS（dev）：编辑器内容 + 参考图发给 DeepSeek 对话助手，回复追加到创作板；生图/反推由它调用 Bowerbird 即梦/反推链路，不占生成会话"
              className={`generation-glow-button flex h-7 items-center rounded-[3px] px-2.5 text-xs font-medium disabled:opacity-40 ${
                agentDsMode ? "" : "is-off"
              }`}
            >
              <span className="generation-glow-button__content gap-1.5">
                <span className={`h-2 w-2 rounded-full ${agentDsMode ? "bg-lime" : "bg-muted/50"}`} />
                Agent DS
              </span>
            </button>
          )}
          {!targetReady && !cloudAgentMode && !agentZMode && !agentGMode && !agentDsMode && (
            <span
              className="max-w-56 truncate text-[10px] text-muted"
              title="请先登录 Bowerbird 账号或在「设置 · AI 出图引擎」选择可用引擎"
            >
              请先登录账号或选择可用引擎
            </span>
          )}
          {annotationWarning && (
            <span className="flex shrink-0 items-center text-red-400" title="该模型不支持标注参数，标注图可以被发送，但控制效果可能不及预期。">
              <Info size={14} aria-label="该模型不支持标注参数，标注图可以被发送，但控制效果可能不及预期。" />
            </span>
          )}
          <button
            onClick={() => void send()}
            disabled={
              agentZBusy ||
              agentDsBusy ||
              cloudAgentBusy ||
              (cloudAgentMode
                ? !(rawPrompt || finalPrompt).trim() || !cloudAgentReady
                : agentZMode || agentGMode || agentDsMode
                ? !(rawPrompt || finalPrompt).trim()
                : agentBusy || !finalPrompt || !targetReady || !canStartAnotherJob(cloudEntitlement, runningJobCount))
            }
            title={
              cloudAgentMode
                ? !cloudAuth?.logged_in
                  ? "请先登录 Bowerbird 账号"
                  : !cloudAgentEntitled
                    ? "当前账号未开放 Bowerbird Agent"
                    : !cloudAgentHasCapacity
                      ? "当前 Agent 并发任务已达上限，请等待已有任务完成"
                      : cloudBalance < cloudAgentRequiredBalance
                        ? "积分不足：Agent Run 启动时会预授权积分，结束后按实际工具调用结算"
                        : htmlAgentSelected
                          ? "创建 HTML 排版会话：单次生成受限 HTML/CSS，并离线渲染整图/切片"
                          : "创建 Bowerbird Agent 会话：先分析文字并提交计划，批准后才执行"
                : agentZMode
                ? "发送到 Agent Z 终端（Claude Code TUI）：对话为主；涉及生图由 Claude Code 理解后自行调用 dreamina CLI"
                : agentGMode
                  ? "发送到 Agent G 终端（codex TUI）：对话为主；涉及生图/反推由 codex 调用 Bowerbird MCP 工具"
                  : agentDsMode
                    ? "发送给 Agent DS（DeepSeek 对话助手）：回复追加到创作板；生图/反推经 Bowerbird 链路执行"
                    : !targetReady
                      ? `${targetProviderLabel} 不可用`
                      : !canStartAnotherJob(cloudEntitlement, runningJobCount)
                        ? "已达当前档位的并行生成上限"
                        : agentMode !== "off"
                          ? `先由 Agent（${agentMode === "a" ? "方案A" : "方案B"}）整理意图，再发 ${targetProviderLabel} 生成图像`
                          : `把当前 prompt + 参考图发 ${targetProviderLabel} 生成图像`
            }
            className="generation-glow-button ml-auto flex h-8 shrink-0 items-center rounded-full px-4 text-xs font-semibold disabled:opacity-50"
          >
            <span className="generation-glow-button__content gap-1.5">
              <Sparkles size={13} />
              {cloudAgentBusy
                ? "正在创建 Agent 会话…"
                : cloudAgentMode
                  ? htmlAgentSelected ? "生成 HTML 排版" : "交给 Agent 规划"
                  : agentZBusy
                ? "正在投递到 Agent…"
                : agentZMode
                  ? "发送到 Agent Z"
                  : agentGMode
                    ? "发送到 Agent G"
                    : agentDsBusy
                      ? "Agent DS 处理中…"
                      : agentDsMode
                        ? "发送给 Agent DS"
                        : agentBusy
                          ? "Agent 正在整理意图…"
                          : "生成图像"}
            </span>
          </button>
        </div>
        {cloudAgentMode && (
          <p className="mt-1.5 text-[10px] leading-4 text-muted">
            隐私说明：本次文字和所选参考图会加密上传至 Bowerbird Cloud，仅用于规划与执行。输入和过程内容通常最长保留 24 小时，最终结果最长保留 7 天；取消会停止后续调用，已上传副本仍按上述期限清理。接受后的图片保存到本地素材库，其余素材和本地数据库不会上传。
          </p>
        )}
      </section>
    </div>
  );
}
