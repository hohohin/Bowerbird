import { useEffect, useRef, useState, type Ref } from "react";
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
 * 圆点下方是常驻内联任务区（自动浮现、自动消失，只反映在跑任务）：
 * - 无任务在跑 → 收起，仅剩圆点
 * - 有任务在跑 → 自动展开（生成 running + 反推在跑/排队）
 *
 * 点击圆点 → 悬浮会话面板（status-session-panel）：像对话气泡挂在圆点右侧——
 * 左上角与圆点相接、与侧栏同高（顶接圆点、底到窗口底），面板右上是「生成 / 反推」
 * 切换。生成 tab 列全部会话（最新在前，点击进 GenerationPanel）；反推 tab 含在跑/
 * 排队 + 失败重试/清除。再点圆点 / Esc / 点击面板外收回，收回播退场动画后卸载。
 *
 * 生成会话行：点击 → 打开 GenerationPanel 并选中该 job；hover 出 × 删除任务记录
 * （removeGenJob 仅删前端记录，不动后端任务与已入库图片）。
 *
 * 侧栏折叠态（72px 窄轨）：只渲染圆点 + 悬浮会话面板——点击圆点直接弹面板
 * （左缘挂窄轨右缘），不展开侧栏。
 *
 * 状态全部来自全局 store：反推（describingId / describingName / describeQueue）、生成（generating /
 * genJobs / genJobOrder / genUnread / genPanelOpen）、导入即基础分析（autoAnalyzing）。
 */
function providerLabel(provider?: string | null): string {
  if (provider === "jimeng") return "即梦";
  if (isCloudProvider(provider)) return "云端";
  return "codex";
}

