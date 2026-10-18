import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { fileWorkspace, type FileMovePreview, type FileWorkspaceStatus, type HistoryMovePreview } from "../lib/fileWorkspace";
import { ModalShell } from "./ModalShell";
import { useStore } from "../store";

export function FileWorkspaceMoveDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<FileWorkspaceStatus | null>(null);
  const [preview, setPreview] = useState<FileMovePreview | null>(null);
  const [historyPreview, setHistoryPreview] = useState<HistoryMovePreview | null>(null);
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true); const operation = useRef(false);
  useEffect(() => {
    let current = true;
    alive.current = true;
    void fileWorkspace.status().then(value => { if (current) setStatus(value); }).catch(e => { if (current) setError(String(e)); });
    return () => { current = false; alive.current = false; };
  }, []);
  async function choose() {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(""); setPreview(null); setHistoryPreview(null);
    try {
      const selected = await open({ directory: true, multiple: false, title: "选择保存 BowerbirdLibrary 的文件夹" });
      if (!selected || Array.isArray(selected) || !alive.current) return;
      setParent(selected);
      const value = await fileWorkspace.movePreview(selected);
      if (alive.current) setPreview(value);
    } catch (e) { if (alive.current) setError(String(e)); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }
  async function inspectHistory() {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(""); setPreview(null); setHistoryPreview(null);
    try {
      const value = await fileWorkspace.historyPreview();
      if (alive.current) { setHistoryPreview(value); setPreview(value); }
    } catch (e) { if (alive.current) setError(String(e)); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }
  async function execute(cancel = false) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError("");
    try {
      if (cancel) await fileWorkspace.moveCancel();
      else {
        await useStore.getState().projectCanvasFlush?.();
        if (status?.migration?.state !== "pending") {
          if (!preview) return;
          if (historyPreview) await fileWorkspace.historySchedule(preview.token);
          else await fileWorkspace.moveSchedule(parent, preview.token);
          // Remember the saved plan even if restarting fails; never submit it twice.
          const next = await fileWorkspace.status();
          if (alive.current) { setStatus(next); setPreview(null); setHistoryPreview(null); }
        }
        await invoke("restart_app");
      }
      const next = await fileWorkspace.status();
      if (alive.current) { setStatus(next); setPreview(null); setHistoryPreview(null); }
    } catch (e) { if (alive.current) { setError(String(e)); setPreview(null); setHistoryPreview(null); } }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }
  const pending = status?.migration?.state === "pending";
  const move = status?.migration;
  const history = !!historyPreview || (pending && !!move?.history);
  return <ModalShell title="迁移 BowerbirdLibrary" width="lg" onClose={onClose} preventClose={busy}
    description="选择资料文件夹的新位置，或将历史素材按项目整理到当前位置。确认后重启应用，再复制、校验并更新引用。"
    footer={<><button className="app-button-secondary" disabled={busy} onClick={onClose}>关闭</button>
      {pending && <button className="app-button-secondary" disabled={busy} onClick={() => void execute(true)}>取消待迁移计划</button>}
      <button className="app-button-primary" disabled={busy || (!preview && !pending) || (!!historyPreview && !historyPreview.files)} onClick={() => void execute()}>{busy ? "正在处理…" : pending ? "重启并继续迁移" : "确认并重启迁移"}</button></>}>
    <p className="text-sm text-muted">当前位置</p><p className="mt-1 break-all text-sm">{status?.proposed_root ?? "读取中…"}</p>
    {!pending && <button className="app-button-secondary mt-4" disabled={busy || !status} onClick={() => void choose()}>选择目标文件夹…</button>}
    {!pending && <button className="app-button-secondary mt-4 ml-2" disabled={busy || !status} onClick={() => void inspectHistory()}>预览历史素材迁移</button>}
    {busy && <p role="status" className="my-3 text-sm">正在检查迁移计划…</p>}
    {(preview || pending) && <div className="my-4 rounded-lg border border-line p-3 text-sm">
      <p>迁移到</p><p className="my-2 break-all font-medium">{preview?.target ?? move?.target}</p>
      {preview && <p>{preview.files} 个文件 · {(preview.bytes / 1024 / 1024).toFixed(1)} MB · {preview.projects} 个项目目录</p>}
      {preview?.create_only && <p className="mt-2">默认目录尚未建立，将直接在所选位置创建资料文件夹。</p>}
      {historyPreview && <>
        <p className="mt-2">{historyPreview.global} 个未归属项目的素材放入「全局素材」；{historyPreview.shared} 个共享素材只保存一份。</p>
        {!historyPreview.files && <p role="status" className="mt-2">没有需要迁移的历史素材。</p>}
        <ul className="mt-2 max-h-40 overflow-y-auto space-y-2" aria-label="历史素材目标文件夹">{historyPreview.folders.map(folder => <li key={folder.id} className="break-all"><span>{folder.name} · {folder.files} 个文件</span><p className="text-xs text-muted">{folder.path}</p></li>)}</ul>
      </>}
      {pending && <p role="status">计划已保存，将在下次启动时执行。当前仍使用原目录。</p>}
    </div>}
    {history ? <>
      <p className="my-3 text-sm text-muted">一个项目一个文件夹，未归属项目的素材进入「全局素材」。共享素材存入最早创建的引用项目，其他项目继续引用；删除存放项目时，先转存至另一个引用项目。</p>
      <p className="my-3 text-sm text-muted">同步保存随图资料和更新引用，保留素材身份、标签与画板关联。旧库原文件保留供核对；已有文件不覆盖，外部文件和 NAS 引用不搬动。</p>
    </> : <>
      <p className="my-3 text-sm text-muted">所选文件夹内使用 BowerbirdLibrary；若选中的就是该文件夹，则直接使用。目标必须为空，已有文件不会被覆盖。若要更换历史素材的保存位置，请先完成目录迁移，再预览历史素材迁移。</p>
      <p className="my-3 text-sm text-muted">包含现有文件、随图资料和根目录内的项目。成功后，新项目、生成和采集使用新位置；原目录保留供核对，可确认无误后自行清理。本机索引、缓存及根目录外的引用保持原位置。</p>
    </>}
    <p className="my-3 text-sm text-muted">请先完成或取消生成、Agent、工作流和分类任务。大目录在重启时需要较长时间，请等待迁移完成。</p>
    {move?.state === "completed" && <p role="status" className="my-3 text-sm break-all">{move.history ? "历史素材迁移已完成" : "上次迁移已完成"}：{move.target}。原目录保留在 {move.source}。</p>}
    {move?.state === "failed" && <p role="alert" className="folder-error">{move.error}</p>}
    {error && <p role="alert" className="folder-error">{error}</p>}
  </ModalShell>;
}
