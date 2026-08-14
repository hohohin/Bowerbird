import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { api } from "../lib/api";
import { canUseGenerationProvider } from "../lib/entitlement";
import type { GenJob, GenTurn } from "../lib/types";
import { Lightbox } from "./Lightbox";
import { Bookmark, Copy, Images, RotateCcw, Sparkles, X } from "lucide-react";

/**
 * 生成结果面板（多 job，独立于创作板）。
 *
 * 创作板只管组稿与「发送」，生成会话（一个 GenJob = 首轮 + 续轮 turn 链）全部落到 store。
 * 会话切换/管理统一在侧栏 Status 任务区（SidebarStatus）；主区展示 activeJob 的时间线 / 流式 / 续轮 / 复用。
 * 形态：主区覆盖层（像详情页那样盖住主区），创作板在右侧槽始终在场。面板可随时打开/收起，不丢对话。
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
      {/* 单行头部（约 38px）：图标 + 标题 + 统计 + 关闭 */}
      <div className="flex min-h-[38px] shrink-0 items-center gap-2 border-b border-edge bg-canvas/90 px-3 py-1">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-lime/10 text-lime">
          <Images size={14} />
        </span>
        <strong className="text-xs font-semibold">生成结果</strong>
        {activeJob && (
          <span className="rounded-full border border-edge px-2 py-0.5 text-[11px] text-muted">
            {activeJob.turns.length} 轮 · {imageCount} 图
            {activeJob.provider === "jimeng"
              ? " · 即梦"
              : activeJob.provider === "bowerbird-cloud"
                ? " · Bowerbird Cloud"
                : ""}
          </span>
        )}
        <button
          onClick={() => setGenPanelOpen(false)}
          className="app-icon-button ml-auto"
          title="收起（回到瀑布流，生成照常后台跑）"
          aria-label="收起生成结果"
        >
          <X size={16} />
        </button>
      </div>
      <div className="hatch-divider" aria-hidden="true"><span /></div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-5">
        {!activeJob ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            尚未生成。在创作板组稿后点「✓ 发送」生成。
          </div>
        ) : turnsWithOffset.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            尚未生成。在创作板组稿后点「✓ 发送」生成。
          </div>
        ) : (
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            {turnsWithOffset.map(({ turn, imageOffset }, i) => (
              <TurnView
                key={turn.id}
                turn={turn}
                index={i}
                busy={running && i === turnsWithOffset.length - 1}
                imageOffset={imageOffset}
                onOpenLightbox={(g) => setLightbox({ images: allImages, index: g })}
                onRetry={retryLastGenTurn}
                canRetry={targetReady && !running}
                retryReason={lockedReason}
              />
            ))}
            {activeJob.streaming && (
              <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded bg-panel2 p-2 text-[11px] text-ink">
                {activeJob.streaming}
              </pre>
            )}
          </div>
        )}
      </div>

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
                className="shrink-0 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50"
              >
                继续修改
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
              : "🎨 生成图在创作板点「✓ 发送」触发；出图后可在此提修改意见续接迭代。"}
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
                  onClick={() => reusePromptToBoard(activeJob!.lastPrompt)}
                  className="flex-1 rounded bg-panel2 px-2 py-1.5 text-xs text-ink hover:bg-edge"
                  title="把首轮 prompt + 参考图载入创作板，可在其基础上编辑后重新生成"
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

function TurnView({
  turn,
  index,
  busy,
  imageOffset,
  onOpenLightbox,
  onRetry,
  canRetry,
  retryReason,
}: {
  turn: GenTurn;
  index: number;
  busy: boolean;
  imageOffset: number;
  onOpenLightbox: (globalIdx: number) => void;
  onRetry: () => void;
  canRetry: boolean;
  retryReason: string;
}) {
  return (
    <div className="lineframe-panel space-y-2 border border-edge bg-panel/80 p-4">
      <div className="line-clamp-2 text-xs text-muted" title={turn.prompt}>
        <span className="mr-1 inline-flex items-center gap-1 text-accent-soft">
          <Sparkles size={11} />
          {index === 0 ? "首版" : `修改 ${index}`}：
        </span>
        {turn.prompt}
        {turn.provider && turn.provider !== "codex-cli" && (
          <span className="ml-1 text-[10px] opacity-70">
            via {turn.provider === "jimeng" ? "即梦" : turn.provider}
          </span>
        )}
      </div>
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
        <div className="text-[10px] animate-pulse text-muted">生成中…</div>
      ) : null}
    </div>
  );
}
