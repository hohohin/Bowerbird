import { useEffect } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { notifyError } from "../lib/notify";
import { useStore } from "../store";
import { api } from "../lib/api";
import { canvasWorkflowController, existingWorkflowController, releaseInactiveWorkflowControllers, withProjectWorkflow } from "../lib/canvasWorkflowRuntime";
import { activeTriggerSchedule } from "../lib/workflowTriggerSchedule";

/** Restore appointments independently of the currently open canvas. */
export function WorkflowScheduleCoordinator() {
  const projects = useStore(state => state.projects);
  const activeProjectId = useStore(state => state.activeProjectId);
  useEffect(releaseInactiveWorkflowControllers, [activeProjectId]);
  useEffect(() => {
    let alive = true;
    const listening = listen<string>("local-chat://start-card", async ({ payload: actionId }) => {
      if (!alive) return;
      try {
        const target = await invoke<[string, string] | null>("local_chat_claim_card_run", { actionId });
        if (!target) return;
        const [projectId, nodeId] = target;
        await withProjectWorkflow(projectId, async controller => {
          await controller.refreshExternalCards();
          const node = controller.document.nodes.find(node => node.id === nodeId);
          if (!node) throw new Error("运行目标已从画板移除");
          await controller.start(node.id, node.kind !== "trigger", true);
        });
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
    return () => {
      alive = false;
      void listening.then(unlisten => unlisten());
      void schedules.then(unlisten => unlisten());
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const active = projects.filter(project => project.archived_at == null && !project.provisional);
    for (const project of active) {
      const controller = existingWorkflowController(project.id);
      controller?.setTriggerTimersEnabled(true);
      if (!controller?.ready) void api.canvasWorkflowGet(project.id).then(snapshot => {
        if (!cancelled && snapshot.document.nodes.some(node => activeTriggerSchedule(node)?.status === "armed")) return canvasWorkflowController(project.id).load();
      }).catch(error => console.warn("读取工作流定时设置失败", error));
    }
    return () => { cancelled = true; active.forEach(project => existingWorkflowController(project.id)?.setTriggerTimersEnabled(false)); };
  }, [projects]);
  return null;
}
