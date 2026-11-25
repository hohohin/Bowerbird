import type { GenerationAvailabilityState } from "./generationAvailability";

type DesktopState = ReturnType<typeof import("../store").useStore.getState>;

export type WorkflowHostState = GenerationAvailabilityState & Pick<DesktopState,
  | "activeProjectId" | "projectRouteRevision" | "projectRoutePending" | "settings"
  | "genJobs" | "defaultProvider" | "defaultUnderstandProvider" | "startGeneration" | "cancelDescribe"
  | "cloudAgentRuns" | "openCloudAgentRun" | "openVisualProfile">;

export interface WorkflowHostAdapter {
  getState(): WorkflowHostState;
  subscribe?(listener: (state: WorkflowHostState) => void): () => void;
}

let desktopHost: WorkflowHostAdapter | undefined;

export function configureWorkflowHost(host: WorkflowHostAdapter) { desktopHost = host; }

export function getWorkflowHost(): WorkflowHostAdapter {
  if (!desktopHost) throw new Error("工作流桌面环境尚未注册");
  return desktopHost;
}
