import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useStore, type GenEditingMode } from "../store";
import { api } from "../lib/api";
import { PRESET_FEATURE_ENABLED } from "../lib/featureFlags";
import { notifyError } from "../lib/notify";
import { canStartAnotherJob, canUseByo, canUseGenerationProvider } from "../lib/entitlement";
import { cloudProviderLabel, canonicalProviderKey, isCloudProvider, supportsAnnotationCoordinates } from "../lib/genProviders";
import type { Asset, GenJob, GenTurn } from "../lib/types";
import { Lightbox } from "./Lightbox";
import { useCreationEditor } from "./creation/useCreationEditor";
import { RatioSelect } from "./creation/RatioSelect";
import { ProviderSelect } from "./creation/ProviderSelect";
import { BoardChipPreview } from "./creation/BoardChipPreview";
import { ReadonlyPrompt } from "./creation/ReadonlyPrompt";
import { Bookmark, Copy, Images, Info, Pencil, RotateCcw, Send, Sparkles, X } from "lucide-react";

/** 生成用时格式：<60s 取整秒，否则 m:ss。 */
function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/**
 * 生成会话面板（多 job，独立于创作板）。
 *
 * 形态参考 codex / Manus 等 agent 对话：一个 GenJob = 一次会话，
 * 每轮 = 用户消息（首轮 prompt + 参考图，续轮 = 修改意见气泡）→ 助手块
 * （产出图 / 流式过程日志 / 失败重试）。面板标题随会话内容而定（首轮 prompt 首行）。
 * 会话切换/管理统一在侧栏 Status 任务区（SidebarStatus）；面板为主区覆盖层，可随时开合不丢对话。
 *
 * 底部对话框与首轮「重新编辑」共用底部编辑坞（GenEditComposer）：点击收起会话、露出
 * 瀑布流，创作板同款 ProseMirror + 工具栏（比例/provider/Agent）组稿。二者差异在发送
 * 语义——「重新编辑」开新版本分支（会话内 ←/→ 切换）；底部对话框 resume 同一 session，
 * 图片作为新一轮接在会话下方（一来一往）。
 */
