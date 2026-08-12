import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";

/**
 * codex 状态指示器（一个可点击的圆），挂在顶部工具栏最右侧。
 *
 * 四态（视觉）：
 * - 空闲：静态圆环
 * - 反推中：圆环旋转（有排队时环内嵌实心圆 + 队列数）
 * - 生成中：六格 pulse loader（uiverse spotty-starfish-76）
 * - 导入基础分析中：旋转环
 *
 * 点击圆 → 弹出会话管理 popover（上下两区）：
 * - 上区「生成任务」：genJobOrder 每个 job 一行，点击 → 打开 GenerationPanel 并选中该 job。
 * - 下区「反推任务」：运行、排队与当前会话失败项；失败项展示原因并可重试/清除。
 * 取代此前 Toolbar 的「🖼 生成结果」按钮（入口统一到这里）；该按钮原有的未读红点转移到圆上。
 *
 * 状态全部来自全局 store：反推（describingId / describingName / describeQueue）、生成（generating /
 * genJobs / genJobOrder / genUnread / genPanelOpen）、导入即基础分析（autoAnalyzing）。
 */
const PANEL_WIDTH = 288;
const PANEL_MAX_HEIGHT = 420;

function providerLabel(provider?: string | null): string {
  if (provider === "jimeng") return "即梦";
  if (provider === "bowerbird-cloud") return "云端";
  return "codex";
}

