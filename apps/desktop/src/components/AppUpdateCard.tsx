import { useAppUpdater } from "../lib/appUpdater";
import { useStore } from "../store";
import { isAgentTaskActive } from "../lib/projectActivity";

function busyReason() {
  const state = useStore.getState();
  if (state.generating || Object.values(state.cloudAgentRuns).some((run) => isAgentTaskActive(run.status))) {
    return "请先完成或取消正在进行的生成 / Agent 任务，再安装更新。";
  }
  if (state.classifyProgress || state.colorRebuild) return "请等待素材整理完成，再安装更新。";
  return null;
}

export function AppUpdateCard({ version, migrating }: { version: string | null; migrating: boolean }) {
  const updater = useAppUpdater();
  const { phase, update, downloaded, total, error } = updater;
  const percent = total && total > 0 ? Math.min(100, Math.floor(downloaded / total * 100)) : null;
  const busy = ["checking", "downloading", "installing"].includes(phase);
  const label = phase === "checking" ? "正在检查…"
    : phase === "downloading" ? "正在下载…"
    : phase === "installing" ? "正在安装…"
    : phase === "available" ? "下载更新"
    : phase === "ready" ? "安装并重启"
    : phase === "installed" ? "重启应用" : "检查更新";

  async function act() {
    if (phase === "available") return updater.download();
    if (phase === "installed") return updater.restart();
    if (phase === "ready") return updater.install(async () => {
      if (migrating) throw new Error("请等待素材库迁移完成。");
      const reason = busyReason();
      if (reason) throw new Error(reason);
      await useStore.getState().projectCanvasFlush?.();
      const afterFlush = busyReason();
      if (afterFlush) throw new Error(afterFlush);
    });
    return updater.check();
  }

  return (
    <div className="settings-card px-3 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-ink">当前版本</div>
          <p className="mt-1 text-xs text-muted">{version ?? "读取中…"}</p>
        </div>
        <button type="button" onClick={() => void act()} disabled={busy || migrating}
          className="shrink-0 rounded-md bg-panel px-3 py-1 text-[12px] text-ink hover:bg-edge disabled:cursor-not-allowed disabled:opacity-50">
          {label}
        </button>
      </div>
      <div className="mt-2 text-xs text-muted" role="status" aria-live="polite">
        {phase === "current" && "当前已是最新版本。"}
        {update && phase !== "checking" && <p>新版本 {update.version}</p>}
        {phase === "downloading" && <>
          <p className="mt-1">已下载 {(downloaded / 1024 / 1024).toFixed(1)} MB{percent !== null ? ` · ${percent}%` : ""}</p>
          <progress className="mt-2 h-1.5 w-full" aria-label="更新下载进度" max={100} value={percent ?? undefined} />
        </>}
        {phase === "ready" && <p className="mt-1">下载和校验完成。安装将关闭并重启应用，请先保存当前编辑；素材和项目会保留，升级后需重新登录。</p>}
        {phase === "installing" && <p className="mt-1">正在保存画板并启动安装，请稍候…</p>}
        {update?.body && <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{update.body}</p>}
      </div>
      {error && <p className="mt-2 break-words text-xs text-red-400" role="alert">{error}</p>}
    </div>
  );
}