export function GenerationPanel() {
  const genJobs = useStore((s) => s.genJobs);
  const genJobOrder = useStore((s) => s.genJobOrder);
  const activeJobId = useStore((s) => s.activeJobId);
  const generating = useStore((s) => s.generating);

  const codexHealth = useStore((s) => s.codexHealth);
  const dreaminaHealth = useStore((s) => s.dreaminaHealth);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudAvailable = cloudAuth?.cloud_available ?? false;
  const setGenPanelOpen = useStore((s) => s.setGenPanelOpen);
  const genEditing = useStore((s) => s.genEditing);
  const setGenEditing = useStore((s) => s.setGenEditing);
  const setActiveJob = useStore((s) => s.setActiveJob);
  const cancelGeneration = useStore((s) => s.cancelGeneration);
  const startGeneration = useStore((s) => s.startGeneration);
  const sendGenRevise = useStore((s) => s.sendGenRevise);
  const retryLastGenTurn = useStore((s) => s.retryLastGenTurn);
  const reusePromptToBoard = useStore((s) => s.reusePromptToBoard);
  const reloadPresets = useStore((s) => s.reloadPresets);
  const runningJobCount = useStore((s) => Object.values(s.genJobs).filter((j) => j.running).length);

  // 把当前会话首轮 prompt 登记为用途（preset）的 inline 起名态。
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetSaved, setPresetSaved] = useState(false);
  // 续轮「编辑」的目标轮 id（revise 坞预载该轮组稿；null = 底部对话框空编辑器开局）。
  const [editTurnId, setEditTurnId] = useState<number | null>(null);
  // 生成图放大查看（Lightbox）：images = activeJob 各轮图拍平，index = 全局下标。
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeJob: GenJob | null = activeJobId ? genJobs[activeJobId] ?? null : null;

  // 历史任务也必须重新读取当前权益；降级后不可通过续改/重试绕过 BYO 门控。
  const activeProvider = activeJob?.provider === "codex-cli" || !activeJob?.provider
    ? "codex"
    : activeJob.provider;
  const activeProviderIsCloud = isCloudProvider(activeProvider);
  const targetHealth = activeProvider === "jimeng"
    ? dreaminaHealth
    : activeProviderIsCloud
      ? null
      : codexHealth;
  const cloudBalance = cloudEntitlement
    ? cloudEntitlement.balances.daily + cloudEntitlement.balances.sub + cloudEntitlement.balances.topup
    : 0;
  const policyAllowsProvider = canUseGenerationProvider(cloudEntitlement, activeProvider);
  const targetReady = policyAllowsProvider && (activeProviderIsCloud
    ? cloudAvailable && !!cloudAuth?.logged_in && cloudBalance > 0
    : !!targetHealth?.ok);
  const lockedReason = !policyAllowsProvider
    ? "升级 Pro 解锁本机 Codex / 即梦 CLI"
    : activeProviderIsCloud
      ? !cloudAuth?.logged_in
        ? "请先登录 Bowerbird Cloud"
        : cloudBalance <= 0
          ? "积分不足"
          : "Bowerbird Cloud 不可用"
      : targetHealth?.reason || "当前 provider 不可用";
  // 重试要新开 job（版本分支），与「重新编辑」同过并行上限门。
  const canStartAnother = canStartAnotherJob(cloudEntitlement, runningJobCount);

  const imageCount = useMemo(
    () => activeJob?.turns.reduce((n, t) => n + t.images.length, 0) ?? 0,
    [activeJob]
  );
  // 跨轮 Lightbox：把 activeJob 各轮图拍平成一个列表；每轮记起始 offset，点某图算出全局 index。
  const allImages = useMemo(() => activeJob?.turns.flatMap((t) => t.images) ?? [], [activeJob]);
  const turnsWithOffset = useMemo(() => {
    if (!activeJob) return [];
    let offset = 0;
    return activeJob.turns.map((t) => {
      const imageOffset = offset;
      offset += t.images.length;
      return { turn: t, imageOffset };
    });
  }, [activeJob]);

  // 首轮参考图完整 asset：传给 TurnView——chip 视图还原参考图节点用；纯文本回退时在气泡上方展示缩略图「附件」。
  const firstRefAssets = useMemo(() => activeJob?.refAssets ?? [], [activeJob]);
  // 会话最近一次产出（最后一个有图的轮）：编辑坞左侧「上次结果」缩略图，组稿时对照参考；
  // offset = 该轮在 allImages 拍平序列中的起始下标（点开放大后可跨全轮导航）。
  const lastImageTurn = useMemo(() => {
    let found: { images: string[]; offset: number } | null = null;
    for (const { turn, imageOffset } of turnsWithOffset) {
      if (turn.images.length > 0) found = { images: turn.images, offset: imageOffset };
    }
    return found;
  }, [turnsWithOffset]);
  // 轮级「编辑」时「上次结果」= 所编辑轮**当时**的基图（其之前最后一个有图轮的产出），而非
  // 会话最新产出——与发送侧精确重放一致：编辑第 N 轮，左侧对照的就是当时的「上次结果」。
  const turnBaseImages = useMemo(() => {
    if (editTurnId == null) return null;
    const idx = activeJob?.turns.findIndex((t) => t.id === editTurnId) ?? -1;
    let found: { images: string[]; offset: number } | null = null;
    for (let i = 0; i < idx; i++) {
      const { turn, imageOffset } = turnsWithOffset[i];
      if (turn.images.length > 0) found = { images: turn.images, offset: imageOffset };
    }
    return found;
  }, [editTurnId, activeJob, turnsWithOffset]);
  // 编辑坞左侧「上次结果」：轮级编辑用该轮当时的基图；其余入口（重新编辑 / 空白续轮）
  // 用会话最新产出（新续轮自动带的就是它）。
  const dockBaseImages = editTurnId != null ? turnBaseImages : lastImageTurn;
  // 参考图「附件」点开放大：Lightbox 用原图（store_path），与产出图各自独立成组。
  const refLightboxImages = useMemo(
    () => firstRefAssets.map((a) => a.store_path).filter((p): p is string => !!p),
    [firstRefAssets]
  );

  // 会话分组（「重新编辑」的版本分支）：同 conversationId 的 job 依创建顺序排列，
  // 首条用户消息下方用 ←/→ 切换编辑前后的版本（agent 应用式）。
  const conversationKey = activeJob?.conversationId ?? activeJob?.id ?? null;
  const variantJobIds = useMemo(
    () =>
      conversationKey
        ? genJobOrder.filter((jid) => {
            const j = genJobs[jid];
            return j && (j.conversationId ?? j.id) === conversationKey;
          })
        : [],
    [genJobOrder, genJobs, conversationKey]
  );
  const variantIndex = activeJobId ? variantJobIds.indexOf(activeJobId) : -1;
  const variantNav =
    variantJobIds.length > 1 && variantIndex >= 0
      ? {
          index: variantIndex + 1,
          total: variantJobIds.length,
          onPrev: () => setActiveJob(variantJobIds[variantIndex - 1]),
          onNext: () => setActiveJob(variantJobIds[variantIndex + 1]),
        }
      : undefined;

  // 会话标题随内容而定：首轮编辑框原文的第一个非空行（悬停看全文）；无会话时回退默认名。
  const firstUserText = activeJob?.turns[0]?.promptRaw || activeJob?.turns[0]?.prompt || "";
  const sessionTitle = useMemo(() => {
    const line = firstUserText.split("\n").find((l) => l.trim());
    return line?.trim() || "生成会话";
  }, [firstUserText]);

  // 新结果落地或新轮追加时把滚动体拉到底，让最新内容进视野。用标量作依赖——打字/流式
  // 刷字不触发；turnCount 覆盖底部对话框发送：坞内发送后回会话视图（滚动体重挂载），
  // 新一轮用户气泡 + 生成中占位需滚到可见（imageCount 要等图落地才变）。
  const turnCount = activeJob?.turns.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [imageCount, turnCount, activeJobId]);

  const running = !!activeJob?.running;

  // 「重新编辑」（首轮气泡 icon）：会话收起为底部编辑坞（载入首轮编辑框原文，创作板同等编辑），
  // 瀑布流露出并进入点图插 chip 模式；改完发送 = 用新组稿开新会话（版本分支）。
  function startEdit() {
    if (running) return;
    setEditTurnId(null);
    setGenEditing("edit");
  }

  // 续轮气泡的「编辑」（与首轮同款交互，语义按对话映射）：载入**该轮**组稿（原文 + 组稿时挑的
  // 参考图）进底部编辑坞；改完发送 = 在会话下方追加新一轮（resume，原轮保留可对比）。首轮编辑
  // 的「新版本分支」形态对续轮不适用——分支 = 新会话，只有首轮组稿能开。
  function startTurnEdit(turn: GenTurn) {
    if (running) return;
    setEditTurnId(turn.id);
    setGenEditing("revise");
  }

  // 续轮气泡的「重试」（与首轮同款：原样重发该轮组稿，旧结果保留）。失败末轮走既有
  // retryLastGenTurn（移除失败轮原位顶替）；其余轮 = 追加重发——参考图**精确重放**该轮
  // 当时实际下发的完整列表（含当时的基图，非会话最新产出），prompt 原样。
  function retryTurn(turn: GenTurn) {
    if (running || !activeJob?.sessionId) return;
    const isLast = activeJob.turns[activeJob.turns.length - 1]?.id === turn.id;
    if (turn.error && isLast) {
      retryLastGenTurn();
      return;
    }
    const raw = turn.provider || activeJob.provider;
    const provider = isCloudProvider(raw)
      ? canonicalProviderKey(raw)
      : raw === "jimeng"
        ? "jimeng"
        : "codex";
    void sendGenRevise(turn.prompt, provider, {
      rawPrompt: turn.promptRaw ?? undefined,
      references: turn.refAssets,
      exactReferences: turn.refs?.length ? turn.refs : undefined,
    }).catch(console.error);
  }

  // 「重试」（首轮气泡 icon）：等价于「重新编辑」后不改内容直接发送——首轮组稿（完整 prompt +
  // 参考图 + 比例 + provider）原样重发，归入同一会话开新版本分支（会话内 ←/→ 切换、瀑布流同组轮播）。
  function retryFirstTurn() {
    if (running || !activeJob) return;
    const first = activeJob.turns[0];
    const provider = isCloudProvider(activeJob.provider)
      ? canonicalProviderKey(activeJob.provider)
      : activeJob.provider === "jimeng"
        ? "jimeng"
        : "codex";
    void startGeneration(
      first?.prompt ?? activeJob.lastPrompt,
      activeJob.refAssets,
      activeJob.lastRatio,
      provider,
      first?.promptRaw ?? undefined,
      activeJob.conversationId ?? activeJob.id,
      activeJob.sessionId ?? undefined,
    ).catch(console.error);
  }

  // 把 activeJob 首轮 prompt 登记为用途（preset）：起名 → createPreset + 刷新下拉。
  async function saveGenPreset() {
    const name = presetName.trim();
    if (!name || !activeJob?.lastPrompt) return;
    try {
      await api.createPreset(name, activeJob.lastPrompt);
      await reloadPresets();
      setSavingPreset(false);
      setPresetName("");
      setPresetSaved(true);
      setTimeout(() => setPresetSaved(false), 1500);
    } catch (e) {
      console.error("createPreset failed", e);
    }
  }

  // 首轮气泡下方的会话级操作（icon）：重新编辑 / 重试 / 复用到创作板 / 登记为用途。
  const firstTurnActions =
    !running && activeJob?.lastPrompt ? (
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={startEdit}
            className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel2 hover:text-accent"
            title="重新编辑：会话收起为底部编辑器，点瀑布流图片可换参考图；发送后为同一会话的新版本"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={retryFirstTurn}
            disabled={!targetReady || !canStartAnother}
            className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel2 hover:text-accent disabled:opacity-40"
            title={
              !targetReady
                ? lockedReason
                : !canStartAnother
                  ? "已达当前档位的并行生成上限"
                  : "重试：首轮组稿原样重发，结果作为同一会话的新版本（←/→ 切换）"
            }
          >
            <RotateCcw size={13} />
          </button>
          <button
            type="button"
            onClick={() =>
              reusePromptToBoard(
                activeJob!.turns[0]?.promptRaw || activeJob!.lastPrompt,
                undefined,
                activeJob!.dimAssets,
              )
            }
            className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel2 hover:text-accent"
            title="把编辑框原文 + 参考图载入创作板，可在其基础上编辑后重新生成"
          >
            <Copy size={13} />
          </button>
          {/* 「登记为用途」（preset）：功能未完成，随 PRESET_FEATURE_ENABLED 隐藏。 */}
          {PRESET_FEATURE_ENABLED && (
            <button
              type="button"
              onClick={() => setSavingPreset(true)}
              disabled={savingPreset || presetSaved}
              className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel2 hover:text-accent disabled:opacity-40"
              title="把首轮编辑框原文登记为一个用途（之后可在创作板编辑/删除）"
            >
              <Bookmark size={13} />
            </button>
          )}
        </div>
        {PRESET_FEATURE_ENABLED && savingPreset && (
          <div className="flex gap-1.5">
            <input
              autoFocus
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveGenPreset();
                if (e.key === "Escape") setSavingPreset(false);
              }}
              placeholder="用途名"
              className="w-32 rounded bg-panel2 px-2 py-1 text-xs text-ink outline-none ring-1 ring-edge focus:ring-accent"
            />
            <button
              onClick={saveGenPreset}
              disabled={!presetName.trim()}
              className="shrink-0 rounded bg-accent px-2 py-1 text-xs font-semibold text-black disabled:opacity-50"
            >
              保存
            </button>
            <button
              onClick={() => {
                setSavingPreset(false);
                setPresetName("");
              }}
              className="shrink-0 rounded bg-panel2 px-2 py-1 text-xs text-ink hover:bg-edge"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    ) : undefined;

  // 续轮气泡下方的轮级操作（icon，与首轮同款样式）：编辑 / 重试。复用同 job 不占并行槽，
  // 仅按 provider 健康门控重试。
  function turnActions(turn: GenTurn) {
    if (running || !activeJob?.sessionId) return undefined;
    return (
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => startTurnEdit(turn)}
          className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel2 hover:text-accent"
          title="编辑这一轮：载入该轮组稿（原文 + 参考图），改后发送 = 修改意见作为新一轮接在会话下方（原轮保留）"
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          onClick={() => retryTurn(turn)}
          disabled={!targetReady}
          className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel2 hover:text-accent disabled:opacity-40"
          title={
            !targetReady
              ? lockedReason
              : "重试：这一轮的组稿原样重发（接在会话下方，原轮保留）"
          }
        >
          <RotateCcw size={13} />
        </button>
      </div>
    );
  }

  // 会话 → 编辑坞过渡：进入坞时会话视图不瞬间卸载，先播 gen-view-out（180ms 下沉淡出，
  // 与坞的 gen-dock-in 上滑交叠）再于 200ms 后卸载。状态用「已隐藏」反逻辑且初值 false——
  // 点击进入坞的渲染帧 effect 尚未执行，凭 !sessionHidden 同帧保住会话挂载，退场动画从
  // 第一帧开始；若用「退场中」正逻辑，首帧会话即被卸载（硬切），动画只能下一帧补播。
  const [sessionHidden, setSessionHidden] = useState(false);
  useEffect(() => {
    if (!genEditing) {
      setSessionHidden(false);
      return;
    }
    const t = setTimeout(() => setSessionHidden(true), 200);
    return () => clearTimeout(t);
  }, [genEditing]);

  return (
    <>
      {(genEditing && activeJob) && (
        // 底部编辑坞（「重新编辑」/ 底部对话框共用外壳，mode 区分行为）：面板收起为底部浮动
        // 编辑卡片（不左右通铺，上方两角圆角），上方露出瀑布流选图。
        // 定位（-translate-x-1/2）在外层、入场动画（transform）在内层，互不覆盖。
        <div className="absolute bottom-0 left-1/2 z-10 w-[min(896px,100%)] -translate-x-1/2">
          <GenEditComposer
            job={activeJob}
            mode={genEditing}
            canStart={canStartAnother}
            recentImages={dockBaseImages?.images ?? []}
            onOpenRecent={(k) =>
              dockBaseImages && setLightbox({ images: allImages, index: dockBaseImages.offset + k })
            }
            preloadTurn={
              editTurnId != null
                ? activeJob.turns.find((t) => t.id === editTurnId) ?? null
                : null
            }
            onExit={() => {
              setGenEditing(null);
              setEditTurnId(null);
            }}
          />
        </div>
      )}
      {(!genEditing || !activeJob || !sessionHidden) && (
        // 会话全屏视图：进入编辑坞的 200ms 内保留挂载播退场（gen-view-out 下沉淡出，
        // pointer-events-none 让位给坞/瀑布流），从编辑坞回来时 gen-view-in 淡入上移。
        // 无 job 时即使 genEditing 也落在此分支（坞无会话可载，退回会话空态）。
        <div
          className={`absolute inset-0 z-10 flex flex-col bg-canvas ${
            genEditing && activeJob ? "gen-view-out pointer-events-none" : ""
          }`}
        >
          <div className="gen-view-in flex min-h-0 flex-1 flex-col">
      {/* 单行头部（约 38px）：图标 + 会话标题（随内容而定）+ 统计 + 关闭 */}
      <div className="flex min-h-[38px] shrink-0 items-center gap-2 border-b border-edge bg-canvas/90 px-3 py-1">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-lime/10 text-lime">
          <Images size={14} />
        </span>
        <strong
          className="min-w-0 max-w-[320px] truncate text-xs font-semibold"
          title={firstUserText || "生成会话"}
        >
          {sessionTitle}
        </strong>
        {activeJob && (
          <span className="shrink-0 rounded-full border border-edge px-2 py-0.5 text-[11px] text-muted">
            {activeJob.turns.length} 轮 · {imageCount} 图
            {activeJob.provider === "jimeng"
              ? " · 即梦"
              : isCloudProvider(activeJob.provider)
                ? ` · ${cloudProviderLabel(activeJob.provider, cloudEntitlement) ?? "Bowerbird Cloud"}`
                : ""}
          </span>
        )}
        {running && (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-lime">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lime" />
            生成中
          </span>
        )}
        <button
          onClick={() => setGenPanelOpen(false)}
          className="app-icon-button ml-auto"
          title="收起（回到瀑布流，生成照常后台跑）"
          aria-label="收起生成会话"
        >
          <X size={16} />
        </button>
      </div>
      <div className="hatch-divider" aria-hidden="true"><span /></div>

      {/* 会话主体：用户消息（右）↔ 助手产出（左），纵向时间线 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-5">
        {!activeJob || turnsWithOffset.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            尚未开始会话。在创作板组稿后点「✓ 发送」生成。
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            {turnsWithOffset.map(({ turn, imageOffset }, i) => (
              <TurnView
                key={turn.id}
                turn={turn}
                index={i}
                busy={running && i === turnsWithOffset.length - 1}
                streaming={running && i === turnsWithOffset.length - 1 ? activeJob.streaming : ""}
                imageOffset={imageOffset}
                refAssets={i === 0 ? firstRefAssets : undefined}
                actions={i === 0 ? firstTurnActions : turnActions(turn)}
                variantNav={i === 0 ? variantNav : undefined}
                onOpenLightbox={(g) => setLightbox({ images: allImages, index: g })}
                onOpenRefLightbox={(r) =>
                  setLightbox({ images: refLightboxImages, index: r })
                }
                onOpenTurnRefs={(imgs, i) => setLightbox({ images: imgs, index: i })}
                onRetry={retryLastGenTurn}
                canRetry={targetReady && !running}
                retryReason={lockedReason}
              />
            ))}
          </div>
        )}
      </div>

      {/* 底部：对话框入口（点击收起会话、露出瀑布流组稿，同「重新编辑」坞；发送 = 会话下方
          追加一轮对话）。会话级操作（重新编辑/复用/登记）在首轮气泡下方 */}
      <div className="shrink-0 border-t border-edge bg-panel p-4">
        {running ? (
          <button
            onClick={() => cancelGeneration()}
            className="w-full rounded-md border border-edge bg-panel2 px-3 py-2 text-sm font-semibold text-ink hover:text-red-300"
          >
            取消生成
          </button>
        ) : activeJob?.sessionId ? (
          <div className="space-y-1">
            {!targetReady && <div className="text-[10px] text-muted">{lockedReason}</div>}
            <button
              type="button"
              onClick={() => {
                setEditTurnId(null);
                setGenEditing("revise");
              }}
              className="w-full rounded bg-panel2 px-2.5 py-2 text-left text-xs text-muted ring-1 ring-edge transition-colors hover:text-ink hover:ring-accent"
              title="像创作板一样组稿：点瀑布流图片插入参考图；发送后图片接在会话下方"
            >
              继续对话——提修改意见（如：背景改成白天、去掉霓虹…），或点瀑布流图片加参考图
            </button>
          </div>
        ) : (
          <div className="text-[10px] text-muted">
            {!targetReady
              ? lockedReason
              : "🎨 在创作板点「✓ 发送」开始一个生成会话；出图后可在此继续对话迭代。"}
          </div>
        )}
      </div>
          </div>
        </div>
      )}
      {lightbox && (
        <Lightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndexChange={(i) => setLightbox({ ...lightbox, index: i })}
        />
      )}
      {/* generating 在此仅用于抑制空态下的提示文案（有 job 在跑时给一句反馈），核心状态走 activeJob.running。 */}
      {generating && !activeJob && !genEditing && (
        <div className="pointer-events-none absolute bottom-20 left-1/2 -translate-x-1/2 text-[10px] text-muted">
          生成中…
        </div>
      )}
    </>
  );
}

