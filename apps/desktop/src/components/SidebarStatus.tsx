import { useEffect, useRef, useState, useId } from "react";
import { Activity, Circle, CircleAlert, Clock3, Sparkles, X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { cloudAgentStatusLabel } from "../lib/cloudAgent";
import { isCloudProvider } from "../lib/genProviders";
import { notifyError } from "../lib/notify";
import {
  creativeTaskOwnerState,
  isAgentTaskActive,
  taskCenterAgentRuns,
  taskCenterGenerationJobs,
} from "../lib/projectActivity";
import { isDeferredTaskOpenCurrent } from "../lib/workspaceRoute";
import type { GenJob } from "../lib/types";
import { agentReminderKey, describeReminderKey, generationReminderKey, orphanReminderKey, visualProfileReminderKey, waitingReminderStatuses } from "../lib/taskReminders";
import { useTaskReminders } from "../lib/useTaskReminders";
import { stopVisualProfileTask, useVisualProfileTasks, visualProfileTaskScope } from "../lib/visualProfileTasks";

function providerLabel(provider?: string | null): string {
  if (provider === "jimeng") return "即梦";
  if (isCloudProvider(provider)) return "云端";
  return "codex";
}

/** 顶部次级任务入口。按需呈现 active/attention 投影，卡片仍是项目详情主入口。 */
export function SidebarStatus() {
  const describingId = useStore((s) => s.describingId);
  const describingName = useStore((s) => s.describingName);
  const queue = useStore((s) => s.describeQueue);
  const allFailures = useStore((s) => s.describeFailures);
  const autoAnalyzing = useStore((s) => s.autoAnalyzing);
  const genJobOrder = useStore((s) => s.genJobOrder);
  const genJobs = useStore((s) => s.genJobs);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projectRoutePending = useStore((s) => s.projectRoutePending);
  const exitProject = useStore((s) => s.exitProject);
  const genUnread = useStore((s) => s.genUnread);
  const genPanelOpen = useStore((s) => s.genPanelOpen);
  const cloudAgentRuns = useStore((s) => s.cloudAgentRuns);
  const cloudAgentRunOrder = useStore((s) => s.cloudAgentRunOrder);
  const openCloudAgentRun = useStore((s) => s.openCloudAgentRun);
  const openGenerationJob = useStore((s) => s.openGenerationJob);
  const retryDescribeFailure = useStore((s) => s.retryDescribeFailure);
  const allOrphans = useStore((s) => s.jimengOrphans);
  const retrieveJimengOrphan = useStore((s) => s.retrieveJimengOrphan);
  const reminders = useTaskReminders();
  const allVisualTasks = useVisualProfileTasks((s) => s.tasks).filter((task) => task.scopeKey === visualProfileTaskScope() && task.status !== "cancelled");
  const [showCleared, setShowCleared] = useState(false);
  // 入口下缘对齐，窗口及顶栏尺寸变化时重测。
  const ringRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [sessOpen, setSessOpen] = useState(false);
  const panelId = useId();
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const [tab, setTab] = useState<"gen" | "describe" | "visual">("gen");
  const allAgentTasks = taskCenterAgentRuns(
    cloudAgentRunOrder.flatMap((runId) => cloudAgentRuns[runId] ? [cloudAgentRuns[runId]] : []),
  );
  const allGenerationTasks = taskCenterGenerationJobs(genJobOrder.map((id) => genJobs[id]).filter(Boolean));
  const currentKeys = [
    ...allAgentTasks.map(agentReminderKey), ...allGenerationTasks.map(generationReminderKey),
    ...allFailures.map(describeReminderKey), ...allOrphans.map(orphanReminderKey),
    ...allVisualTasks.map(visualProfileReminderKey),
  ].filter((key): key is string => key !== null);
  const unclearedKeys = currentKeys.filter((key) => !reminders.isCleared(key));
  const clearedCount = currentKeys.length - unclearedKeys.length;
  const agentTasks = allAgentTasks.filter((run) => !reminders.isCleared(agentReminderKey(run)));
  const failures = allFailures.filter((failure) => !reminders.isCleared(describeReminderKey(failure)));
  const jimengOrphans = allOrphans.filter((task) => !reminders.isCleared(orphanReminderKey(task)));
  const displayedAgentTasks = showCleared ? allAgentTasks : agentTasks;
  const displayedFailures = showCleared ? allFailures : failures;
  const displayedOrphans = showCleared ? allOrphans : jimengOrphans;
  const visualTasks = allVisualTasks.filter((task) => !reminders.isCleared(visualProfileReminderKey(task)));
  const displayedVisualTasks = showCleared ? allVisualTasks : visualTasks;
  function measureRing() {
    const r = ringRef.current?.getBoundingClientRect();
    const canvasTools = document.querySelector(".canvas-board-toolbar")?.getBoundingClientRect();
    if (r) setAnchor({
      top: Math.max(r.bottom, canvasTools?.bottom ?? 0) + 8,
      right: Math.max(12, window.innerWidth - r.right),
    });
  }

  function closePanel(restoreFocus = false) {
    setSessOpen(false);
    if (restoreFocus) ringRef.current?.focus({ preventScroll: true });
  }

  function togglePanel() {
    if (sessOpen) closePanel(true);
    else {
      if (visualTasks.length > 0 && generationTaskCount === 0) setTab("visual");
      measureRing();
      setSessOpen(true);
    }
  }

  function openTask(unowned: boolean, open: () => void) {
    if (useStore.getState().projectRoutePending) return;
    closePanel(true);
    if (!unowned || !activeProjectId) {
      open();
      return;
    }
    const exit = exitProject();
    const exitRouteRevision = useStore.getState().projectRouteRevision;
    void exit
      .then(() => {
        const route = useStore.getState();
        if (!isDeferredTaskOpenCurrent(
          exitRouteRevision,
          route.projectRouteRevision,
          route.projectRoutePending,
        )) return;
        open();
      })
      .catch((error) => notifyError(error, "画板仍有未保存修改，无法打开未归属任务"));
  }

  function openJob(id: string, unowned: boolean) {
    openTask(unowned, () => openGenerationJob(id));
  }

  useEffect(() => {
    if (!sessOpen) return;
    panelRef.current?.focus({ preventScroll: true });
    const toolbar = ringRef.current?.closest("header");
    const ro = new ResizeObserver(measureRing);
    if (toolbar) ro.observe(toolbar);
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.isComposing || e.repeat || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closePanel(true);
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (!target || panelRef.current?.contains(target) || ringRef.current?.contains(target)) return;
      closePanel();
    }
    function onFocusIn(e: FocusEvent) {
      const target = e.target as Node | null;
      if (target && !panelRef.current?.contains(target) && !ringRef.current?.contains(target)) closePanel();
    }
    window.addEventListener("resize", measureRing);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measureRing);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [sessOpen]);

  const showUnreadDot =
    (genUnread && !genPanelOpen) || failures.length > 0 || jimengOrphans.length > 0 || visualTasks.some((task) => task.status !== "running");

  // 生成任务按 conversationId 聚合；先移除成功/取消记录，避免任务中心退化成历史列表。
  type GenGroup = { key: string; jobs: GenJob[]; latest: GenJob; running: boolean };
  const genGroups: GenGroup[] = [];
  const groupByKey = new Map<string, GenGroup>();
  const generationTasks = allGenerationTasks.filter((job) => !reminders.isCleared(generationReminderKey(job)));
  for (const j of generationTasks) {
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
  const panelGroups = showCleared
    ? [...allGenerationTasks.reduce((groups, job) => {
      const key = job.conversationId ?? job.id;
      const group = groups.get(key) ?? { key, jobs: [], latest: job, running: false };
      group.jobs.push(job);
      group.latest = job;
      group.running ||= job.running;
      groups.set(key, group);
      return groups;
    }, new Map<string, GenGroup>()).values()].reverse()
    : [...genGroups].reverse();
  const generationTaskCount = genGroups.length + agentTasks.length;
  const panelDescribeCount = (describingId ? 1 : 0) + queue.length + failures.length;
  const waitingStatuses = waitingReminderStatuses;
  const waiting = agentTasks.filter((run) => waitingStatuses.has(run.status) || run.status === "succeeded").length + jimengOrphans.length
    + visualTasks.filter((task) => task.status === "succeeded").length;
  const failed = genGroups.filter((g) => !g.running && g.latest.turns.some((t) => t.error)).length
    + agentTasks.filter((run) => run.status === "failed").length + failures.length + visualTasks.filter((task) => task.status === "failed").length;
  const running = genGroups.filter((g) => g.running).length
    + agentTasks.filter((run) => isAgentTaskActive(run.status) && !waitingStatuses.has(run.status)).length
    + (describingId ? 1 : 0) + queue.length + autoAnalyzing + visualTasks.filter((task) => task.status === "running").length;
  const count = generationTaskCount + panelDescribeCount + jimengOrphans.length + autoAnalyzing + visualTasks.length;
  const state = failed ? "failed" : waiting ? "waiting" : running ? "running" : "idle";
  const statusText = [failed && `失败 ${failed}`, waiting && `待处理 ${waiting}`, running && `进行中 ${running}`].filter(Boolean).join("，") || (showUnreadDot ? "有新结果" : "空闲");
  const title = `任务中心 · ${statusText}`;
  const StatusIcon = state === "failed" ? CircleAlert : state === "waiting" ? Clock3 : state === "running" ? Activity : Circle;

  // 生成任务行的参考图「拖影」缩略图堆：至多 5 张；前 3 张全显，多出的以低透明度叠在
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
    // 任务标题：首轮编辑框原文首个非空行，压缩省略。
    const firstLine =
      (j.turns[0]?.promptRaw || j.lastPrompt)
        .split("\n")
        .find((l) => l.trim())
        ?.trim() ?? "";
    const maxChars = 16;
    const label = !firstLine ? "生成任务" : firstLine.length > maxChars ? `${firstLine.slice(0, maxChars)}…` : firstLine;
    // 缩略图 = 任务建立时引用的参考图（最新版本的 refAssets，有 thumb 用 thumb）。
    const refThumbPaths = (j.refAssets ?? [])
      .map((a) => a.thumb_path ?? a.store_path ?? "")
      .filter(Boolean);
    const failed = j.turns.some((t) => t.error);
    const ownerState = creativeTaskOwnerState(j);
    const unowned = ownerState === "unowned";
    const invalidOwner = ownerState === "invalid";
    return (
      <div key={g.key} className="group relative">
        <button
          type="button"
          disabled={projectRoutePending || invalidOwner}
          onClick={() => openJob(j.id, unowned)}
          title={`${providerLabel(j.provider)} · ${firstLine || "生成任务"}${unowned ? " · 未归属" : invalidOwner ? " · 归属异常，无法打开" : ""}`}
          className="block w-full rounded px-2 py-1.5 pr-6 text-left hover:bg-panel2 disabled:pointer-events-none disabled:opacity-50"
        >
          <div className="flex items-center gap-2">
            {thumbStack(refThumbPaths)}
            <span className="min-w-0 flex-1 truncate text-xs text-ink">{label}</span>
            {(unowned || invalidOwner) && (
              <span className="shrink-0 text-[10px] task-state-waiting">
                {invalidOwner ? "归属异常" : "未归属"}
              </span>
            )}
            <span className="shrink-0">
              {g.running ? (
                <span className="task-state-running text-[10px]">进行中</span>
              ) : failed ? (
                <span className="task-state-failed text-[10px]">失败</span>
              ) : (
                <span className="opacity-50">·</span>
              )}
            </span>
          </div>
        </button>
        <button
          type="button"
          onClick={() => reminders.clear(g.jobs.map(generationReminderKey).filter((key): key is string => key !== null))}
          disabled={g.running || g.jobs.every((job) => reminders.isCleared(generationReminderKey(job)))}
          title="清除提醒，保留任务和结果"
          aria-label={`清除生成任务提醒 ${i + 1}`}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted opacity-0 hover:bg-panel hover:text-ink focus:opacity-100 group-hover:opacity-100"
        >
          <X size={11} />
        </button>
      </div>
    );
  }

  function cloudAgentRow(run: (typeof agentTasks)[number]) {
    const reminderKey = agentReminderKey(run);
    const firstLine = run.intentPrompt.split("\n").find((line) => line.trim())?.trim() || "Agent 任务";
    const maxChars = 16;
    const label = firstLine.length > maxChars ? `${firstLine.slice(0, maxChars)}…` : firstLine;
    const ownerState = creativeTaskOwnerState(run);
    const unowned = ownerState === "unowned";
    const invalidOwner = ownerState === "invalid";
    return (
      <div key={run.runId} className="group relative">
      <button
        type="button"
        disabled={projectRoutePending || invalidOwner}
        onClick={() => {
          openTask(unowned, () => openCloudAgentRun(run));
        }}
        title={`Bowerbird Agent · ${cloudAgentStatusLabel(run.status)} · ${firstLine}${unowned ? " · 未归属" : invalidOwner ? " · 归属异常，无法打开" : ""}`}
        className="block w-full rounded py-1.5 pl-2 pr-7 text-left hover:bg-panel2 disabled:pointer-events-none disabled:opacity-50"
      >
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-edge bg-accent/10 text-accent">
            <Sparkles size={14} />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-ink">{label}</span>
          {(unowned || invalidOwner) && (
            <span className="shrink-0 text-[10px] task-state-waiting">
              {invalidOwner ? "归属异常" : "未归属"}
            </span>
          )}
          <span className="shrink-0">
            {waitingStatuses.has(run.status) || run.status === "succeeded" ? (
              <span className="task-state-waiting text-[10px]">待处理</span>
            ) : isAgentTaskActive(run.status) ? (
              <span className="task-state-running text-[10px]">进行中</span>
            ) : run.status === "failed" ? (
              <span className="task-state-failed text-[10px]">失败</span>
            ) : (
              <span className="opacity-50">·</span>
            )}
          </span>
        </div>
      </button>
      {reminderKey && (
        <button
          type="button"
          onClick={() => reminders.clear([reminderKey])}
          disabled={reminders.isCleared(reminderKey)}
          title="清除提醒，保留任务和结果"
          aria-label={`清除 Agent 任务提醒 ${firstLine}`}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:bg-panel hover:text-ink disabled:opacity-30"
        >
          <X size={11} />
        </button>
      )}
      </div>
    );
  }

  // 面板「生成」tab 顶部：即梦孤儿任务（启动 list_task 比对发现，本地无记录）——
  // 每条可取回或仅清除提醒；清除后仍能通过「查看已清除」取回。
  function orphanRows() {
    if (displayedOrphans.length === 0) return null;
    return (
      <div className="border-b border-edge">
        <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted">
          即梦孤儿任务（{displayedOrphans.length}）
        </div>
        {displayedOrphans.map((t) => {
          const firstLine = t.prompt.split("\n").find((l) => l.trim())?.trim() || "未知任务";
          const label = firstLine.length > 14 ? `${firstLine.slice(0, 14)}…` : firstLine;
          return (
            <div key={t.submit_id} className="rounded px-2 py-1.5 text-xs text-ink">
              <div className="flex items-center gap-1.5" title={t.prompt || t.submit_id}>
                <span className={t.gen_status === "querying" ? "animate-pulse text-accent" : "text-muted"}>
                  ●
                </span>
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="shrink-0 text-[10px] text-muted">
                  {t.gen_status === "querying" ? "远端进行中" : "已完成未取回"}
                </span>
              </div>
              <div className="mt-1 flex justify-end gap-1 pl-5">
                <button
                  type="button"
                  onClick={() => void retrieveJimengOrphan(t.submit_id)}
                  className="rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-panel2"
                >
                  取回
                </button>
                <button
                  type="button"
                  onClick={() => reminders.clear([orphanReminderKey(t)])}
                  disabled={reminders.isCleared(orphanReminderKey(t))}
                  className="rounded px-1.5 py-0.5 text-[10px] text-muted hover:bg-panel2 hover:text-ink"
                >
                  清除提醒
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // 反推：在跑、排队与失败重试。
  function describePanelRows() {
    const hasAny = describingId !== null || queue.length > 0 || displayedFailures.length > 0;
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
        {displayedFailures.length > 0 && (
          <div className="mt-1 border-t border-edge pt-1">
            {displayedFailures.map((failure) => (
              <div key={failure.assetId} className="rounded px-2 py-1.5 text-xs text-ink">
                <div className="flex items-center gap-1.5">
                  <span className="task-state-failed">❌</span>
                  <span className="min-w-0 flex-1 truncate">{failure.name}</span>
                  <span className="text-[10px] task-state-failed">失败</span>
                </div>
                <div className="mt-1 break-words pl-5 text-[10px] leading-4 task-state-failed" title={failure.reason}>
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
                    onClick={() => reminders.clear([describeReminderKey(failure)])}
                    disabled={reminders.isCleared(describeReminderKey(failure))}
                    className="rounded px-1.5 py-0.5 text-[10px] text-muted hover:bg-panel2 hover:text-ink"
                  >
                    清除提醒
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  function visualPanelRows() {
    if (!displayedVisualTasks.length) return <div className="px-3 py-6 text-center text-xs text-muted">暂无提炼任务</div>;
    return displayedVisualTasks.map((task) => <div key={task.id} className="rounded px-2 py-2 text-xs" data-visual-task-id={task.id}>
      <div className="flex items-center gap-1.5">
        <Sparkles size={13} className={task.status === "running" ? "animate-pulse text-accent" : "text-muted"} />
        <span className="min-w-0 flex-1 truncate">{task.folderName}</span>
        <span className={task.status === "failed" ? "task-state-failed" : "text-muted"}>
          {task.status === "running" ? "提炼中" : task.status === "succeeded" ? "提炼完成" : "提炼失败"}
        </span>
      </div>
      <p className="mt-1 break-words text-[10px] text-muted">{task.error ?? task.progress}</p>
      <div className="mt-1 flex justify-end gap-2">
        <button type="button" className="text-accent" onClick={() => {
          closePanel(true);
          useStore.getState().openVisualProfile({ id: task.folderId, name: task.folderName, profileId: task.result?.id });
        }}>{task.status === "succeeded" ? "查看规范" : task.status === "failed" ? "重新提炼" : "查看进度"}</button>
        {task.status === "running" && task.canStop && <button type="button" className="text-muted" onClick={() => stopVisualProfileTask(task.id)}>停止提炼</button>}
        {visualProfileReminderKey(task) && <button type="button" className="text-muted disabled:opacity-40"
          disabled={reminders.isCleared(visualProfileReminderKey(task))}
          onClick={() => reminders.clear([visualProfileReminderKey(task)!])}>清除提醒</button>}
      </div>
    </div>);
  }

  // 只在用户主动展开时挂载列表。
  function sessionPanel() {
    if (!sessOpen || !anchor) return null;
    return (
      <div
        ref={panelRef}
        id={panelId}
        tabIndex={-1}
        className="status-session-panel"
        style={{ top: anchor.top, right: anchor.right, maxHeight: `min(440px, calc(100dvh - ${anchor.top + 12}px))` }}
        role="dialog"
        aria-label="任务中心"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-2 text-xs text-muted">
          <span>{statusText}</span>
          <button type="button" disabled={unclearedKeys.length === 0}
            className="shrink-0 rounded px-1 py-0.5 text-accent hover:bg-panel2 disabled:opacity-40"
            title="仅清除当前失败和待处理提醒，保留任务和结果"
            onClick={() => reminders.clear(unclearedKeys)}>清除当前提醒</button>
        </div>
        {clearedCount > 0 && <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 text-[11px] text-muted">
          <span>已清除 {clearedCount} 条提醒，任务仍保留</span>
          <button type="button" className="shrink-0 text-accent" aria-pressed={showCleared}
            onClick={() => setShowCleared((value) => !value)}>{showCleared ? "收起已清除" : "查看已清除"}</button>
        </div>}
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge pl-3 pr-2">
          <span className="min-w-0 truncate text-[10px] uppercase tracking-wide text-muted">
            {tab === "gen" ? `生成任务（${generationTaskCount}）` : tab === "visual" ? `提炼任务（${visualTasks.length}）` : `反推任务（${panelDescribeCount}）`}
          </span>
          {/* 任务类型切换 */}
          <div className="ml-auto flex shrink-0 rounded-full border border-edge bg-panel p-0.5 text-[11px]">
            <button type="button" onClick={() => setTab("visual")} aria-pressed={tab === "visual"}
              className={`rounded-full px-2.5 py-0.5 ${tab === "visual" ? "bg-accent/25 text-ink" : "text-muted hover:text-ink"}`}>提炼</button>
            <button
              type="button"
              onClick={() => setTab("gen")}
              aria-pressed={tab === "gen"}
              className={`rounded-full px-2.5 py-0.5 ${
                tab === "gen" ? "bg-accent/25 text-ink" : "text-muted hover:text-ink"
              }`}
            >
              生成
            </button>
            <button
              type="button"
              onClick={() => setTab("describe")}
              aria-pressed={tab === "describe"}
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
          <button type="button" className="app-icon-button" aria-label="关闭任务中心" onClick={() => closePanel(true)}><X size={14} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {tab === "gen" ? (
            <>
              {orphanRows()}
              {panelGroups.length === 0 && displayedAgentTasks.length === 0 && displayedOrphans.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs leading-5 text-muted">
                  暂无生成任务
                  <br />
                  进行中或失败的任务会出现在这里
                </div>
              ) : (
                <>
                  {displayedAgentTasks.map((run) => cloudAgentRow(run))}
                  {panelGroups.map((g, i) => genGroupRow(g, i))}
                </>
              )}
            </>
          ) : (
            tab === "visual" ? visualPanelRows() : describePanelRows()
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="task-center-entry">
      <button
        ref={ringRef}
        type="button"
        onClick={togglePanel}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={sessOpen}
        aria-controls={sessOpen ? panelId : undefined}
        className="task-center-trigger"
      >
        <StatusIcon size={15} className={`task-state-${state}`} aria-hidden="true" />
        {showUnreadDot && count === 0 && <span className="task-center-unread" aria-hidden="true" />}
      </button>
      {sessionPanel()}
    </div>
  );
}
