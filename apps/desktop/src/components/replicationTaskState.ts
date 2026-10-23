import { invoke } from "@tauri-apps/api/core";
import type { ReplicationWorkflowRequest } from "../lib/videoReplication";
import type { VideoFrame } from "../lib/videoFrame";
export const replicationSteps = ["获取视频", "分析视频", "提供改写方向", "改写完成"];
export const replicationSourceKey = "bowerbird.replication.source";
export const replicationCall = <T,>(projectId: string, action: string, data: unknown = {}) => invoke<T>("video_replication", { projectId, action, data });
export interface ReplicationDialogProps {
  projectId: string; onClose: () => void; ensureProject: () => Promise<void>;
  onCreateWorkflow?: (request: ReplicationWorkflowRequest) => Promise<void>;
  onAddFrame?: (frame: VideoFrame) => Promise<void>;
}
