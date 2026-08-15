import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { api } from "../lib/api";
import { canUseGenerationProvider } from "../lib/entitlement";
import type { GenJob, GenTurn } from "../lib/types";
import { Lightbox } from "./Lightbox";
import { Bookmark, Copy, Images, RotateCcw, Send, Sparkles, X } from "lucide-react";

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
  const activeJobId = useStore((s) => s.activeJobId);
  const generating = useStore((s) => s.generating);

  const codexHealth = useStore((s) => s.codexHealth);
  const dreaminaHealth = useStore((s) => s.dreaminaHealth);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudAvailable = cloudAuth?.cloud_available ?? false;
  const setGenPanelOpen = useStore((s) => s.setGenPanelOpen);
  const sendGenRevise = useStore((s) => s.sendGenRevise);
  const cancelGeneration = useStore((s) => s.cancelGeneration);
  const startGeneration = useStore((s) => s.startGeneration);
  const retryLastGenTurn = useStore((s) => s.retryLastGenTurn);
  const reusePromptToBoard = useStore((s) => s.reusePromptToBoard);
  const reloadPresets = useStore((s) => s.reloadPresets);

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
  const targetProviderLabel = activeJob?.provider === "jimeng"
    ? "即梦"
    : activeJob?.provider === "bowerbird-cloud"
      ? "Bowerbird Cloud"
      : "codex";

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

  // 首轮参考图缩略图（用户消息的「附件」）：第一轮气泡上方展示。
  const firstRefThumbs = useMemo(
    () =>
      (activeJob?.refAssets ?? [])
        .map((a) => ({ src: a.thumb_path ?? a.store_path ?? "", name: a.name }))
        .filter((t) => t.src),
    [activeJob]
  );

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

  function regenerate() {
    if (!activeJob?.lastPrompt || !targetReady || running) return;
    void startGeneration(activeJob.lastPrompt, activeJob.refAssets, activeJob.lastRatio, activeProvider);
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

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-canvas">
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
                refThumbs={i === 0 ? firstRefThumbs : undefined}
                onOpenLightbox={(g) => setLightbox({ images: allImages, index: g })}
                onRetry={retryLastGenTurn}
                canRetry={targetReady && !running}
                retryReason={lockedReason}
              />
            ))}
          </div>
        )}
      </div>

      {/* 底部：聊天式输入（续轮）+ 会话级操作 */}
      <div className="shrink-0 space-y-2 border-t border-edge bg-panel p-4">
        {running ? (
          <button
            onClick={() => cancelGeneration()}
            className="w-full rounded-md border border-edge bg-panel2 px-3 py-2 text-sm font-semibold text-ink hover:text-red-300"
          >
            取消生成
          </button>
        ) : activeJob?.sessionId ? (
          <div className="space-y-1">
            <div className="text-[10px] text-muted">
              {targetReady
                ? `提修改意见，${targetProviderLabel} 续接同一会话编辑上一张图`
                : lockedReason}
            </div>
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
            <button
              onClick={regenerate}
              disabled={!activeJob?.lastPrompt || !targetReady}
              title={targetReady ? "用最近一次的 prompt + 参考图开新会话（新建一个生成任务）" : lockedReason}
              className="w-full rounded-md bg-panel2 px-3 py-1.5 text-xs text-ink hover:bg-edge disabled:opacity-50"
            >
              <span className="flex items-center justify-center gap-2"><RotateCcw size={13} />新会话重新生成</span>
            </button>
          </div>
        ) : (
          <div className="text-[10px] text-muted">
            {!targetReady
              ? lockedReason
              : "🎨 在创作板点「✓ 发送」开始一个生成会话；出图后可在此提修改意见续接迭代。"}
          </div>
        )}
        {!running && activeJob?.lastPrompt && (
          <div className="space-y-1.5 border-t border-edge pt-2">
            {savingPreset ? (
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
                  className="min-w-0 flex-1 rounded bg-panel2 px-2 py-1 text-xs text-ink outline-none ring-1 ring-edge focus:ring-accent"
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
            ) : (
              <div className="flex gap-1.5">
                <button
                  onClick={() =>
                    reusePromptToBoard(activeJob!.turns[0]?.promptRaw || activeJob!.lastPrompt)
                  }
                  className="flex-1 rounded bg-panel2 px-2 py-1.5 text-xs text-ink hover:bg-edge"
                  title="把编辑框原文 + 参考图载入创作板，可在其基础上编辑后重新生成"
                >
                  <span className="flex items-center justify-center gap-2"><Copy size={13} />复用到创作板</span>
                </button>
                <button
                  onClick={() => setSavingPreset(true)}
                  className="flex-1 rounded bg-panel2 px-2 py-1.5 text-xs text-ink hover:bg-edge"
                  title="把首轮 prompt 登记为一个用途（之后可在创作板编辑/删除）"
                >
                  <span className="flex items-center justify-center gap-2"><Bookmark size={13} />{presetSaved ? "已登记" : "登记为用途"}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {lightbox && (
        <Lightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndexChange={(i) => setLightbox({ ...lightbox, index: i })}
        />
      )}
      {/* generating 在此仅用于抑制空态下的提示文案（有 job 在跑时给一句反馈），核心状态走 activeJob.running。 */}
      {generating && !activeJob && (
        <div className="pointer-events-none absolute bottom-20 left-1/2 -translate-x-1/2 text-[10px] text-muted">
          生成中…
        </div>
      )}
    </div>
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
  refThumbs,
  onOpenLightbox,
  onRetry,
  canRetry,
  retryReason,
}: {
  turn: GenTurn;
  index: number;
  busy: boolean;
  streaming: string;
  imageOffset: number;
  refThumbs?: { src: string; name: string }[];
  onOpenLightbox: (globalIdx: number) => void;
  onRetry: () => void;
  canRetry: boolean;
  retryReason: string;
}) {
  // 用户气泡显示编辑框原文（与右键「复用生成提示词」同一数据）；实际发送的完整文本
  // （用途注入等铺开后的 prompt）收进 thinking 式折叠，二者一致时无需折叠。
  const displayText = turn.promptRaw?.trim() ? turn.promptRaw : turn.prompt;
  const hasCompiled = !!turn.promptRaw?.trim() && turn.prompt !== turn.promptRaw;
  const [expanded, setExpanded] = useState(false);
  const [showCompiled, setShowCompiled] = useState(false);
  const viaLabel =
    turn.provider && turn.provider !== "codex-cli"
      ? turn.provider === "jimeng"
        ? "即梦"
        : turn.provider
      : null;

  return (
    <div className="flex flex-col gap-2.5">
      {/* 用户消息：右侧气泡；首轮上方展示参考图「附件」 */}
      <div className="flex flex-col items-end gap-1.5">
        {index === 0 && refThumbs && refThumbs.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
            {refThumbs.map((t) => (
              <img
                key={t.src}
                src={convertFileSrc(t.src)}
                alt={t.name}
                title={t.name}
                className="h-12 w-12 rounded border border-edge object-cover"
              />
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "收起" : "展开全文"}
          className={`max-w-[85%] rounded-lg rounded-br-sm border border-edge bg-panel2 px-3 py-2 text-left text-xs leading-relaxed text-ink ${
            expanded ? "" : "line-clamp-5"
          }`}
        >
          <span className="whitespace-pre-wrap">{displayText}</span>
        </button>
        {/* thinking 式折叠：实际发给生图 AI 的完整文本 */}
        {hasCompiled && (
          <div className="max-w-[85%] space-y-1.5">
            <button
              type="button"
              onClick={() => setShowCompiled((v) => !v)}
              className="flex items-center gap-1 text-[10px] text-muted hover:text-accent"
            >
              <span className={`transition-transform ${showCompiled ? "rotate-90" : ""}`}>▸</span>
              {showCompiled ? "收起完整提示词" : "发送的完整提示词"}
            </button>
            {showCompiled && (
              <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded border border-edge bg-panel px-3 py-2 font-mono text-[10.5px] leading-4 text-muted">
                {turn.prompt}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* 助手块：左侧头像 + 产出 */}
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-lime/10 text-lime">
          <Sparkles size={13} />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          {viaLabel && (
            <div className="text-[10px] uppercase tracking-wide text-muted">via {viaLabel}</div>
          )}
          {turn.images.length > 0 ? (
            <div className={`grid gap-1.5 ${turn.images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
              {turn.images.map((p, j) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onOpenLightbox(imageOffset + j)}
                  className="cursor-zoom-in"
                  title="点击放大"
                >
                  <img
                    src={convertFileSrc(p)}
                    alt=""
                    className={
                      turn.images.length > 1
                        ? "w-full max-h-[200px] rounded border border-edge object-contain"
                        : "block mx-auto max-h-[320px] w-auto max-w-full rounded border border-edge object-contain"
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
                正在生成图像…
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