export function CodexStatus() {
  const generating = useStore((s) => s.generating);
  const describingId = useStore((s) => s.describingId);
  const describingName = useStore((s) => s.describingName);
  const queue = useStore((s) => s.describeQueue);
  const failures = useStore((s) => s.describeFailures);
  const autoAnalyzing = useStore((s) => s.autoAnalyzing);
  const genJobOrder = useStore((s) => s.genJobOrder);
  const genJobs = useStore((s) => s.genJobs);
  const genUnread = useStore((s) => s.genUnread);
  const genPanelOpen = useStore((s) => s.genPanelOpen);
  const setActiveJob = useStore((s) => s.setActiveJob);
  const setGenPanelOpen = useStore((s) => s.setGenPanelOpen);
  const retryDescribeFailure = useStore((s) => s.retryDescribeFailure);
  const dismissDescribeFailure = useStore((s) => s.dismissDescribeFailure);

  const [panelOpen, setPanelOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelId = "codex-status-panel";

  const queueLen = queue.length;
  const describing = describingId !== null || queueLen > 0;
  // 反推或导入分析任一在跑 → 圆环旋转；队列数 badge 只反映反推队列（用户语义）。
  const analyzing = describing || autoAnalyzing > 0;

  const title = generating
    ? "生成图像中…"
    : describing
      ? queueLen > 0
        ? `反推中（队列 ${queueLen}）`
        : "反推中…"
      : autoAnalyzing > 0
        ? `导入基础分析中（${autoAnalyzing}）`
        : "空闲";

  function toggle() {
    if (panelOpen) {
      setPanelOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    const x = r ? Math.max(8, Math.min(r.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8)) : 8;
    const y = r ? Math.min(r.bottom + 6, window.innerHeight - 120) : 8;
    setPos({ x, y });
    setPanelOpen(true);
  }

  function openJob(id: string) {
    setActiveJob(id);
    setGenPanelOpen(true);
    setPanelOpen(false);
  }

  // popover 打开时：Esc 关、点外部（圈与面板之外）关。
  useEffect(() => {
    if (!panelOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPanelOpen(false);
    }
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      const panel = document.getElementById(panelId);
      if (panel?.contains(target)) return;
      setPanelOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [panelOpen]);

  const showUnreadDot = (genUnread && !genPanelOpen) || failures.length > 0;

  const jobList = genJobOrder.map((id) => genJobs[id]).filter(Boolean);
  const hasGen = jobList.length > 0;
  const hasDescribe = describingId !== null || queue.length > 0 || failures.length > 0;
  const describeCount = (describingId ? 1 : 0) + queue.length + failures.length;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title={title}
        aria-label={title}
        aria-expanded={panelOpen}
        className="relative flex cursor-pointer items-center justify-center rounded bg-transparent p-0.5 outline-none hover:bg-panel2"
      >
        {generating ? (
          <div className="codex-loader" aria-hidden>
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        ) : analyzing ? (
          <>
            <div className="absolute inset-0.5 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
            {queueLen > 0 && (
              <span className="relative flex h-3 w-3 items-center justify-center rounded-full bg-accent text-[9px] font-bold leading-none text-black">
                {queueLen}
              </span>
            )}
          </>
        ) : (
          <div className="h-5 w-5 rounded-full border-2 border-muted/50" />
        )}
        {showUnreadDot && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-400 ring-1 ring-panel" />
        )}
      </button>

      {panelOpen &&
        pos &&
        createPortal(
          <div
            id={panelId}
            className="fixed z-50 overflow-hidden rounded-lg border border-edge bg-panel shadow-lg"
            style={{ left: pos.x, top: pos.y, width: PANEL_WIDTH, maxHeight: PANEL_MAX_HEIGHT }}
          >
            {!hasGen && !hasDescribe ? (
              <div className="px-3 py-6 text-center text-xs text-muted">暂无任务</div>
            ) : (
              <div className="overflow-y-auto" style={{ maxHeight: PANEL_MAX_HEIGHT }}>
                {hasGen && (
                  <div className="border-b border-edge">
                    <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted">
                      生成任务（{jobList.length}）
                    </div>
                    <div className="p-1">
                      {jobList.map((j, i) => {
                        const imgs = j.turns.reduce((n, t) => n + t.images.length, 0);
                        const failed = j.turns.some((t) => t.error);
                        return (
                          <button
                            key={j.id}
                            type="button"
                            onClick={() => openJob(j.id)}
                            className="block w-full rounded px-2 py-1.5 text-left hover:bg-panel2"
                          >
                            <div className="flex items-center gap-1.5 text-xs text-ink">
                              <span className="text-muted">{i + 1}</span>
                              <span className="text-[10px] text-muted">{providerLabel(j.provider)}</span>
                              <span className="ml-auto">
                                {j.running ? (
                                  <span className="animate-pulse text-accent">●</span>
                                ) : failed ? (
                                  <span className="text-red-400">❌</span>
                                ) : imgs > 0 ? (
                                  <span className="text-muted">{imgs} 图</span>
                                ) : (
                                  <span className="opacity-50">·</span>
                                )}
                              </span>
                            </div>
                            {j.lastPrompt && (
                              <div className="mt-0.5 truncate text-[10px] text-muted">{j.lastPrompt}</div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {hasDescribe && (
                  <div>
                    <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted">
                      反推任务（{describeCount}）
                    </div>
                    <div className="p-1">
                      {describingId && (
                        <div className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-ink">
                          <span className="animate-pulse text-accent">●</span>
                          <span className="truncate">{describingName ?? "未知素材"}</span>
                        </div>
                      )}
                      {queue.map((q, i) => (
                        <div
                          key={`${q.assetId}-${i}`}
                          className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-muted"
                        >
                          <span>·</span>
                          <span className="truncate">{q.name}</span>
                          <span className="ml-auto text-[10px]">排队</span>
                        </div>
                      ))}
                      {failures.map((failure) => (
                        <div
                          key={failure.assetId}
                          className="rounded px-2 py-1.5 text-xs text-ink"
                        >
                          <div className="flex items-center gap-1.5">
                            <span className="text-red-400">❌</span>
                            <span className="min-w-0 flex-1 truncate">{failure.name}</span>
                            <span className="text-[10px] text-red-400">失败</span>
                          </div>
                          <div
                            className="mt-1 break-words pl-5 text-[10px] leading-4 text-red-300/90"
                            title={failure.reason}
                          >
                            {failure.reason}
                          </div>
                          <div className="mt-1 flex justify-end gap-1 pl-5">
                            <button
                              type="button"
                              onClick={() => retryDescribeFailure(failure.assetId)}
                              className="rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-panel2"
                            >
                              重试
                            </button>
                            <button
                              type="button"
                              onClick={() => dismissDescribeFailure(failure.assetId)}
                              className="rounded px-1.5 py-0.5 text-[10px] text-muted hover:bg-panel2 hover:text-ink"
                            >
                              清除
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>,
          document.body
        )}
    </>
  );
}
