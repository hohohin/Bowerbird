import type { Asset } from "./types";
import type { CanvasWorkflow, WorkflowNode, WorkflowRun, WorkflowStep, WorkflowValue } from "./canvasWorkflow";
import type { ComfyVideoProgress } from "./comfyVideo";

export type CardStart = { kind: "run" | "optimize"; current: () => boolean; cancel: () => void; release: () => void };

export interface WorkflowExecutionHost {
  readonly projectId: string;
  readonly document: CanvasWorkflow;
  run(id: string): WorkflowRun;
  isStopped(runId: string): boolean;
  stopBeforeDispatch(runId: string): Promise<void>;
  step(runId: string, id: string, patch: Partial<WorkflowStep>): Promise<void>;
  progress(runId: string, id: string, detail: string, comfyProgress?: ComfyVideoProgress): void;
  finish(runId: string, node: WorkflowNode, outputs: Record<string, WorkflowValue>, ports?: WorkflowNode["outputPorts"]): Promise<void>;
  save(document: CanvasWorkflow): Promise<void>;
  saveRun(run: WorkflowRun, nodes?: WorkflowNode[]): Promise<void>;
  subscribe(listener: () => void): () => void;
  refreshExternalCards(): Promise<void>;
  layoutNodes(): WorkflowNode[];
  withResource<T>(key: string, work: () => Promise<T>): Promise<T>;
  writeContentInput(runId: string, writer: WorkflowNode, value: WorkflowValue, halted: () => boolean, sessionId?: string): Promise<void>;
  deliverMediaAsset(run: WorkflowRun, node: WorkflowNode, asset: Asset, halted: () => boolean, resultId?: string): Promise<void>;
  deliverSubmittedSessions(runId: string, node: WorkflowNode, halted: () => boolean): Promise<boolean>;
  registerGenerationHandoff(id: string, handoff: { runId: string; jobId: string; turnKey: string }): void;
  registerProfileAbort(runId: string, abort: AbortController): void;
}
