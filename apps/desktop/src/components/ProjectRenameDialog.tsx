import { useRef, useState } from "react";
import { api } from "../lib/api";
import { notifySuccess } from "../lib/notify";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";

export function ProjectRenameDialog({ projectId, currentName, onClose }: {
  projectId: string;
  currentName: string;
  onClose: () => void;
}) {
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const composing = useRef(false);
  const trimmed = name.trim();

  async function submit() {
    if (!trimmed || saving.current || composing.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const state = useStore.getState();
      if (state.projectRoutePending) throw new Error("项目正在切换，请稍后重试");
      if (state.activeProjectId === projectId) {
        if (!state.projectCanvasRename) throw new Error("项目画板尚未就绪，请稍后重试");
        await state.projectCanvasRename(trimmed);
      } else {
        if (!await api.projectCanvasRename(projectId, trimmed)) throw new Error("项目已不存在，无法重命名");
      }
      // The write succeeded; keep all labels current even if the list reload fails.
      useStore.setState((current) => ({ projects: current.projects.map((project) => project.id === projectId
        ? { ...project, name: trimmed, title_source: "manual" } : project) }));
      await useStore.getState().reloadProjects();
      notifySuccess("项目名称已更新");
      onClose();
    } catch (reason) {
      const detail = typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "请稍后重试";
      setError(`重命名项目失败：${detail}`);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return <ModalShell title="重命名项目" onClose={onClose} preventClose={busy}
    footer={<>
      <button className="app-modal-button" onClick={onClose} disabled={busy}>取消</button>
      <button className="app-modal-button is-primary" onClick={() => void submit()} disabled={!trimmed || busy}>
        {busy ? "保存中…" : "保存名称"}
      </button>
    </>}>
    <label htmlFor="rename-project-input" className="block text-[11px] font-medium text-muted">项目名称</label>
    <input id="rename-project-input" className="app-form-input mt-2 px-3 text-sm"
      data-modal-autofocus value={name} disabled={busy}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setName(event.target.value)}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={(event) => {
        // Stop IME Escape before ModalShell's window listener can close it.
        if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
          event.stopPropagation();
          return;
        }
        if (event.key === "Enter") { event.preventDefault(); void submit(); }
        if (event.key === "Escape") { event.stopPropagation(); if (!saving.current) onClose(); }
      }} />
    {!trimmed && <p className="mt-2 text-xs text-muted">项目名称不能为空</p>}
    {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
  </ModalShell>;
}
