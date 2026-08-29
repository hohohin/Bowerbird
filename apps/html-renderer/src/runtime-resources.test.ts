import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeResourceSnapshot } from "./runtime-resources.ts";

test("reports cgroup-wide peak resources without content", () => {
  const values = new Map([
    ["/sys/fs/cgroup/memory.current", "1048576\n"],
    ["/sys/fs/cgroup/memory.peak", "2097152\n"],
    ["/sys/fs/cgroup/pids.current", "8\n"],
    ["/sys/fs/cgroup/pids.peak", "12\n"],
  ]);
  const snapshot = runtimeResourceSnapshot(
    (path) => {
      const value = values.get(path);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    { rss: 512, heapTotal: 384, heapUsed: 256, external: 0, arrayBuffers: 0 },
  );
  assert.deepEqual(snapshot, {
    processRssBytes: 512,
    processHeapUsedBytes: 256,
    cgroupMemoryCurrentBytes: 1048576,
    cgroupMemoryPeakBytes: 2097152,
    cgroupPidsCurrent: 8,
    cgroupPidsPeak: 12,
  });
});

test("unavailable or non-numeric cgroup values become null", () => {
  const snapshot = runtimeResourceSnapshot(
    (path) => {
      if (path.endsWith("memory.current")) return "max\n";
      throw new Error("not available");
    },
    { rss: 1, heapTotal: 1, heapUsed: 1, external: 0, arrayBuffers: 0 },
  );
  assert.equal(snapshot.cgroupMemoryCurrentBytes, null);
  assert.equal(snapshot.cgroupMemoryPeakBytes, null);
  assert.equal(snapshot.cgroupPidsCurrent, null);
  assert.equal(snapshot.cgroupPidsPeak, null);
});
