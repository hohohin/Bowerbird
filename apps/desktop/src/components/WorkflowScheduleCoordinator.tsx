import { useEffect } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { canvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { activeTriggerSchedule } from "../lib/workflowTriggerSchedule";

/** Restore appointments independently of the currently open canvas. */
export function WorkflowScheduleCoordinator() {
  const projects = useStore(state => state.projects);
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
