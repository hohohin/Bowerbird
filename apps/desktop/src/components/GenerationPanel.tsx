import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "../store";
import type { GenTurn } from "../lib/types";

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
  const genLastRefs = useStore((s) => s.genLastRefs);
  const codexHealth = useStore((s) => s.codexHealth);
  const setGenPanelOpen = useStore((s) => s.setGenPanelOpen);
  const sendGenRevise = useStore((s) => s.sendGenRevise);
  const cancelGeneration = useStore((s) => s.cancelGeneration);
  const startGeneration = useStore((s) => s.startGeneration);

  const [revise, setRevise] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const imageCount = useMemo(
    () => genTurns.reduce((n, t) => n + t.images.length, 0),
    [genTurns]
  );

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
    void startGeneration(genLastPrompt, genLastRefs);
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-canvas">
      <div className="flex shrink-0 items-center justify-between border-b border-edge bg-panel px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">🖼 生成结果</span>
          {genTurns.length > 0 && (
            <span className="text-xs text-muted">
              {genTurns.length} 轮 · {imageCount} 图
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
            {genTurns.map((t, i) => (
              <TurnView
                key={t.id}
                turn={t}
                index={i}
                busy={generating && i === genTurns.length - 1}
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
      </div>
    </div>
  );
}

function TurnView({ turn, index, busy }: { turn: GenTurn; index: number; busy: boolean }) {
  return (
    <div className="space-y-1.5 rounded bg-panel2/50 p-3">
      <div className="line-clamp-2 text-xs text-muted" title={turn.prompt}>
        <span className="text-accent">{index === 0 ? "首版" : `修改 ${index}`}：</span>
        {turn.prompt}
      </div>
      {turn.images.length > 0 ? (
        <div className={`grid gap-1.5 ${turn.images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
          {turn.images.map((p) => (
            <a
              key={p}
              href={convertFileSrc(p)}
              target="_blank"
              rel="noreferrer"
              title="点击查看原图"
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
            </a>
          ))}
        </div>
      ) : busy ? (
        <div className="text-[10px] animate-pulse text-muted">codex 生成中…</div>
      ) : null}
    </div>
  );
}
