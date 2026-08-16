import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { notifyError } from "../lib/notify";
import { canStartAnotherJob, canUseGenerationProvider } from "../lib/entitlement";
import type { Asset, GenJob, GenTurn } from "../lib/types";
import { Lightbox } from "./Lightbox";
import { useCreationEditor } from "./creation/useCreationEditor";
import { RatioSelect } from "./creation/RatioSelect";
import { BoardChipPreview } from "./creation/BoardChipPreview";
import { ReadonlyPrompt } from "./creation/ReadonlyPrompt";
import { Bookmark, Copy, Images, Pencil, Send, Sparkles, X } from "lucide-react";

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
  const sendGenRevise = useStore((s) => s.sendGenRevise);
  const cancelGeneration = useStore((s) => s.cancelGeneration);
  const retryLastGenTurn = useStore((s) => s.retryLastGenTurn);
  const reusePromptToBoard = useStore((s) => s.reusePromptToBoard);
  const reloadPresets = useStore((s) => s.reloadPresets);
  const runningJobCount = useStore((s) => Object.values(s.genJobs).filter((j) => j.running).length);

  const [revise, setRevise] = useState("");
  // 把当前会话首轮 prompt 登记为用途（preset）的 inline 起名态。
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetSaved, setPresetSaved] = useState(false);
  // 生成图放大查看（Lightbox）：images = activeJob 各轮图拍平，index = 全局下标。
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeJob: GenJob | null = activeJobId ? genJobs[activeJobId] ?? null : null;

  // 历史任务也必须重新读取当前权益；降级后不可通过续改/重试绕过 BYO 门控。
  const activeProvider = activeJob?.provider === "codex-cli" || !activeJob?.provider
    ? "codex"
    : activeJob.provider;
  const targetHealth = activeProvider === "jimeng"
    ? dreaminaHealth
    : activeProvider === "bowerbird-cloud"
      ? null
      : codexHealth;
  const cloudBalance = cloudEntitlement
    ? cloudEntitlement.balances.daily + cloudEntitlement.balances.sub + cloudEntitlement.balances.topup
    : 0;
  const policyAllowsProvider = canUseGenerationProvider(cloudEntitlement, activeProvider);
  const targetReady = policyAllowsProvider && (activeProvider === "bowerbird-cloud"
    ? cloudAvailable && !!cloudAuth?.logged_in && cloudBalance > 0
    : !!targetHealth?.ok);
  const lockedReason = !policyAllowsProvider
    ? "升级 Pro 解锁本机 Codex / 即梦 CLI"
    : activeProvider === "bowerbird-cloud"
      ? !cloudAuth?.logged_in
        ? "请先登录 Bowerbird Cloud"
        : cloudBalance <= 0
          ? "积分不足"
          : "Bowerbird Cloud 不可用"
      : targetHealth?.reason || "当前 provider 不可用";

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

  // 新结果落地时把滚动体拉到底，让最新图进视野。用标量 imageCount 作依赖——打字/流式
  // 刷字不触发；末轮 busy 占位（「生成中…」）不增 imageCount，不会对着 spinner 滚。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [imageCount, activeJobId]);

  const running = !!activeJob?.running;
  const canRevise = !running && !!activeJob?.sessionId && targetReady;
  function doRevise() {
    if (!canRevise || !revise.trim()) return;
    void sendGenRevise(revise, activeProvider).then(() => setRevise(""));
  }

  // 「重新编辑」：会话收起为底部编辑坞（载入首轮编辑框原文，创作板同等编辑），
  // 瀑布流露出并进入点图插 chip 模式；改完发送 = 用新组稿开新会话。
  function startEdit() {
    if (running) return;
    setGenEditing(true);
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

  // 首轮气泡下方的会话级操作（icon）：重新编辑 / 复用到创作板 / 登记为用途。
  const firstTurnActions =
    !running && activeJob?.lastPrompt ? (
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={startEdit}
            className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel2 hover:text-accent"
            title="重新编辑：会话收起为底部编辑器，点瀑布流图片可换参考图；改完发送开新会话"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={() =>
              reusePromptToBoard(activeJob!.turns[0]?.promptRaw || activeJob!.lastPrompt)
            }
            className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel2 hover:text-accent"
            title="把编辑框原文 + 参考图载入创作板，可在其基础上编辑后重新生成"
          >
            <Copy size={13} />
          </button>
          <button
            type="button"
            onClick={() => setSavingPreset(true)}
            disabled={savingPreset || presetSaved}
            className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel2 hover:text-accent disabled:opacity-40"
            title="把首轮编辑框原文登记为一个用途（之后可在创作板编辑/删除）"
          >
            <Bookmark size={13} />
          </button>
        </div>
        {savingPreset && (
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

  return (
    <>
      {genEditing && activeJob ? (
        // 重新编辑：面板收起为底部浮动编辑坞（不左右通铺，上方两角圆角），上方露出瀑布流选图。
        // 定位（-translate-x-1/2）在外层、入场动画（transform）在内层，互不覆盖。
        <div className="absolute bottom-0 left-1/2 z-10 w-[min(896px,100%)] -translate-x-1/2">
          <GenEditComposer
            job={activeJob}
            provider={activeProvider}
            targetReady={targetReady}
            lockedReason={lockedReason}
            canStart={canStartAnotherJob(cloudEntitlement, runningJobCount)}
            onExit={() => setGenEditing(false)}
          />
        </div>
      ) : (
        <div className="absolute inset-0 z-10 flex flex-col bg-canvas">
          {/* 切换过渡：从编辑坞回到会话时淡入上移 */}
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
              : activeJob.provider === "bowerbird-cloud"
                ? " · Bowerbird Cloud"
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
                actions={i === 0 ? firstTurnActions : undefined}
                variantNav={i === 0 ? variantNav : undefined}
                onOpenLightbox={(g) => setLightbox({ images: allImages, index: g })}
                onOpenRefLightbox={(r) =>
                  setLightbox({ images: refLightboxImages, index: r })
                }
                onRetry={retryLastGenTurn}
                canRetry={targetReady && !running}
                retryReason={lockedReason}
              />
            ))}
          </div>
        )}
      </div>

      {/* 底部：聊天式输入（续轮修改意见）。会话级操作（重新编辑/复用/登记）在首轮气泡下方 */}
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
            <div className="flex gap-1.5">
              <input
                value={revise}
                onChange={(e) => setRevise(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    doRevise();
                  }
                }}
                placeholder="如：背景改成白天、去掉霓虹、猫换成狗…"
                className="min-w-0 flex-1 rounded bg-panel2 px-2 py-1.5 text-xs text-ink outline-none ring-1 ring-edge focus:ring-accent"
              />
              <button
                onClick={doRevise}
                disabled={!canRevise || !revise.trim()}
                className="flex shrink-0 items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50"
              >
                <Send size={12} />
                发送
              </button>
            </div>
          </div>
        ) : (
          <div className="text-[10px] text-muted">
            {!targetReady
              ? lockedReason
              : "🎨 在创作板点「✓ 发送」开始一个生成会话；出图后可在此提修改意见续接迭代。"}
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
  onRetry: () => void;
  canRetry: boolean;
  retryReason: string;
}) {
  // 用户气泡显示编辑框原文（与右键「复用生成提示词」同一数据）；实际发送的完整文本
  // （用途注入等铺开后的 prompt）收进 thinking 式折叠，二者一致时无需折叠。
  const displayText = turn.promptRaw?.trim() ? turn.promptRaw : turn.prompt;
  const hasCompiled = !!turn.promptRaw?.trim() && turn.prompt !== turn.promptRaw;
  // 首轮有原文 + 参考图数据（可为 0 张）→ 用创作板同款节点规则只读还原（缩略图 chip + 高亮维度词），不可编辑。
  const chipView = index === 0 && !!turn.promptRaw?.trim() && !!refAssets;
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
  const viaLabel =
    turn.provider && turn.provider !== "codex-cli"
      ? turn.provider === "jimeng"
        ? "即梦"
        : turn.provider
      : null;
  const refThumbs = (refAssets ?? [])
    .map((a) => ({ src: a.thumb_path ?? a.store_path ?? "", name: a.name }))
    .filter((t) => t.src);

  return (
    <div className="flex flex-col gap-2.5">
      {/* 用户消息：右侧气泡；首轮气泡上方常驻参考图「附件」缩略图（chip 视图与纯文本回退都有，可点开放大） */}
      <div className="flex flex-col items-end gap-1.5">
        {index === 0 && refThumbs.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
            {refThumbs.map((t, j) => (
              <button
                key={t.src}
                type="button"
                onClick={() => onOpenRefLightbox?.(j)}
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
            <ReadonlyPrompt prompt={displayText} references={refAssets!} />
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
 * 会话「重新编辑」编辑坞（jimeng / gemini 式）：会话面板收起为底部条，露出的瀑布流
 * 点一下即插参考图 chip（board-asset-picked）。编辑器与创作板同款（useCreationEditor +
 * RatioSelect + BoardChipPreview），但不持久化草稿（draftKey:null，不覆盖创作板的
 * bowerbird.boardDraft）；发送 = 在**同一会话**里开新版本分支（conversationId 归组，
 * 会话面板 ←/→ 切换编辑前后），取消 = 回到会话全屏视图。
 */
function GenEditComposer({
  job,
  provider,
  targetReady,
  lockedReason,
  canStart,
  onExit,
}: {
  job: GenJob;
  provider: string;
  targetReady: boolean;
  lockedReason: string;
  canStart: boolean;
  onExit: () => void;
}) {
  const startGeneration = useStore((s) => s.startGeneration);
  const { hostRef, focus, finalPrompt, rawPrompt, references, agentPromptReferences } =
    useCreationEditor({
      draftKey: null,
    });
  // 比例初值取会话首轮的值；编辑坞内改动不持久化（创作板有自己的记忆）。
  const [ratio, setRatio] = useState<string | null>(job.lastRatio ?? null);
  const [sending, setSending] = useState(false);
  // Agent 模式（与创作板同款）：先综合原 prompt 与参考图维度编译，再发生图。
  const [agentMode, setAgentMode] = useState(false);
  const [agentAvailable, setAgentAvailable] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);

  useEffect(() => {
    api.localAgentHealth().then(setAgentAvailable).catch(() => setAgentAvailable(false));
  }, []);

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

  // 编辑器挂载（注册 board-load-prompt listener）后延一帧载入会话首轮原文 + 参考图
  // （与 reusePromptToBoard 同款事件；此时创作板已关，不会双编辑器响应）。
  useEffect(() => {
    const raw = job.turns[0]?.promptRaw || job.lastPrompt;
    const t = setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("bowerbird://board-load-prompt", {
          detail: { prompt: raw, refs: job.refAssets },
        }),
      );
    }, 0);
    return () => clearTimeout(t);
    // 仅进入编辑时载入一次（重新编辑只针对当前会话）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send() {
    if (!finalPrompt || !targetReady || !canStart || sending || agentBusy) return;
    let prompt = finalPrompt;
    if (agentMode) {
      setAgentBusy(true);
      try {
        const result = await api.localAgentCompilePrompt({
          originalPrompt: rawPrompt || finalPrompt,
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
    setSending(true);
    try {
      // 归入同一会话：conversationId 传源会话 → 新版本分支可与会话内 ←/→ 切换。
      await startGeneration(prompt, references, ratio, provider, rawPrompt, job.conversationId ?? job.id);
      onExit(); // 新版本 job 已自动选中，回到会话视图用箭头切换编辑前后
    } finally {
      setSending(false);
    }
  }

  const sendDisabled = !finalPrompt || !targetReady || !canStart || sending || agentBusy;
  const sendTitle = !targetReady
    ? lockedReason
    : !canStart
      ? "已达当前档位的并行生成上限"
      : agentMode
        ? "先由 Agent 整理意图，再生成图像（新版本归入同一会话）"
        : "发送生成（新版本归入同一会话）";

  return (
    // 浮动卡片本体：高度随内容收缩、上方两角圆角、底部贴屏；滑入动画（外层容器负责水平居中定位）。
    // dockRef 高度经 ResizeObserver 写入 --gen-dock-h，瀑布流据此留底部空隙。
    <div
      ref={dockRef}
      className="gen-dock-in w-full space-y-2 rounded-t-xl border border-b-0 border-edge bg-panel p-3 shadow-[0_-12px_32px_rgba(0,0,0,0.45)]"
    >
      <div className="flex items-center gap-2">
        <strong className="shrink-0 text-xs font-semibold text-ink">重新编辑</strong>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted">
          点上方瀑布流图片插入参考图；发送后为同一会话的新版本
        </span>
        <button
          type="button"
          onClick={onExit}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-panel2 hover:text-ink"
          title="取消编辑，回到会话"
          aria-label="取消编辑"
        >
          <X size={14} />
        </button>
      </div>
      <div className="border border-edge bg-canvas p-2">
        <div
          ref={hostRef}
          onClick={focus}
          className="creation-editor max-h-56 min-h-24 cursor-pointer overflow-y-auto border border-edge bg-panel2/40 p-2 text-sm leading-8 text-ink focus-within:border-accent"
        />
        {/* 编辑框内 chip 的交互浮层（hover 放大图/维度正文 + 点击定位瀑布流） */}
        <BoardChipPreview hostRef={hostRef} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <RatioSelect value={ratio} onChange={setRatio} />
          {/* Agent 模式开关（与创作板同款行为） */}
          <button
            type="button"
            role="switch"
            aria-checked={agentMode}
            disabled={!agentAvailable || agentBusy}
            onClick={() => setAgentMode((enabled) => !enabled)}
            title={agentAvailable ? "开启后，Agent 会先综合原 prompt 与参考图维度，再调用当前生图引擎" : "本机 Agent 暂不可用"}
            className={`flex h-7 shrink-0 items-center gap-2 rounded-[3px] border px-2.5 text-xs font-medium disabled:opacity-40 ${
              agentMode ? "border-accent bg-accent/10 text-accent" : "border-edge bg-panel2 text-muted"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${agentMode ? "bg-accent" : "bg-muted/50"}`} />
            Agent 模式
          </button>
          <span className="hidden text-[10px] text-muted md:inline">
            点瀑布流图片插入参考图，或输入 @图名
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {!targetReady && (
              <span className="max-w-48 truncate text-[10px] text-muted" title={lockedReason}>
                {lockedReason}
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
              {agentBusy ? "Agent 整理中…" : sending ? "发送中…" : "发送"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
