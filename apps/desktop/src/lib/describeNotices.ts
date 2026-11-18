import { create } from "zustand";
import { api } from "./api";

export interface DescribeNotice {
  source: "describe";
  id: string;
  assetId: string;
  title: string;
  status: "running" | "completed" | "failed" | "cancelled";
  statusLabel: string;
  updatedAt: number;
  dismissKey?: string;
}

export const useDescribeNotices = create<{ tasks: DescribeNotice[] }>(() => ({ tasks: [] }));

export async function describeAssetWithNotice(assetId: string, name: string, instruction: string, provider?: string, jobId?: string) {
  const id = jobId ?? crypto.randomUUID();
  const task: DescribeNotice = { source: "describe", id, assetId, title: name, status: "running", statusLabel: "反推中", updatedAt: Date.now() };
  useDescribeNotices.setState(({ tasks }) => ({ tasks: [task, ...tasks] }));
  let status: "completed" | "failed" | "cancelled" = "completed";
  try {
    return await api.describeAsset(assetId, instruction, provider, jobId);
  } catch (error) {
    status = String(error).includes("已取消") ? "cancelled" : "failed";
    throw error;
  } finally {
    const statusLabel = { completed: "已完成", failed: "失败", cancelled: "已取消" }[status];
    const ended = { ...task, status, statusLabel, updatedAt: Date.now(), dismissKey: `describe:${id}` };
    useDescribeNotices.setState(({ tasks }) => ({
      tasks: [...tasks.filter(item => item.status === "running" && item.id !== id),
        ended, ...tasks.filter(item => item.status !== "running").slice(0, 19)],
    }));
  }
}
