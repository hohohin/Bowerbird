import { useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import type { Project, ProjectDeleteMode } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { notifyError, notifySuccess } from "../lib/notify";

export function ProjectSection() {
  const projects = useStore((s) => s.projects);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const reloadProjects = useStore((s) => s.reloadProjects);
  const enterProject = useStore((s) => s.enterProject);
  const exitProject = useStore((s) => s.exitProject);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    // tour 第 1 步：默认定位到预设图目录的上一级（已释放到文档目录），让用户点进「初始引导」。
    const tourActive = useStore.getState().tourActive;
    const tourStep = useStore.getState().tourStep;
    let defaultPath: string | undefined;
    if (tourActive && tourStep === 1) {
      try {
        defaultPath = await api.releasePresetPack();
      } catch {
        /* 释放失败用系统默认路径 */
      }
    }
    const path = await api.pickFolder(defaultPath);
    if (!path) return;
    // 用户已点 OS「选择文件夹」→ 进入「导入中」步骤（step 2），等导入完成后【下一步】按钮才出现。
    if (tourActive && tourStep === 1) useStore.getState().setTourStep(2);
    setCreating(true);
    try {
      const result = await api.createProject(path);
      await reloadProjects();
      await enterProject(result.project.id);
      notifySuccess(`项目已创建，导入 ${result.imported_count} 张素材`);
      // 导入成功 → 标记完成，让「导入中」步骤的【下一步】按钮出现。
      if (useStore.getState().tourActive && useStore.getState().tourStep === 2) {
        useStore.getState().setTourImported(true);
      }
    } catch (error) {
      notifyError(error, "创建项目失败");
    } finally {
      setCreating(false);
    }
  }

  function resetDelete() {
    setDeletingId(null);
    setConfirmingId(null);
  }

  async function remove(project: Project, mode: ProjectDeleteMode) {
    setBusy(true);
    try {
      const result = await api.deleteProject(project.id, mode);
      if (currentProjectId === project.id) await exitProject();
      await reloadProjects();
      resetDelete();
      notifySuccess(
        mode === "keep"
          ? "项目已删除，素材仍保留在全局"
          : mode === "move_out"
            ? `已移出 ${result.moved_assets} 张素材回 workspace，保留 ${result.preserved_shared} 张共享素材` +
              (result.failed_moves.length > 0
                ? `；${result.failed_moves.length} 张移出失败已保留在全局`
                : "")
            : `已物理删除 ${result.deleted_assets} 张独占素材，保留 ${result.preserved_shared} 张共享素材`
      );
    } catch (error) {
      notifyError(error, "删除项目失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-5 border-b border-edge pb-5">
      <div className="panel-kicker mb-2 flex items-center justify-between">
        <span>项目</span>
        <button
          data-tour="new-project"
          onClick={create}
          disabled={creating}
          className="normal-case tracking-normal text-accent hover:opacity-80 disabled:opacity-50"
        >
          {creating ? "导入中…" : "+ 新建项目"}
        </button>
      </div>

      <div className="space-y-1">
        {projects.map((project) => {
          const active = project.id === currentProjectId;
          if (deletingId === project.id) {
            if (busy) {
              return (
                <div key={project.id} className="rounded bg-panel2 p-2 text-[10px] text-muted">
                  处理中…
                </div>
              );
            }
            return (
              <div key={project.id} className="settings-card p-2 text-[10px]">
                <div className="mb-1.5 text-muted">共享素材始终保留在全局</div>
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => remove(project, "keep")}
                    className="app-context-item px-2 py-1"
                  >
                    仅删除项目 · 素材留在全局
                  </button>
                  <button
                    onClick={() => remove(project, "move_out")}
                    className="app-context-item px-2 py-1"
                  >
                    删除项目并将文件移出园丁鸟 · 独占素材移回 workspace
                  </button>
                  <button
                    onClick={() => setConfirmingId(project.id)}
                    className="app-context-item is-danger px-2 py-1"
                  >
                    物理删除独占素材
                  </button>
                  <button onClick={resetDelete} className="text-muted hover:text-ink">
                    取消
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div
              key={project.id}
              data-tour={active ? "active-project" : undefined}
              className={`group rounded-lg px-2.5 py-2 ${
                active ? "bg-accent/10 ring-1 ring-accent/40" : "hover:bg-panel2"
              }`}
            >
              <div className="flex items-center gap-1">
                <button
                  onClick={() => enterProject(project.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-accent" : "bg-muted"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-ink">{project.name}</span>
                    <span className="block truncate text-[10px] text-muted">
                      {project.asset_count} 张素材
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => setDeletingId(project.id)}
                  className="px-1 text-xs text-muted opacity-0 hover:text-red-400 focus:opacity-100 group-hover:opacity-100"
                  title="删除项目"
                  aria-label={`删除项目 ${project.name}`}
                >
                  ✕
                </button>
              </div>
              {active && (
                <button
                  onClick={exitProject}
                  className="mt-1 w-full rounded bg-panel px-2 py-1 text-[10px] text-accent hover:bg-edge"
                >
                  退出项目 · 返回全局素材
                </button>
              )}
            </div>
          );
        })}
      </div>
      <ConfirmDialog
        open={confirmingId !== null}
        danger
        title="物理删除独占素材"
        message="项目的独占素材将从全局及所有项目物理删除，不可恢复；共享素材保留。"
        confirmLabel="物理删除"
        onConfirm={() => {
          const p = projects.find((x) => x.id === confirmingId);
          resetDelete();
          if (p) void remove(p, "delete_exclusive");
        }}
        onCancel={resetDelete}
      />
    </section>
  );
}
