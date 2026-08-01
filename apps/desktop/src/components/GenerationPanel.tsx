import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { api } from "../lib/api";
import type { GenTurn } from "../lib/types";
import { Lightbox } from "./Lightbox";

/**
 * 生成结果面板（独立于创作板）。
 *
 * 创作板只管组稿与「发送」，生成对话（轮次 + 产出图 + 流式 + 修改意见）全部落到
 * store，由本面板呈现。形态：主区覆盖层（像详情页那样盖住主区），创作板在右侧槽
 * 始终在场、可继续组下一轮稿。面板可随时打开/收起，开合都不丢对话。
 */
export function GenerationPanel() {
  const genTurns = useStore((s) => s.genTurns);
  const genStreaming = useStore((s) => s.genStreaming);
  const generating = useStore((s) => s.generating);
  const genSessionId = useStore((s) => s.genSessionId);
  const genLastPrompt = useStore((s) => s.genLastPrompt);
  const genRefAssets = useStore((s) => s.genRefAssets);

  const codexHealth = useStore((s) => s.codexHealth);
  const activeGenProvider = useStore((s) => s.activeGenProvider);
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
  // 生成图放大查看（Lightbox）：images = 各轮图拍平，index = 全局下标。
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const imageCount = useMemo(
    () => genTurns.reduce((n, t) => n + t.images.length, 0),
    [genTurns]
  );
  // 跨轮 Lightbox：把各轮图拍平成一个列表；每轮记起始 offset，点某图算出全局 index。
  const allImages = useMemo(() => genTurns.flatMap((t) => t.images), [genTurns]);
  const turnsWithOffset = useMemo(() => {
    let offset = 0;
    return genTurns.map((t) => {
      const imageOffset = offset;
      offset += t.images.length;
      return { turn: t, imageOffset };
    });
  }, [genTurns]);

  // 新结果落地时把滚动体拉到底，让最新图进视野。用标量 imageCount 作依赖——打字/流式
  // 刷字不触发；末轮 busy 占位（「codex 生成中…」）不增 imageCount，不会对着 spinner 滚。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [imageCount]);

  const canRevise = !generating && !!genSessionId && !!codexHealth?.ok;
  function doRevise() {
    if (!canRevise || !revise.trim()) return;
    void sendGenRevise(revise).then(() => setRevise(""));
  }

  function regenerate() {
    if (!genLastPrompt || !codexHealth?.ok || generating) return;
    void startGeneration(genLastPrompt, genRefAssets);
  }

  // 把当前会话首轮 prompt 登记为用途（preset）：起名 → createPreset + 刷新下拉。
  async function saveGenPreset() {
    const name = presetName.trim();
    if (!name || !genLastPrompt) return;
    try {
      await api.createPreset(name, genLastPrompt);
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
      <div className="flex shrink-0 items-center justify-between border-b border-edge bg-panel px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">🖼 生成结果</span>
          {genTurns.length > 0 && (
            <span className="text-xs text-muted">
              {genTurns.length} 轮 · {imageCount} 图
              {activeGenProvider === "jimeng" ? " · 即梦" : ""}
            </span>
          )}
        </div>
        <button
          onClick={() => setGenPanelOpen(false)}
          className="rounded px-2 py-0.5 text-muted hover:bg-panel2 hover:text-ink"
          title="收起（回到瀑布流，生成照常后台跑）"
        >
          ✕
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        {genTurns.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            尚未生成。在创作板组稿后点「✓ 发送 codex 生成」。
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {turnsWithOffset.map(({ turn, imageOffset }, i) => (
              <TurnView
                key={turn.id}
                turn={turn}
                index={i}
                busy={generating && i === turnsWithOffset.length - 1}
                imageOffset={imageOffset}
                onOpenLightbox={(g) => setLightbox({ images: allImages, index: g })}
                onRetry={retryLastGenTurn}
                canRetry={!!codexHealth?.ok && !generating}
              />
            ))}
            {genStreaming && (
              <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded bg-panel2 p-2 text-[11px] text-ink">
                {genStreaming}
              </pre>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-2 border-t border-edge bg-panel p-3">
        {generating ? (
          <button
            onClick={cancelGeneration}
            className="w-full rounded-md border border-edge bg-panel2 px-3 py-2 text-sm font-semibold text-ink hover:text-red-300"
          >
            取消生成
          </button>
        ) : genSessionId ? (
          <div className="space-y-1">
            <div className="text-[10px] text-muted">提修改意见，codex 续接同一会话编辑上一张图</div>
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
              disabled={!genLastPrompt || !codexHealth?.ok}
              title="用最近一次的 prompt + 参考图开新会话（清空上方对话）"
              className="w-full rounded-md bg-panel2 px-3 py-1.5 text-xs text-ink hover:bg-edge disabled:opacity-50"
            >
              ↻ 新会话重新生成
            </button>
          </div>
        ) : (
          <div className="text-[10px] text-muted">
            {codexHealth && !codexHealth.ok
              ? codexHealth.reason
              : "🎨 生成图在创作板点「✓ 发送 codex 生成」触发；出图后可在此提修改意见续接迭代。"}
          </div>
        )}
        {!generating && genLastPrompt && (
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
                  onClick={() => reusePromptToBoard(genLastPrompt)}
                  className="flex-1 rounded bg-panel2 px-2 py-1.5 text-xs text-ink hover:bg-edge"
                  title="把首轮 prompt + 参考图载入创作板，可在其基础上编辑后重新生成"
                >
                  📋 复用到创作板
                </button>
                <button
                  onClick={() => setSavingPreset(true)}
                  className="flex-1 rounded bg-panel2 px-2 py-1.5 text-xs text-ink hover:bg-edge"
                  title="把首轮 prompt 登记为一个用途（之后可在创作板编辑/删除）"
                >
                  {presetSaved ? "已登记 ✓" : "🔖 登记为用途"}
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
}: {
  turn: GenTurn;
  index: number;
  busy: boolean;
  imageOffset: number;
  onOpenLightbox: (globalIdx: number) => void;
  onRetry: () => void;
  canRetry: boolean;
}) {
  return (
    <div className="space-y-1.5 rounded bg-panel2/50 p-3">
      <div className="line-clamp-2 text-xs text-muted" title={turn.prompt}>
        <span className="text-accent">{index === 0 ? "首版" : `修改 ${index}`}：</span>
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
            title={canRetry ? "用同样的内容重发" : "codex 当前不可用"}
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
