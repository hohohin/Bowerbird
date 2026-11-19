import { useRef, useState } from "react";
import { api } from "../lib/api";
import { notify } from "../lib/notify";
import { userErrorMessage } from "../lib/userError";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";

export function MoveAssetsToProjectDialog({ assetIds, sourceProjectId, onClose, onSaved }: {
  assetIds: string[];
  sourceProjectId: string | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const projects = useStore(state => state.projects);
  const available = projects.filter(project => project.id !== sourceProjectId && !project.provisional && project.archived_at == null);
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const target = available.find(project => project.id === targetId);

  async function submit() {
    if (!target || !assetIds.length || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const { changed } = await api.moveAssetsToProject(sourceProjectId, target.id, assetIds);
      if (changed > 0) notify(`已将 ${changed} 项素材移入「${target.name}」`, "success");
      else notify(`所选素材已在「${target.name}」中`);
    } catch (reason) {
      setError(userErrorMessage(reason, "移动素材失败，请重试。"));
      return;
    } finally {
      pending.current = false;
      setBusy(false);
    }
    onSaved?.();
    onClose();
  }

  const source = projects.find(project => project.id === sourceProjectId);
  return <ModalShell title="移动到项目" onClose={onClose} preventClose={busy}
    description={sourceProjectId ? `将所选 ${assetIds.length} 项素材从${source ? `「${source.name}」` : "来源项目"}移入目标项目。`
      : `将所选 ${assetIds.length} 项素材加入目标项目，保留已有项目归属。`}
    footer={<>
      <button type="button" className="app-modal-button" onClick={onClose} disabled={busy}>取消</button>
      <button type="button" className="app-modal-button is-primary" onClick={() => void submit()} disabled={!target || !assetIds.length || busy}>
        {busy ? "移动中…" : "移动"}
      </button>
    </>}>
    <div role="radiogroup" aria-label="目标项目" className="max-h-64 space-y-1 overflow-y-auto">
      {available.map((project, index) => <label key={project.id}
        className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm hover:bg-edge">
        <input type="radio" name="move-target-project" value={project.id} checked={targetId === project.id}
          disabled={busy} data-modal-autofocus={index === 0 ? true : undefined}
          onChange={() => { setTargetId(project.id); setError(""); }} className="size-4"/>
        <span className="min-w-0 truncate" title={project.name}>{project.name}</span>
      </label>)}
      {!available.length && <p className="py-4 text-center text-xs text-muted">没有可选的目标项目</p>}
    </div>
    {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
  </ModalShell>;
}