/**
 * 会话一轮：用户消息气泡（prompt + 首轮参考图附件，右侧）+ 助手块（产出图 / 流式过程 /
 * 失败重试，左侧带头像），agent 对话式时间线。
 */
function TurnView({
  turn,
  index,
  busy,
  streaming,
  imageOffset,
  refAssets,
  actions,
  variantNav,
  onOpenLightbox,
  onOpenRefLightbox,
  onOpenTurnRefs,
  onRetry,
  canRetry,
  retryReason,
}: {
  turn: GenTurn;
  index: number;
  busy: boolean;
  streaming: string;
  imageOffset: number;
  refAssets?: Asset[];
  actions?: ReactNode;
  variantNav?: { index: number; total: number; onPrev: () => void; onNext: () => void };
  onOpenLightbox: (globalIdx: number) => void;
  onOpenRefLightbox?: (refIdx: number) => void;
  /** 续轮参考图点开放大（images = 本轮 refs store_path 列表）。 */
  onOpenTurnRefs?: (images: string[], index: number) => void;
  onRetry: () => void;
  canRetry: boolean;
  retryReason: string;
}) {
  // 用户气泡显示编辑框原文（与右键「复用生成提示词」同一数据）；实际发送的完整文本
  // （用途注入等铺开后的 prompt）收进 thinking 式折叠。只要本轮有原文 + 实际发送内容
  // 就保留折叠入口——dreamina/codex CLI 直发无铺开时二者相同，也允许核对发送给引擎的
  // 完整提示词（原条件要求二者不同才显示，直发会话会缺失该 toggle）。
  const displayText = turn.promptRaw?.trim() ? turn.promptRaw : turn.prompt;
  const hasCompiled = !!turn.promptRaw?.trim() && !!turn.prompt.trim();
  // chip 气泡（创作板同款只读渲染）各轮一致：首轮参考图来自 job.refAssets（恢复链路完整
  // asset），续轮来自该轮组稿挑选（turn.refAssets，恢复/回看由历史 ref_assets 重建）。
  const chipRefs = refAssets ?? turn.refAssets;
  const chipView = !!turn.promptRaw?.trim() && !!chipRefs;
  const [expanded, setExpanded] = useState(false);
  const [showCompiled, setShowCompiled] = useState(false);
  // 生成中实时计时（完成/失败后改用 turn.durationMs，不再跳）。
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!busy || !turn.startedAt) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy, turn.startedAt]);
  const elapsedLabel = busy && turn.startedAt ? fmtDuration(now - turn.startedAt) : null;
  const durationLabel = turn.durationMs != null ? fmtDuration(turn.durationMs) : null;
  const turnEntitlement = useStore((s) => s.cloudEntitlement);
  const viaLabel =
    turn.provider && turn.provider !== "codex-cli"
      ? turn.provider === "jimeng"
        ? "即梦"
        : cloudProviderLabel(turn.provider, turnEntitlement) ?? turn.provider
      : null;
  const refThumbs = (refAssets ?? [])
    .map((a) => ({ src: a.thumb_path ?? a.store_path ?? "", name: a.name }))
    .filter((t) => t.src);
  // 各轮「附件」缩略图：首轮用完整 asset（带名称）；续轮用 turn.refs（本轮实际下发的参考图，
  // 含后端合并的上一轮产出图——发送时 started 事件回填 / 历史恢复从 meta 重建）。
  const turnRefThumbs: { src: string; name: string }[] =
    index === 0
      ? refThumbs
      : (turn.refs ?? [])
          .map((p) => ({ src: p, name: p.split(/[\\/]/).pop() ?? p }))
          .filter((t) => t.src);

  return (
    <div className="flex flex-col gap-2.5">
      {/* 用户消息：右侧气泡；各轮气泡上方常驻参考图「附件」缩略图（可点开放大）——
          续轮同样展示（用户需要看到上一轮产出图被带上了） */}
      <div className="flex flex-col items-end gap-1.5">
        {turnRefThumbs.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
            {turnRefThumbs.map((t, j) => (
              <button
                key={t.src}
                type="button"
                onClick={() =>
                  index === 0
                    ? onOpenRefLightbox?.(j)
                    : onOpenTurnRefs?.(turn.refs ?? [], j)
                }
                className="cursor-zoom-in"
                aria-label={`放大参考图 ${j + 1}`}
              >
                <img
                  src={convertFileSrc(t.src)}
                  alt={t.name}
                  draggable={false}
                  className="h-12 w-12 rounded border border-edge object-cover hover:border-accent/60"
                />
              </button>
            ))}
          </div>
        )}
        {chipView ? (
          // 只读 chip 气泡：与创作板编辑框同款节点渲染（缩略图 + 维度高亮），点击展开/收起全文。
          <div
            role="button"
            tabIndex={0}
            onClick={() => setExpanded((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setExpanded((v) => !v);
              }
            }}
            // 无 title tooltip：气泡内 chip 悬停已有各自的放大图/正文浮层，容器级「展开全文」提示是噪音；
            // 折叠态由内容截断本身暗示可点，aria-label 保留无障碍语义。
            aria-label={expanded ? "收起全文" : "展开全文"}
            className={`max-w-[85%] cursor-pointer overflow-hidden rounded-lg rounded-br-sm border border-edge bg-panel2 px-2.5 py-2 text-left text-ink transition-[max-height] ${
              expanded ? "max-h-none" : "max-h-48"
            }`}
          >
            <ReadonlyPrompt prompt={displayText} references={chipRefs!} />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "收起全文" : "展开全文"}
            className={`max-w-[85%] rounded-lg rounded-br-sm border border-edge bg-panel2 px-3 py-2 text-left text-xs leading-relaxed text-ink ${
              expanded ? "" : "line-clamp-5"
            }`}
          >
            <span className="whitespace-pre-wrap">{displayText}</span>
          </button>
        )}
        {/* 版本切换（ChatGPT 式）：编辑前后的分支同属一个会话，←/→ 切换查看 */}
        {variantNav && (
          <div className="flex items-center gap-0.5 text-[10px] text-muted">
            <button
              type="button"
              onClick={variantNav.onPrev}
              disabled={variantNav.index <= 1}
              className="flex h-5 w-5 items-center justify-center rounded hover:bg-panel2 hover:text-ink disabled:opacity-30"
              aria-label="上一个版本"
            >
              <ChevronLeft size={12} />
            </button>
            <span className="tabular-nums">
              {variantNav.index} / {variantNav.total}
            </span>
            <button
              type="button"
              onClick={variantNav.onNext}
              disabled={variantNav.index >= variantNav.total}
              className="flex h-5 w-5 items-center justify-center rounded hover:bg-panel2 hover:text-ink disabled:opacity-30"
              aria-label="下一个版本"
            >
              <ChevronRight size={12} />
            </button>
          </div>
        )}
        {/* 同一栏：左 = thinking 式折叠（实际发给 AI 的完整文本，与气泡列左对齐、toggle 前后位置不动），
            右 = 会话级操作 icon（重新编辑 / 复用到创作板 / 登记为用途） */}
        {(hasCompiled || actions) && (
          <div className="flex w-[85%] items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              {hasCompiled && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowCompiled((v) => !v)}
                    className="flex items-center gap-1 text-[10px] text-muted hover:text-accent"
                  >
                    <span className={`transition-transform ${showCompiled ? "rotate-90" : ""}`}>▸</span>
                    {showCompiled ? "收起完整提示词" : "发送的完整提示词"}
                  </button>
                  {showCompiled && (
                    <pre className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap rounded border border-edge bg-panel px-3 py-2 font-mono text-[10.5px] leading-4 text-muted">
                      {turn.prompt}
                    </pre>
                  )}
                </>
              )}
            </div>
            <div className="shrink-0">{actions}</div>
          </div>
        )}
      </div>

      {/* 助手块：左侧头像 + 产出 */}
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-lime/10 text-lime">
          <Sparkles size={13} />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          {(viaLabel || durationLabel) && (
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted">
              {viaLabel && <span>via {viaLabel}</span>}
              {durationLabel && <span>{viaLabel ? "· " : ""}用时 {durationLabel}</span>}
            </div>
          )}
          {turn.images.length > 0 ? (
            <div className={`grid gap-1.5 ${turn.images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
              {turn.images.map((p, j) => (
                // 按钮 w-fit 贴合可见图片：避免按钮占满整格导致点到图片周围背景也触发放大。
                <button
                  key={p}
                  type="button"
                  onClick={() => onOpenLightbox(imageOffset + j)}
                  className="mx-auto block w-fit cursor-zoom-in"
                  title="点击放大"
                >
                  <img
                    src={convertFileSrc(p)}
                    alt=""
                    draggable={false}
                    className={
                      turn.images.length > 1
                        ? "max-h-[200px] w-auto max-w-full rounded border border-edge"
                        : "block max-h-[320px] w-auto max-w-full rounded border border-edge"
                    }
                  />
                </button>
              ))}
            </div>
          ) : turn.error ? (
            <div className="space-y-1.5 rounded border border-red-500/40 bg-red-500/10 p-2">
              <div className="text-[11px] font-semibold text-red-300">❌ 生成失败</div>
              <pre className="whitespace-pre-wrap break-all text-[11px] text-red-200/90">{turn.error}</pre>
              <button
                onClick={onRetry}
                disabled={!canRetry}
                title={canRetry ? "用同样的内容重发" : retryReason}
                className="rounded bg-panel2 px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-edge disabled:opacity-50"
              >
                ↻ 重试
              </button>
            </div>
          ) : busy ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lime" />
                正在生成图像{elapsedLabel ? `… ${elapsedLabel}` : "…"}
              </div>
              {/* 流式过程日志（codex CLI 输出），生成期间实时滚动 */}
              {streaming && (
                <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-edge bg-panel px-2.5 py-2 font-mono text-[10.5px] leading-4 text-muted">
                  {streaming}
                </pre>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 会话底部编辑坞（jimeng / gemini 式）：会话面板收起为底部条，露出的瀑布流
 * 点一下即插参考图 chip（board-asset-picked）。编辑器与创作板同款（useCreationEditor +
 * RatioSelect + ProviderSelect + Agent 模式 + BoardChipPreview），但不持久化草稿
 * （draftKey:null，不覆盖创作板的 bowerbird.boardDraft）。两种入口：
 * - mode="edit"（首轮「重新编辑」）：载入首轮编辑框原文 + 参考图；发送 = 在**同一会话**里
 *   开新版本分支（conversationId 归组，会话面板 ←/→ 切换编辑前后）。
 * - mode="revise"（底部对话框）：空编辑器自由组稿；发送 = resume 同一 session 在会话下方
 *   追加一轮对话（一来一往），不产生版本分支。
 * 两种模式点发送都立即回会话视图（生成后台跑），取消 = 回到会话全屏视图。
 * provider 在坞内自选（初值 = 该会话的 provider）。
 */
function GenEditComposer({
  job,
  mode,
  canStart,
  recentImages,
  onOpenRecent,
  preloadTurn,
  onExit,
}: {
  job: GenJob;
  mode: GenEditingMode;
  canStart: boolean;
  // 左侧「上次结果」缩略图，组稿时对照参考：轮级编辑 = 该轮当时的基图（前一轮产出）；
  // 重新编辑 / 空白续轮 = 会话最近一次产出（最后一个有图的轮，新续轮自动带的就是它）。
  recentImages: string[];
  onOpenRecent: (index: number) => void;
  // revise 坞预载的轮（续轮「编辑」入口传入）：载入该轮组稿（原文 + 参考图）替代空编辑器
  // 开局；null = 底部对话框空编辑器。
  preloadTurn: GenTurn | null;
  onExit: () => void;
}) {
  const isRevise = mode === "revise";
  const startGeneration = useStore((s) => s.startGeneration);
  const sendGenRevise = useStore((s) => s.sendGenRevise);
  const setBoardActive = useStore((s) => s.setBoardActive);
  const activeGenProvider = useStore((s) => s.activeGenProvider);
  const setActiveGenProvider = useStore((s) => s.setActiveGenProvider);
  const defaultProvider = useStore((s) => s.defaultProvider);
  const setDefaultProvider = useStore((s) => s.setDefaultProvider);
  const codexHealth = useStore((s) => s.codexHealth);
  const dreaminaHealth = useStore((s) => s.dreaminaHealth);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudAvailable = cloudAuth?.cloud_available ?? false;
  // 底部对话框（续轮）空编辑器开局：不预填「请参考」，避免误发送占位文字。
  const {
    hostRef,
    focus,
    finalPrompt,
    rawPrompt,
    references,
    dimensionSources,
    graphSources,
    agentPromptReferences,
  } = useCreationEditor({
    draftKey: null,
    initialEmpty: isRevise,
    // 维度环点扇区插进本坞（与创作板互斥挂载，任意时刻只有一个实例消费）。
    consumePendingKeyword: true,
  });
  // 比例初值取会话首轮的值；编辑坞内改动不持久化（创作板有自己的记忆）。
  const [ratio, setRatio] = useState<string | null>(job.lastRatio ?? null);
  // Agent 方案开关（与创作板同款三态）：off = 直发；a = 方案A（子句挑选）；b = 方案B（skill 审查修复）。
  const [agentMode, setAgentMode] = useState<"off" | "a" | "b">("off");
  const [agentAvailable, setAgentAvailable] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);

  // provider 初值 = 该会话的 provider（进入编辑时同步当前选择，坞内可再切换；遗留 cloud key 归一化）。
  useEffect(() => {
    const initial = isCloudProvider(job.provider)
      ? canonicalProviderKey(job.provider)
      : job.provider === "jimeng"
        ? job.provider
        : "codex";
    setActiveGenProvider(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api.localAgentHealth().then(setAgentAvailable).catch(() => setAgentAvailable(false));
  }, []);

  // 按坞内当前选中的 provider 判健康（与创作板同款门控）。
  const cloudBalance = cloudEntitlement
    ? cloudEntitlement.balances.daily + cloudEntitlement.balances.sub + cloudEntitlement.balances.topup
    : 0;
  const cloudSelected = isCloudProvider(activeGenProvider);
  const targetReady = cloudSelected
    ? cloudAvailable && !!cloudAuth?.logged_in && cloudBalance > 0
    : activeGenProvider === "jimeng"
      ? canUseByo(cloudEntitlement) && !!dreaminaHealth?.ok
      : canUseByo(cloudEntitlement) && !!codexHealth?.ok;
  const lockedReason =
    cloudSelected
      ? !cloudAvailable
        ? "当前版本未配置 Bowerbird Cloud"
        : !cloudAuth?.logged_in
          ? "请先登录 Bowerbird Cloud"
          : cloudBalance <= 0
            ? "积分不足"
            : "Bowerbird Cloud 不可用"
      : !canUseByo(cloudEntitlement)
        ? "升级 Pro 解锁本机 Codex / 即梦 CLI"
        : (activeGenProvider === "jimeng" ? dreaminaHealth?.reason : codexHealth?.reason) ||
          "当前 provider 不可用";

  // 编辑坞高度 → CSS 变量：瀑布流滚动容器据此留出底部 padding，避免坞盖住最后一行素材。
  const dockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const apply = () =>
      document.documentElement.style.setProperty("--gen-dock-h", `${el.offsetHeight}px`);
    apply();
    const obs = new ResizeObserver(apply);
    obs.observe(el);
    return () => {
      obs.disconnect();
      document.documentElement.style.removeProperty("--gen-dock-h");
    };
  }, []);

  // 编辑器挂载（注册 board-load-prompt listener）后延一帧载入组稿（与 reusePromptToBoard 同款
  // 事件；此时创作板已关，不会双编辑器响应）。「重新编辑」载入首轮原文 + 参考图；底部对话框
  // （续轮）默认空编辑器开局只放焦点；续轮「编辑」入口（preloadTurn）载入该轮原文 + 组稿参考图。
  useEffect(() => {
    if (isRevise && !preloadTurn) {
      const f = setTimeout(() => focus(), 0);
      return () => clearTimeout(f);
    }
    const src = preloadTurn ?? null;
    const raw = src ? src.promptRaw || src.prompt : job.turns[0]?.promptRaw || job.lastPrompt;
    const refs = src ? src.refAssets ?? [] : job.refAssets;
    const t = setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("bowerbird://board-load-prompt", {
          detail: { prompt: raw, refs },
        }),
      );
    }, 0);
    return () => clearTimeout(t);
    // 仅进入编辑时载入一次（重新编辑只针对当前会话）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send() {
    // 续轮复用同 job（无新并行槽占用）；重新编辑开新 job 需过并行上限门。
    if (!finalPrompt || !targetReady || agentBusy || (!isRevise && !canStart)) return;
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
    // 点发送立即回会话视图：生成后台跑，结果/错误由会话内对应轮展示。
    // 发送即退出创作模式（boardOpen 置 false）：关面板回瀑布流后左键恢复开详情；
    // 取消编辑不退（onExit 另有取消入口共用，创作模式保留可继续挑图）。
    setBoardActive(false);
    onExit();
    if (isRevise) {
      // 会话下方追加一轮对话（resume 同一 session）；新挑参考图随 opts 传给续轮路径。
      // 轮级「编辑」预载的发送 = 精确重放：基图固定为该轮**当时**自动带入的参考图
      // （turn.refs 去掉当时 chips 的部分），与编辑器当前 chips 合成完整列表——编辑第 N
      // 轮时基图仍是第 N 轮的基图，不会漂移成会话最新产出。
      const exactRefs = preloadTurn?.refs?.length
        ? Array.from(
            new Set([
              ...preloadTurn.refs.filter(
                (p) => !(preloadTurn.refAssets ?? []).some((a) => a.store_path === p),
              ),
              ...references.map((r) => r.store_path).filter((p): p is string => !!p),
            ]),
          ).slice(0, 10)
        : undefined;
      void sendGenRevise(prompt, activeGenProvider, {
        rawPrompt,
        references,
        ratio,
        exactReferences: exactRefs,
      }).catch(console.error);
    } else {
      // 归入同一会话：conversationId 传源会话 → 新版本分支可与会话内 ←/→ 切换；
      // anchorSessionId = 源会话 session（旧版生成 / 回看历史的根 session 补映射用）。
      // 纯新构图：不带上一轮产出（回退只留给「继续对话」续轮路径）。
      void startGeneration(
        prompt,
        references,
        ratio,
        activeGenProvider,
        rawPrompt,
        job.conversationId ?? job.id,
        job.sessionId ?? undefined,
        dimensionSources,
      ).catch(console.error);
    }
  }

  const sendDisabled = !finalPrompt || !targetReady || agentBusy || (!isRevise && !canStart);
  const hasAnnotationDimension = graphSources.some((source) =>
    source.dimensions.some((title) => title === "标注" || title === "标记")
  );
  const annotationWarning =
    hasAnnotationDimension && !supportsAnnotationCoordinates(activeGenProvider);
  const sendTitle = !targetReady
    ? lockedReason
    : !isRevise && !canStart
      ? "已达当前档位的并行生成上限"
      : isRevise
        ? agentMode !== "off"
          ? `先由 Agent（${agentMode === "a" ? "方案A" : "方案B"}）整理意图，再生成图像（接在会话下方）`
          : "发送生成（图片接在会话下方，续接同一会话）"
        : agentMode !== "off"
          ? `先由 Agent（${agentMode === "a" ? "方案A" : "方案B"}）整理意图，再生成图像（新版本归入同一会话）`
          : "发送生成（新版本归入同一会话）";

  // 会话指示器标题：与面板头部同源（首轮原文第一个非空行）。
  const firstUserText = job.turns[0]?.promptRaw || job.turns[0]?.prompt || "";
  const sessionTitle =
    firstUserText.split("\n").find((l) => l.trim())?.trim() || "生成会话";

  return (
    // 浮动卡片本体：与创作板 creation-dock 同款形态（底部浮动、上方两角圆角、毛玻璃），
    // 配色深灰蓝（.session-dock）区分会话上下文。高度随内容收缩；dockRef 高度经
    // ResizeObserver 写入 --gen-dock-h，瀑布流据此留底部空隙。
    <div ref={dockRef} className="gen-dock-in session-dock w-full rounded-t-2xl p-2.5 pb-2">
      <div className="flex items-start gap-2.5">
        {/* 左侧「上次结果」缩略图：露瀑布流选图的同时对照会话最近产出编辑/续写；点击放大。 */}
        {recentImages.length > 0 && (
          <div className="flex w-[104px] shrink-0 flex-col gap-1.5">
            <span className="text-[10px] text-muted">上次结果</span>
            {recentImages.slice(0, 4).map((p, k) => (
              <button
                key={p}
                type="button"
                onClick={() => onOpenRecent(k)}
                className="block w-fit cursor-zoom-in"
                aria-label={`放大上次结果 ${k + 1}`}
              >
                <img
                  src={convertFileSrc(p)}
                  alt=""
                  draggable={false}
                  className="w-full rounded border border-edge hover:border-accent/60"
                />
              </button>
            ))}
            {recentImages.length > 4 && (
              <span className="text-[10px] text-muted">+{recentImages.length - 4} 张</span>
            )}
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-2">
      {/* 顶部指示器：会话名截断（悬停看全名），「…… 任务中，新的生成会纳为该任务的结果」
          后缀固定贴在关闭按钮左侧——长会话名被截断也不会把提示字样挤掉。 */}
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full bg-[#7c9cff]" aria-hidden="true" />
        <strong className="shrink-0 text-xs font-semibold text-ink">
          {isRevise ? "继续对话" : "重新编辑"}
        </strong>
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-muted"
          title={`当前在「${sessionTitle}」任务中，新的生成会纳为该任务的结果`}
        >
          当前在「{sessionTitle}」
        </span>
        <span className="shrink-0 text-[11px] text-muted">
          任务中，新的生成会纳为该任务的结果
        </span>
        <button
          type="button"
          onClick={onExit}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-white/10 hover:text-ink"
          title="取消编辑，回到会话"
          aria-label="取消编辑"
        >
          <X size={14} />
        </button>
      </div>
      <div
        ref={hostRef}
        onClick={focus}
        data-tour="creation-editor"
        className="creation-editor min-h-16 max-h-56 cursor-text overflow-y-auto rounded-lg bg-black/30 px-3 py-2 text-sm leading-8 text-ink focus-within:ring-1 focus-within:ring-accent/70"
      />
      {/* 编辑框内 chip 的交互浮层（hover 放大图/维度正文 + 点击定位瀑布流） */}
      <BoardChipPreview hostRef={hostRef} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
          <RatioSelect value={ratio} onChange={setRatio} />
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
          {/* Agent 方案开关（A/B 互斥，与创作板同款）：仅本机 Agent 可用时渲染——
              release 包中 health 命令被后端门控拒绝，开关不出现。 */}
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
          <span className="hidden text-[10px] text-muted md:inline">
            点瀑布流图片插入参考图，或输入 @图名
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {!targetReady && (
              <span className="max-w-48 truncate text-[10px] text-muted" title={lockedReason}>
                {lockedReason}
              </span>
            )}
            {annotationWarning && (
              <span className="flex shrink-0 items-center text-red-400" title="该模型不支持标注参数，标注图可以被发送，但控制效果可能不及预期。">
                <Info size={14} aria-label="该模型不支持标注参数，标注图可以被发送，但控制效果可能不及预期。" />
              </span>
            )}
            <button
              type="button"
              onClick={onExit}
              className="rounded bg-panel2 px-3 py-1.5 text-xs text-ink hover:bg-edge"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void send()}
              disabled={sendDisabled}
              title={sendTitle}
              className="flex items-center gap-1.5 rounded bg-accent px-4 py-1.5 text-xs font-semibold text-black disabled:opacity-50"
            >
              <Send size={12} />
              {agentBusy ? "Agent 整理中…" : "发送"}
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
