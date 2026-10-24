import { useState } from "react";
import { useStore } from "../store";
import { notifyError, notifySuccess } from "../lib/notify";
import { workspaceProjectDeleteMode, type WorkspaceProjectDeleteMode } from "../lib/workspaceRoute";
import { ProjectDeleteDialog } from "./ProjectDeleteDialog";

export function useProjectDeletion(close: () => void = () => {}) {
  const deleteProjectCanvas = useStore(s => s.deleteProjectCanvas);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<{ id: string; name: string; mode: WorkspaceProjectDeleteMode } | null>(null);

  function prepareDelete(projectId: string) {
    const project = useStore.getState().projects.find(item => item.id === projectId);
    setTarget({ id: projectId, name: project?.name ?? "此项目", mode: workspaceProjectDeleteMode(project) });
    close();
  }

  return { busy, prepareDelete, confirmation: target && <ProjectDeleteDialog key={target.id} target={target}
    onClose={() => setTarget(null)} onConfirm={async (impact, physical, discard) => {
      setBusy(true);
      try {
        const result = await deleteProjectCanvas(target.id, physical ? "delete_exclusive" : "keep",
          impact?.physical.confirmation ?? "", discard ? impact?.pending_agent_results?.map(item => item.run_id) : undefined);
        if (result?.cleanup_pending.length) {
          notifyError("项目已删除，部分文件清理尚未完成；重启应用后会重试。", "文件清理未完成");
        } else {
          notifySuccess(target.mode === "discard-provisional" ? "未保存的项目已丢弃"
            : physical ? `项目已删除，同时删除了 ${result?.deleted_assets ?? 0} 项独占素材` : "项目已删除，素材已保留");
        }
        setTarget(null);
      } catch (error) {
        notifyError(error, "删除项目失败");
        throw error;
      } finally { setBusy(false); }
    }} /> };
}
