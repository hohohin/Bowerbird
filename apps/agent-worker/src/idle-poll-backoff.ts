const DEFAULT_MAX_DELAY_MS = 60_000;
const MAX_EXPONENT = 16;

export class IdlePollBackoff {
  private consecutiveIdle = 0;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(baseDelayMs: number, maxDelayMs = DEFAULT_MAX_DELAY_MS) {
    if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) throw new Error("idle_poll_base_delay_invalid");
    if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs) throw new Error("idle_poll_max_delay_invalid");
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
  }

  nextDelayMs(): number {
    const exponent = Math.min(this.consecutiveIdle, MAX_EXPONENT);
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** exponent));
    this.consecutiveIdle = Math.min(this.consecutiveIdle + 1, MAX_EXPONENT);
    return delay;
  }

  reset(): void {
    this.consecutiveIdle = 0;
  }
}
