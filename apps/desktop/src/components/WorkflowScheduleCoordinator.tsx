import { useEffect } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { notifyError } from "../lib/notify";
import { useStore } from "../store";
import { api } from "../lib/api";
import { canvasWorkflowController, notifyWorkflowSessionCompletion, setActiveWorkflowCanvas, wakeWorkflowSchedules } from "../lib/canvasWorkflowRuntime";
import { activeTriggerSchedule } from "../lib/workflowTriggerSchedule";
import type { CodexChunk } from "../lib/types";

/** Restore appointments independently of the currently open canvas. */
export function WorkflowScheduleCoordinator() {
  const projects = useStore(state => state.projects);
  const activeCanvasProject = useStore(state => state.projectRoutePending ? null : state.activeProjectId);
  useEffect(() => { setActiveWorkflowCanvas(activeCanvasProject); }, [activeCanvasProject]);
  useEffect(() => {
    let alive = true;
    const listening = listen<string>("local-chat://start-card", async ({ payload: actionId }) => {
      if (!alive) return;
      try {
        const target = await invoke<[string, string] | null>("local_chat_claim_card_run", { actionId });
        if (!target) return;
        const [projectId, nodeId] = target;
        const controller = canvasWorkflowController(projectId);
        await controller.refreshExternalCards();
        const node = controller.document.nodes.find(node => node.id === nodeId);
        if (!node) throw new Error("运行目标已从画板移除");
        await controller.start(node.id, node.kind !== "trigger", true);
      } catch (error) {
        notifyError(error, "卡片启动失败");
        await emit(`local-chat://run-result-${actionId}`, false);
        return;
      }
      await emit(`local-chat://run-result-${actionId}`, true);
    });
    const schedules = listen<{ projectId: string; scheduled?: boolean }>("local-chat://cards-changed", ({ payload }) => {
      if (alive && payload.scheduled) void canvasWorkflowController(payload.projectId).refreshExternalCards()
        .catch(error => notifyError(error, "读取触发卡预约失败"));
    });
    const canvasChanges = listen<{ projectId: string }>("creative://changed", ({ payload }) => {
      if (alive && payload.projectId) notifyWorkflowSessionCompletion(payload.projectId);
    });
    const generationEnds = listen<CodexChunk>("codex://chunk", ({ payload }) => {
      if (!alive || (payload.kind !== "done" && payload.kind !== "error") || !payload.job_id) return;
      const projectId = useStore.getState().genJobs[payload.job_id]?.projectId;
      if (projectId) notifyWorkflowSessionCompletion(projectId);
    });
    const wake = () => { if (document.visibilityState === "visible") wakeWorkflowSchedules(); };
    document.addEventListener("visibilitychange", wake);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", wake);
      void listening.then(unlisten => unlisten());
      void schedules.then(unlisten => unlisten());
      void canvasChanges.then(unlisten => unlisten());
      void generationEnds.then(unlisten => unlisten());
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const active = projects.filter(project => project.archived_at == null && !project.provisional);
    for (const project of active) {
      const controller = canvasWorkflowController(project.id);
      controller.setTriggerTimersEnabled(true);
      if (!controller.ready) void api.canvasWorkflowGet(project.id).then(snapshot => {
        if (!cancelled && snapshot.document.nodes.some(node => activeTriggerSchedule(node)?.status === "armed")) return controller.load();
      }).catch(error => console.warn("读取工作流定时设置失败", error));
    }
    return () => { cancelled = true; active.forEach(project => canvasWorkflowController(project.id).setTriggerTimersEnabled(false)); };
  }, [projects]);
  return null;
}
