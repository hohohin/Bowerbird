/**
 * 无内容运行资源快照 —— H6-T2。
 *
 * Linux 容器优先读取 cgroup v2，因此 Chromium 子进程也包含在内；本地开发环境
 * 没有这些文件时保留 Node 进程 RSS/heap，并将容器字段置为 null。
 */
import { readFileSync } from "node:fs";

export type RuntimeResourceSnapshot = {
  processRssBytes: number;
  processHeapUsedBytes: number;
  cgroupMemoryCurrentBytes: number | null;
  cgroupMemoryPeakBytes: number | null;
  cgroupPidsCurrent: number | null;
  cgroupPidsPeak: number | null;
};

type ReadText = (path: string) => string;

function readNonNegativeInteger(readText: ReadText, path: string): number | null {
  try {
    const value = Number(readText(path).trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

export function runtimeResourceSnapshot(
  readText: ReadText = (path) => readFileSync(path, "utf8"),
  memoryUsage = process.memoryUsage(),
): RuntimeResourceSnapshot {
  return {
    processRssBytes: memoryUsage.rss,
    processHeapUsedBytes: memoryUsage.heapUsed,
    cgroupMemoryCurrentBytes: readNonNegativeInteger(readText, "/sys/fs/cgroup/memory.current"),
    cgroupMemoryPeakBytes: readNonNegativeInteger(readText, "/sys/fs/cgroup/memory.peak"),
    cgroupPidsCurrent: readNonNegativeInteger(readText, "/sys/fs/cgroup/pids.current"),
    cgroupPidsPeak: readNonNegativeInteger(readText, "/sys/fs/cgroup/pids.peak"),
  };
}
