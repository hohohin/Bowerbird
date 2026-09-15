import { useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { ConfirmDialog } from "./ConfirmDialog";
import { notifyError, notifySuccess } from "../lib/notify";
import type { ProjectDeleteImpact } from "../lib/types";
import { workspaceProjectDeleteMode, type WorkspaceProjectDeleteMode } from "../lib/workspaceRoute";

/** Shared project deletion flow for the sidebar menu and library project frames. */
export function useProjectDeletion(close: () => void = () => {}) {
  const deleteProjectCanvas = useStore((s) => s.deleteProjectCanvas);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    projectId: string;
    impact: ProjectDeleteImpact;
    mode: WorkspaceProjectDeleteMode;
    physical: boolean;
  } | null>(null);

  async function remove(projectId: string, mode: WorkspaceProjectDeleteMode, physical: boolean, confirmation: string) {
    setBusy(true);
    try {
      // Store owns the serialized route. Persisted canvases flush/delete there;
      // provisional canvases are discarded without materializing first.
      const result = await deleteProjectCanvas(projectId, physical ? "delete_exclusive" : "keep", confirmation);
      if (result?.cleanup_pending.length) {
        notifyError(`项目已删除，但物理文件清理尚未完成；重启应用将重试。${result.cleanup_pending.join("；")}`, "文件清理未完成");
      } else {
        notifySuccess(mode === "discard-provisional"
          ? "未保存的空白项目已丢弃"
          : physical
            ? `项目已删除，已物理删除 ${result?.deleted_assets ?? 0} 项独有素材，保留 ${result?.preserved_shared ?? 0} 项受保护素材`
            : "项目及其画板已删除，中央素材仍保留在素材库");
      }
      close();
    } catch (e) {
      notifyError(e, "删除项目失败");
    } finally {
      setBusy(false);
    }
  }

  async function prepareDelete(projectId: string) {
    setBusy(true);
    try {
      const mode = workspaceProjectDeleteMode(
        useStore.getState().projects.find((project) => project.id === projectId),
      );
      if (mode === "discard-provisional") {
        setPendingDelete({
          projectId,
          mode,
          physical: false,
          impact: {
            physical: { exclusive_asset_count: 0, exclusive_file_count: 0, preserved_shared_count: 0, preserved_unsafe_count: 0, confirmation: "" },
            project_asset_count: 0,
            thread_count: 0,
            node_count: 0,
            running_generation_count: 0,
            running_agent_count: 0,
          },
        });
        close();
        return;
      }
      const impact = await api.projectDeleteImpact(projectId);
      setPendingDelete({ projectId, impact, mode, physical: false });
      close();
    } catch (error) {
      notifyError(error, "无法读取项目删除影响");
    } finally {
      setBusy(false);
    }
  }


  return { busy, prepareDelete, confirmation: (<ConfirmDialog
        open={pendingDelete !== null}
        danger
        title={pendingDelete?.mode === "discard-provisional" ? "丢弃未保存项目" : "删除项目及画板"}
        message={
          pendingDelete?.mode === "discard-provisional" ? (
            <>将丢弃这块尚未保存的空白画板；中央素材不受影响。此操作<strong>不可恢复</strong>。</>
          ) : (
            <>
              将删除 1 块项目画板、{pendingDelete?.impact.thread_count ?? 0} 条创作线程和 {pendingDelete?.impact.node_count ?? 0} 个节点；
              默认保留中央素材。账单与底层执行审计始终保留。
              <label className="mt-3 flex items-start gap-2 rounded-lg border border-edge p-3 text-ink">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={pendingDelete?.physical ?? false}
                  disabled={!pendingDelete?.impact.physical.exclusive_asset_count}
                  onChange={(event) => setPendingDelete((pending) => pending && ({ ...pending, physical: event.target.checked }))}
                />
                <span>
                  <strong>物理删除独有文件</strong><br />
                  可删除 {pendingDelete?.impact.physical.exclusive_asset_count ?? 0} 项独有素材、{pendingDelete?.impact.physical.exclusive_file_count ?? 0} 个文件（含缩略图）。<br />
                  保留 {pendingDelete?.impact.physical.preserved_shared_count ?? 0} 项共享或被引用的素材；另保留 {pendingDelete?.impact.physical.preserved_unsafe_count ?? 0} 项路径不安全或文件缺失的素材。<br />
                  <span className="text-muted">引用核验包含其他画板、草稿、生成记录、收藏与视觉设定；用户原始文件保留。</span>
                </span>
              </label>
              {pendingDelete?.physical && <span className="mt-2 block text-red-400">将永久删除这些中央素材及其文件，不进入回收站，无法恢复。</span>}
              {((pendingDelete?.impact.running_generation_count ?? 0) + (pendingDelete?.impact.running_agent_count ?? 0)) > 0
                ? <> 当前还有 <strong>{(pendingDelete?.impact.running_generation_count ?? 0) + (pendingDelete?.impact.running_agent_count ?? 0)} 个任务未完成或待入库，暂不可删除。</strong></>
                : <> 此操作<strong>不可恢复</strong>。</>}
            </>
          )
        }
        confirmLabel={pendingDelete?.mode === "discard-provisional"
          ? "丢弃项目"
          : ((pendingDelete?.impact.running_generation_count ?? 0) + (pendingDelete?.impact.running_agent_count ?? 0)) > 0
            ? "仍有未完成任务"
            : pendingDelete?.physical ? "删除项目并永久删除文件" : "删除项目，保留素材"}
        confirmDisabled={((pendingDelete?.impact.running_generation_count ?? 0) + (pendingDelete?.impact.running_agent_count ?? 0)) > 0}
        onConfirm={() => {
          const pending = pendingDelete;
          setPendingDelete(null);
          if (pending) void remove(pending.projectId, pending.mode, pending.physical, pending.impact.physical.confirmation);
        }}
        onCancel={() => setPendingDelete(null)}
      />) };
}
