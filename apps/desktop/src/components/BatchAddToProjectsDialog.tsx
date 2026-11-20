import { useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { notifyError, notifySuccess } from "../lib/notify";
import { ModalShell } from "./ModalShell";

/** 多选右键「加入项目」小面板：勾选（可多选）目标项目后批量加入；
 *  全部失败留在面板反馈，至少一个成功才退出管理。 */
export function BatchAddToProjectsDialog({ ids, onClose, onComplete }: { ids: string[]; onComplete?: () => void; onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (checked.size === 0 || busy) return;
    setBusy(true);
    let failed = 0;
    for (const projectId of checked) {
      try {
        await api.addAssetsToProject(projectId, ids);
      } catch (e) {
        failed += 1;
        console.error("add to project failed", e);
      }
    }
    await useStore.getState().reloadProjects();
    if (failed === checked.size) {
      notifyError(null, "加入项目失败");
      setBusy(false);
      return;
    }
    if (failed === 0) onComplete?.();
    if (failed > 0) notifyError(null, `${failed} 个项目加入失败`);
    notifySuccess(`素材已加入 ${checked.size - failed} 个项目`);
    useStore.getState().exitManage();
    onClose();
  }

  return (
    <ModalShell
      title="加入项目"
      eyebrow="Add to projects"
      description={`勾选要放入所选 ${ids.length} 项素材的项目（可多选）。`}
      onClose={onClose}
      preventClose={busy}
      footer={
        <>
          <button onClick={onClose} disabled={busy} className="app-modal-button">
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={checked.size === 0 || busy}
            className="app-modal-button is-primary"
          >
            {busy && <span className="app-spinner" aria-hidden />}
            {busy ? "加入中…" : checked.size > 0 ? `加入所选 ${checked.size} 个项目` : "加入项目"}
          </button>
        </>
      }
    >
      <div className="max-h-64 space-y-1 overflow-y-auto">
        {projects.map((p) => (
          <label
            key={p.id}
            className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm ${busy ? "" : "cursor-pointer hover:bg-edge"}`}
          >
            <input
              type="checkbox"
              checked={checked.has(p.id)}
              disabled={busy}
              onChange={() => toggle(p.id)}
              className="size-4"
            />
            <span className="min-w-0 flex-1 truncate" title={p.name}>{p.name}</span>
          </label>
        ))}
        {projects.length === 0 && (
          <p className="px-2.5 py-4 text-center text-xs text-muted">还没有项目</p>
        )}
      </div>
    </ModalShell>
  );
}
