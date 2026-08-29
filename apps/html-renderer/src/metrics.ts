/**
 * 无内容渲染指标 —— H5-T4。
 * 只聚合数字（计数/时延分位/错误码分布），绝不包含 HTML、资源或用户文本。
 * 挂进 /healthz 供 VPS 健康探测与容量观察；超限率 = too_large+busy 类错误码计数。
 */

const LATENCY_WINDOW = 256;

export type RenderMetricsSnapshot = {
  renders: number;
  okRenders: number;
  failedRenders: number;
  failuresByCode: Record<string, number>;
  lastRenderMs: number | null;
  p50RenderMs: number | null;
  p95RenderMs: number | null;
  maxRenderMs: number | null;
  /** 最近窗口内超过渲染时限的次数（防御性统计：renderTimeoutMs 以上）。 */
  overBudgetRenders: number;
};

export class RenderMetrics {
  #renders = 0;
  #ok = 0;
  #failed = 0;
  #failuresByCode: Record<string, number> = {};
  #latencies: number[] = [];
  #lastMs: number | null = null;
  #maxMs: number | null = null;
  #overBudget = 0;
  readonly #timeoutMs: number;

  constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
  }

  record(outcome: { ok: true } | { ok: false; code: string }, elapsedMs: number): void {
    this.#renders += 1;
    if (outcome.ok) {
      this.#ok += 1;
    } else {
      this.#failed += 1;
      this.#failuresByCode[outcome.code] = (this.#failuresByCode[outcome.code] ?? 0) + 1;
    }
    this.#lastMs = elapsedMs;
    if (this.#maxMs === null || elapsedMs > this.#maxMs) this.#maxMs = elapsedMs;
    if (elapsedMs > this.#timeoutMs) this.#overBudget += 1;
    this.#latencies.push(elapsedMs);
    if (this.#latencies.length > LATENCY_WINDOW) this.#latencies.shift();
  }

  snapshot(): RenderMetricsSnapshot {
    const sorted = [...this.#latencies].sort((a, b) => a - b);
    const percentile = (fraction: number): number | null =>
      sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
    return {
      renders: this.#renders,
      okRenders: this.#ok,
      failedRenders: this.#failed,
      failuresByCode: { ...this.#failuresByCode },
      lastRenderMs: this.#lastMs,
      p50RenderMs: percentile(0.5),
      p95RenderMs: percentile(0.95),
      maxRenderMs: this.#maxMs,
      overBudgetRenders: this.#overBudget,
    };
  }
}