export function SidebarStatus({ collapsed }: { collapsed?: boolean }) {
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

  // 悬浮会话面板：开态 + 锚点（圆点矩形，开时测量；窗口/侧栏尺寸变化重测）。
  const ringRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [sessOpen, setSessOpen] = useState(false);
  const [closing, setClosing] = useState(false); // 播收回动画中（播完才真正卸载）
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const [tab, setTab] = useState<"gen" | "describe">("gen");

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

  function measureRing() {
    const r = ringRef.current?.getBoundingClientRect();
    if (!r) return;
    // 折叠态圆点在窄轨居中，按圆点右缘定位会压住项目圆标轨——左缘改挂窄轨右缘。
    const rail = collapsed ? ringRef.current?.closest("aside")?.getBoundingClientRect() : null;
    setAnchor({ top: r.top, left: rail ? rail.right : r.right });
  }

  // 收回：先播 status-session-out（150ms），到点再卸载；已在收回中则忽略（防重复计时）。
  function closePanel() {
    if (!sessOpen || closing) return;
    setClosing(true);
    window.setTimeout(() => {
      setSessOpen(false);
      setClosing(false);
    }, 170);
  }

  function togglePanel() {
    if (sessOpen) closePanel();
    else {
      measureRing();
      setSessOpen(true);
    }
  }

  function openJob(id: string) {
    setActiveJob(id);
    setGenPanelOpen(true);
    closePanel(); // 进会话视图，收回悬浮面板
  }

  // 面板开着时：Esc / 点击面板外收回；窗口 resize / 侧栏拖宽（aside 尺寸变）→ 锚点跟随重测。
  // closing 进依赖：收回动画期间监听器换绑新闭包，closePanel 的 closing 守卫不读过期值。
  useEffect(() => {
    if (!sessOpen) return;
    const aside = ringRef.current?.closest("aside");
    const ro = aside ? new ResizeObserver(measureRing) : null;
    if (aside && ro) ro.observe(aside);
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // 焦点在输入框（侧栏改名 / ProseMirror）时让 Esc 先服务于输入框，不关面板。
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      closePanel();
    }
    // 点击面板外（圆点除外——它自己 toggle）收回。capture 阶段接，不怕别的组件 stopPropagation。
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || ringRef.current?.contains(target)) return;
      closePanel();
    }
    window.addEventListener("resize", measureRing);
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measureRing);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [sessOpen, closing]);

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
  // 内联任务区只随「有在跑任务」自动展开（完整列表在悬浮会话面板）。
  const expanded = !collapsed && (runningGroups.length > 0 || describeRunning);
  // 面板生成 tab：最新会话在前（长久使用，最近的对话最常回看）。
  const panelGroups = [...genGroups].reverse();
  // 两条渲染分支（折叠提前 return 之前）都要用：sessionPanel 在折叠分支也会执行。
  const inlineDescribeCount = (describingId ? 1 : 0) + queue.length;
  const panelDescribeCount = inlineDescribeCount + failures.length;

  function dotButton(className: string, ref?: Ref<HTMLButtonElement>) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={togglePanel}
        title={title}
        aria-label={title}
        aria-expanded={sessOpen}
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

  // 折叠窄轨：圆点点击直接弹悬浮会话面板（不展开侧栏）；sessionPanel 函数声明提升，可在此调用。
  if (collapsed) {
    return (
      <div className="flex w-full justify-center py-1">
        {dotButton("", ringRef)}
        {sessionPanel()}
      </div>
    );
  }

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

  // wide（悬浮面板 300px 宽）标题放宽到 16 字；内联窄轨仍 5 字。
  function genGroupRow(g: GenGroup, i: number, wide = false) {
    const j = g.latest;
    // 会话标题：首轮编辑框原文首个非空行，压缩省略。
    const firstLine =
      (j.turns[0]?.promptRaw || j.lastPrompt)
        .split("\n")
        .find((l) => l.trim())
        ?.trim() ?? "";
    const maxChars = wide ? 16 : 5;
    const label = !firstLine ? "会话" : firstLine.length > maxChars ? `${firstLine.slice(0, maxChars)}…` : firstLine;
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

  // 面板「反推」tab：在跑 + 排队 + 失败（重试/清除，只在这里，内联区不放）。
  function describePanelRows() {
    const hasAny = describingId !== null || queue.length > 0 || failures.length > 0;
    if (!hasAny) {
      return <div className="px-3 py-6 text-center text-xs text-muted">暂无反推任务</div>;
    }
    return (
      <>
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
        {failures.length > 0 && (
          <div className="mt-1 border-t border-edge pt-1">
            {failures.map((failure) => (
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
        )}
      </>
    );
  }

  // 悬浮会话面板本体：展开/折叠两条渲染分支共用（折叠窄轨的提前 return 也调用它）。
  function sessionPanel() {
    if (!sessOpen || !anchor) return null;
    return (
      // top/left 由圆点锚点注入（左上角接圆点；折叠态左缘接窄轨右缘），bottom=0 与侧栏同高。
      <div
        ref={panelRef}
        className={`status-session-panel ${closing ? "is-closing" : ""}`}
        style={{ top: anchor.top, left: anchor.left, bottom: 0 }}
        role="dialog"
        aria-label="任务会话面板"
      >
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge pl-3 pr-2">
          <span className="min-w-0 truncate text-[10px] uppercase tracking-wide text-muted">
            {tab === "gen" ? `生成会话（${genGroups.length}）` : `反推任务（${panelDescribeCount}）`}
          </span>
          {/* 生成 / 反推 切换（面板右上） */}
          <div className="ml-auto flex shrink-0 rounded-full border border-edge bg-panel p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setTab("gen")}
              className={`rounded-full px-2.5 py-0.5 ${
                tab === "gen" ? "bg-accent/25 text-ink" : "text-muted hover:text-ink"
              }`}
            >
              生成
            </button>
            <button
              type="button"
              onClick={() => setTab("describe")}
              className={`relative rounded-full px-2.5 py-0.5 ${
                tab === "describe" ? "bg-accent/25 text-ink" : "text-muted hover:text-ink"
              }`}
            >
              反推
              {failures.length > 0 && (
                <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-red-400" />
              )}
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {tab === "gen" ? (
            panelGroups.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs leading-5 text-muted">
                暂无生成会话
                <br />
                在创作板发送后，会话会出现在这里
              </div>
            ) : (
              panelGroups.map((g, i) => genGroupRow(g, i, true))
            )
          ) : (
            describePanelRows()
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4">
      {/* 圆点行：与右上角收起按钮同一水平中心线（top 13px / 32px 高），高度对齐 */}
      <div className="flex items-center pl-1 pr-12 -mt-[3px]">
        {dotButton(`!h-8 !w-8 !min-h-8 ${sessOpen && !closing ? "bg-ink/10" : ""}`, ringRef)}
      </div>
      {expanded && (
        <div className="mt-1 max-h-64 overflow-y-auto rounded bg-panel2/40">
          {runningGroups.length === 0 && !describeRunning ? (
            <div className="px-3 py-4 text-center text-xs text-muted">暂无任务</div>
          ) : (
            <>
              {runningGroups.length > 0 && (
                <div className="border-b border-edge">
                  <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted">
                    生成会话（{genGroups.length}）
                  </div>
                  <div className="p-1">{runningGroups.map((g, i) => genGroupRow(g, i))}</div>
                </div>
              )}
              {describeRunning && (
                <div>
                  <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted">
                    反推任务（{inlineDescribeCount}）
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
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {sessionPanel()}
    </div>
  );
}
