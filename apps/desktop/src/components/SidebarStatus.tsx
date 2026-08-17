import { useState } from "react";
import { X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { isCloudProvider } from "../lib/genProviders";
import type { GenJob } from "../lib/types";

/**
 * 侧栏状态区（原 Toolbar 右侧的 CodexStatus 圆点 + 悬浮 popover 迁移而来）。
 *
 * 圆点四态（视觉不变）：
 * - 空闲：静态圆环
 * - 反推中：圆环旋转（有排队时环内嵌实心圆 + 队列数）
 * - 生成中：六格 pulse loader（uiverse spotty-starfish-76）
 * - 导入基础分析中：旋转环
 *
 * 圆点下方是常驻内联任务区（不再悬浮）：
 * - 无任务在跑 → 收起，仅剩圆点
 * - 有任务在跑 → 自动展开，只显示在跑任务（生成 running + 反推在跑/排队）
 * - 用户点击圆点 → 展开/收起完整列表（生成全部 + 反推含失败的重试/清除）
 *
 * 生成任务行：点击 → 打开 GenerationPanel 并选中该 job；hover 出 × 删除任务记录
 * （removeGenJob 仅删前端记录，不动后端任务与已入库图片）。
 *
 * 侧栏折叠态（72px 窄轨）：只渲染圆点，点击 = 展开侧栏。
 *
 * 状态全部来自全局 store：反推（describingId / describingName / describeQueue）、生成（generating /
 * genJobs / genJobOrder / genUnread / genPanelOpen）、导入即基础分析（autoAnalyzing）。
 */
function providerLabel(provider?: string | null): string {
  if (provider === "jimeng") return "即梦";
  if (isCloudProvider(provider)) return "云端";
  return "codex";
}

export function SidebarStatus({ collapsed, onExpand }: { collapsed?: boolean; onExpand?: () => void }) {
  const generating = useStore((s) => s.generating);
  const describingId = useStore((s) => s.describingId);
  const describingName = useStore((s) => s.describingName);
  const queue = useStore((s) => s.describeQueue);
  const failures = useStore((s) => s.describeFailures);
  const autoAnalyzing = useStore((s) => s.autoAnalyzing);
  const genJobOrder = useStore((s) => s.genJobOrder);
  const genJobs = useStore((s) => s.genJobs);
  const activeJobId = useStore((s) => s.activeJobId);
  const genUnread = useStore((s) => s.genUnread);
  const genPanelOpen = useStore((s) => s.genPanelOpen);
  const setActiveJob = useStore((s) => s.setActiveJob);
  const setGenPanelOpen = useStore((s) => s.setGenPanelOpen);
  const removeGenJob = useStore((s) => s.removeGenJob);
  const retryDescribeFailure = useStore((s) => s.retryDescribeFailure);
  const dismissDescribeFailure = useStore((s) => s.dismissDescribeFailure);

  // 用户点击圆点 → 完整列表（toggle）；否则按「有在跑任务」自动展开。
  const [showAll, setShowAll] = useState(false);

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

  function openJob(id: string) {
    setActiveJob(id);
    setGenPanelOpen(true);
  }

  const showUnreadDot = (genUnread && !genPanelOpen) || failures.length > 0;

  // 生成任务按会话聚合：同 conversationId 的「重新编辑」版本分支合成一条（面板内 ←/→ 切版本）。
  type GenGroup = { key: string; jobs: GenJob[]; latest: GenJob; running: boolean };
  const genGroups: GenGroup[] = [];
  const groupByKey = new Map<string, GenGroup>();
  for (const j of genJobOrder.map((id) => genJobs[id]).filter(Boolean)) {
    const key = j.conversationId ?? j.id;
    let g = groupByKey.get(key);
    if (!g) {
      g = { key, jobs: [], latest: j, running: false };
      groupByKey.set(key, g);
      genGroups.push(g);
    }
    g.jobs.push(j);
    g.latest = j; // genJobOrder 按创建顺序 → 组内最后一个即最新版本
    g.running = g.running || j.running;
  }
  const runningGroups = genGroups.filter((g) => g.running);
  const describeRunning = describingId !== null || queue.length > 0;
  const autoExpand = runningGroups.length > 0 || describeRunning;
  const expanded = !collapsed && (showAll || autoExpand);
  // 展示的生成会话：完整模式全量，自动模式仅在跑。
  const visibleGroups = showAll ? genGroups : runningGroups;

  function dotButton(className: string) {
    return (
      <button
        type="button"
        onClick={() => (collapsed ? onExpand?.() : setShowAll((v) => !v))}
        title={collapsed ? `${title} · 展开侧栏查看` : title}
        aria-label={title}
        aria-expanded={expanded}
        className={`app-icon-button relative cursor-pointer p-1 outline-none ${className}`}
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
          <div className="h-3 w-3 rounded-full bg-lime shadow-[0_0_0_4px_rgba(217,255,82,0.08)]" />
        )}
        {showUnreadDot && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-400 ring-1 ring-panel" />
        )}
      </button>
    );
  }

  // 折叠窄轨：只有圆点，点击展开侧栏。
  if (collapsed) {
    return <div className="flex w-full justify-center py-1">{dotButton("")}</div>;
  }

  const hasDescribe = describingId !== null || queue.length > 0 || failures.length > 0;
  // 自动模式只显示在跑/排队（计数/渲染均不含失败）；完整模式全量。
  const describeCount = showAll
    ? (describingId ? 1 : 0) + queue.length + failures.length
    : (describingId ? 1 : 0) + queue.length;
  const showDescribe = showAll ? hasDescribe : describeRunning;

  // 会话行的参考图「拖影」缩略图堆：至多 5 张；前 3 张全显，多出的以低透明度叠在
  // 左后方（-space-x 重叠，像运动拖影），暗示还有更多参考图。
  function thumbStack(images: string[]) {
    if (images.length === 0) {
      return (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-edge bg-panel text-[9px] text-muted">
          🖼
        </span>
      );
    }
    const shown = images.slice(-5); // 最新在后（右侧），旧的往左叠
    const ghostFrom = Math.max(0, shown.length - 3);
    return (
      <span className="flex shrink-0 items-center -space-x-2.5">
        {shown.map((p, i) => (
          <img
            key={`${p}-${i}`}
            src={convertFileSrc(p)}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className={`h-8 w-8 shrink-0 rounded-sm border border-edge bg-panel object-cover ${
              i < ghostFrom ? (i === 0 ? "opacity-45" : "opacity-70") : ""
            }`}
            style={{ zIndex: shown.length - i }}
          />
        ))}
      </span>
    );
  }

  function genGroupRow(g: GenGroup, i: number) {
    const j = g.latest;
    // 会话标题：首轮编辑框原文首个非空行，压缩到 5 字 + 省略号。
    const firstLine =
      (j.turns[0]?.promptRaw || j.lastPrompt)
        .split("\n")
        .find((l) => l.trim())
        ?.trim() ?? "";
    const label = !firstLine ? "会话" : firstLine.length > 5 ? `${firstLine.slice(0, 5)}…` : firstLine;
    // 缩略图 = 会话建立时引用的参考图（最新版本的 refAssets，有 thumb 用 thumb）。
    const refThumbPaths = (j.refAssets ?? [])
      .map((a) => a.thumb_path ?? a.store_path ?? "")
      .filter(Boolean);
    const failed = j.turns.some((t) => t.error);
    // 点开：当前 activeJob 属于该会话则保持其版本，否则跳到最新版本。
    const activeInGroup = !!activeJobId && g.jobs.some((x) => x.id === activeJobId);
    const targetId = activeInGroup ? activeJobId! : j.id;
    return (
      <div key={g.key} className="group relative">
        <button
          type="button"
          onClick={() => openJob(targetId)}
          title={`${providerLabel(j.provider)} · ${firstLine || "会话"}`}
          className="block w-full rounded px-2 py-1.5 pr-6 text-left hover:bg-panel2"
        >
          <div className="flex items-center gap-2">
            {thumbStack(refThumbPaths)}
            <span className="min-w-0 flex-1 truncate text-xs text-ink">{label}</span>
            <span className="shrink-0">
              {g.running ? (
                <span className="animate-pulse text-accent">●</span>
              ) : failed ? (
                <span className="text-red-400">❌</span>
              ) : (
                <span className="opacity-50">·</span>
              )}
            </span>
          </div>
        </button>
        <button
          type="button"
          onClick={() => g.jobs.forEach((x) => removeGenJob(x.id))}
          title={
            g.jobs.length > 1
              ? `删除会话记录（含 ${g.jobs.length} 个版本，不影响已生成的图片）`
              : "删除任务记录（不影响已生成的图片）"
          }
          aria-label={`删除会话 ${i + 1}`}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted opacity-0 hover:bg-panel hover:text-ink focus:opacity-100 group-hover:opacity-100"
        >
          <X size={11} />
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4">
      {/* 圆点行：与右上角收起按钮同一水平中心线（top 13px / 32px 高），高度对齐 */}
      <div className="flex items-center pl-1 pr-12 -mt-[3px]">
        {dotButton("!h-8 !w-8 !min-h-8")}
      </div>
      {expanded && (
        <div className="mt-1 max-h-64 overflow-y-auto rounded bg-panel2/40">
          {visibleGroups.length === 0 && !showDescribe ? (
            <div className="px-3 py-4 text-center text-xs text-muted">暂无任务</div>
          ) : (
            <>
              {visibleGroups.length > 0 && (
                <div className="border-b border-edge">
                  <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted">
                    生成会话（{genGroups.length}）
                  </div>
                  <div className="p-1">{visibleGroups.map((g, i) => genGroupRow(g, i))}</div>
                </div>
              )}
              {showDescribe && (
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
                    {showAll &&
                      failures.map((failure) => (
                        <div key={failure.assetId} className="rounded px-2 py-1.5 text-xs text-ink">
                          <div className="flex items-center gap-1.5">
                            <span className="text-red-400">❌</span>
                            <span className="min-w-0 flex-1 truncate">{failure.name}</span>
                            <span className="text-[10px] text-red-400">失败</span>
                          </div>
                          <div className="mt-1 break-words pl-5 text-[10px] leading-4 text-red-300/90" title={failure.reason}>
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
