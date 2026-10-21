import type { ClassificationResult } from "./localClassification";

export interface ClassificationFloat {
  key: string;
  motion: "rise" | "exit";
  result: ClassificationResult;
  lane: number;
  x: number;
  tilt: number;
  drift: number;
  startY: number;
  duration: number;
  expiresAt: number;
}

/** View-only placement; never changes classification results or task scheduling. */
export function appendClassificationFloats(previous: ClassificationFloat[], incoming: ClassificationResult[], now: number, handoffs: ClassificationResult["asset"][] = []) {
  const completed = new Set(incoming.map(result => result.asset.id));
  const items = previous.filter(item => item.expiresAt > now && !(item.key.startsWith("cloud:") && completed.has(item.result.asset.id)));
  const events = [
    ...handoffs.filter(asset => !completed.has(asset.id)).map(asset => ({
      key: `cloud:${asset.id}`, result: { sequence: asset.position, asset, tags: [], error: null } as ClassificationResult,
    })),
    ...incoming.map(result => ({ key: `result:${result.sequence}`, result })),
  ];
  for (const { key, result } of events) {
    // Reserve one image slot for the current-processing dock.
    while (items.length >= 10) items.shift();
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const item of items) if (item.motion === "rise") counts[item.lane]++;
    const order = [3, 0, 6, 2, 5, 1, 4];
    const offset = result.sequence % order.length;
    const preferred = [...order.slice(offset), ...order.slice(0, offset)];
    const lane = preferred.reduce((best, candidate) => counts[candidate] < counts[best] ? candidate : best);
    const jitter = ((result.sequence * 17) % 11 - 5);
    const motion = result.tags.length ? "rise" : "exit";
    const duration = motion === "rise" ? 9200 + (result.sequence * 137) % 1600 : 1100;
    items.push({
      key, motion, result, lane, x: Math.max(0, Math.min(1, lane / 6 + jitter / 240)),
      tilt: jitter, drift: jitter * 1.6,
      startY: 170 - counts[lane] * 68 + jitter * 3,
      duration, expiresAt: now + duration,
    });
  }
  return items;
}
