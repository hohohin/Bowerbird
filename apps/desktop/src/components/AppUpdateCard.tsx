import { userErrorMessage } from "../lib/userError";
import { updateDownloadPercent, useAppUpdater } from "../lib/appUpdater";

export function AppUpdateCard({ version, migrating }: {
  version: string | null; migrating: boolean;
}) {
  const updater = useAppUpdater();
  const { phase, update, downloaded, error } = updater;
  const percent = updateDownloadPercent(updater);
  const busy = ["checking", "downloading", "installing"].includes(phase);
  const label = phase === "checking" ? "正在检查…"
    : phase === "downloading" ? "正在下载…"
    : phase === "installing" ? "正在安装…"
    : phase === "available" ? (error ? "重新下载" : "下载更新")
    : phase === "ready" ? "安装并重启"
    : phase === "installed" ? "重启应用" : "检查更新";

  async function act() {
    if (busy || migrating) return;
    if (phase === "available") return updater.download();
    if (phase === "ready" || phase === "installed") return updater.install();
    return updater.check();
  }

  return (
    <div className="settings-card px-3 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-ink">当前版本</div>
          <p className="mt-1 text-xs text-muted">{version ?? "读取中…"}</p>
        </div>
        <button type="button" onClick={() => void act()} disabled={phase !== "installing" && (busy || migrating)}
          aria-disabled={phase === "installing" || undefined}
          className="shrink-0 rounded-md bg-panel px-3 py-1 text-[12px] text-ink hover:bg-edge disabled:cursor-not-allowed disabled:opacity-50">
          {label}
        </button>
      </div>
      <div className="mt-2 min-h-4 text-xs text-muted" role="status" aria-live="polite">
        {phase === "current" && "当前已是最新版本。"}
        {update && <p>新版本 {update.version}</p>}
        {phase === "downloading" && <>
          <p className="mt-1">已下载 {(downloaded / 1024 / 1024).toFixed(1)} MB{percent !== null ? ` · ${percent}%` : ""}</p>
          <progress className="mt-2 h-1.5 w-full" aria-label="更新下载进度" max={100} value={percent ?? undefined} />
        </>}
        {phase === "ready" && <p className="mt-1">下载和校验完成。安装将关闭并重启应用，请先保存当前编辑。</p>}
        {phase === "installing" && <p className="mt-1">正在保存画板并启动安装，请稍候…</p>}
        {update?.body && <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{update.body}</p>}
      </div>
      {error && <p className="mt-2 break-words text-xs text-red-400" role="alert">{userErrorMessage(error, "更新未完成，请稍后重试。")}</p>}
    </div>
  );
}
