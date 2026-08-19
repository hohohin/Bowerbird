import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { canStartAnotherJob, canUseByo } from "../lib/entitlement";
import { cloudProviderLabel, isCloudProvider, supportsAnnotationCoordinates } from "../lib/genProviders";
import { api } from "../lib/api";
import { PRESET_FEATURE_ENABLED } from "../lib/featureFlags";
import { notifyError, notifySuccess } from "../lib/notify";
import { useCreationEditor } from "./creation/useCreationEditor";
import { RATIOS } from "./creation/ratios";
import { RatioSelect } from "./creation/RatioSelect";
import { ProviderSelect } from "./creation/ProviderSelect";
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

  // consumePendingKeyword：本板是维度环点选（pendingKeyword）的唯一消费方（编辑坞不抢）。
  // initialEmpty：空文档开局（配 is-empty 占位「描述你的意图，开始创作吧」；有草稿仍恢复），
  // 取代旧「请参考」预填——提示职责交给占位文字。
  const {
    hostRef,
    focus,
    finalPrompt,
    rawPrompt,
    references,
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
  const activePreset = useMemo(
    () => presets.find((p) => p.id === activePresetId) ?? null,
    [presets, activePresetId]
  );

  useEffect(() => {
    api.localAgentHealth().then(setAgentAvailable).catch(() => setAgentAvailable(false));
  }, []);

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
  const targetProviderLabel = isCloudProvider(activeGenProvider)
    ? (cloudProviderLabel(activeGenProvider, cloudEntitlement) ?? "Bowerbird Cloud")
    : activeGenProvider === "jimeng"
      ? "即梦"
      : "codex";
  const hasAnnotationDimension = graphSources.some((source) =>
    source.dimensions.some((title) => title === "标注" || title === "标记")
  );
  const annotationWarning =
    hasAnnotationDimension && !supportsAnnotationCoordinates(activeGenProvider);

  // 把当前组稿发 provider 生成。生成期间编辑器仍可继续组下一轮稿（prompt 在此快照进 store）。
  // provider 由 store 内 activeGenProvider 兜底（send 不显式传）。
  async function send() {
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
    await startGeneration(prompt, references, ratio, undefined, rawPrompt);
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
          <RatioSelect value={ratio} onChange={selectRatio} />
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
          {agentAvailable && (
            <>
              <button
                type="button"
                role="switch"
                aria-checked={agentMode === "a"}
                disabled={agentBusy}
                onClick={() => setAgentMode((mode) => (mode === "a" ? "off" : "a"))}
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
              <button
                type="button"
                role="switch"
                aria-checked={agentMode === "b"}
                disabled={agentBusy}
                onClick={() => setAgentMode((mode) => (mode === "b" ? "off" : "b"))}
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
            </>
          )}
          {!targetReady && (
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
            disabled={agentBusy || !finalPrompt || !targetReady || !canStartAnotherJob(cloudEntitlement, runningJobCount)}
            title={
              !targetReady
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
              {agentBusy ? "Agent 正在整理意图…" : `发送 ${targetProviderLabel} 生成`}
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}
