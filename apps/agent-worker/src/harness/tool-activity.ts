/** Parent-owned activity; tool/provider timeouts remain authoritative while a tool is running. */
export class ToolActivity {
  private pending = 0;
  private lastProgressAt = 0;
  private readonly now: () => number;
  constructor(now = Date.now) { this.now = now; }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.pending++;
    try { return await work(); }
    finally { this.pending--; this.lastProgressAt = this.now(); }
  }
  remaining(startedAt: number, timeoutMs: number): number {
    return this.pending ? timeoutMs : timeoutMs - (this.now() - Math.max(startedAt, this.lastProgressAt));
  }
}

export async function withToolActivityTimeout<T>(promise: Promise<T>, timeoutMs: number, activity: ToolActivity): Promise<T> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    const check = () => {
      const remaining = activity.remaining(startedAt, timeoutMs);
      if (remaining <= 0) reject(new Error("dsh_acp_prompt_timeout"));
      else timer = setTimeout(check, Math.min(remaining, 1000));
    };
    check();
  });
  try { return await Promise.race([promise, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}
