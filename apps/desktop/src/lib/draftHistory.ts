export type DraftHistoryEntry = {
  undo: () => void;
  redo: () => void;
  /** Retained bytes, including both the before and after state. */
  bytes: number;
};

/** An entry is one completed edit. View changes and in-progress gestures stay outside history. */
export class DraftHistory {
  private past: DraftHistoryEntry[] = [];
  private future: DraftHistoryEntry[] = [];
  private retainedBytes = 0;
  private readonly maxBytes: number;
  private readonly maxSteps: number;

  constructor(maxBytes = 128 * 1024 * 1024, maxSteps = 100) {
    this.maxBytes = Math.max(0, Math.floor(maxBytes));
    this.maxSteps = Math.max(0, Math.floor(maxSteps));
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get bytes(): number { return this.retainedBytes; }

  push(entry: DraftHistoryEntry): void {
    if (!Number.isFinite(entry.bytes) || entry.bytes < 0) throw new Error("撤销记录大小无效");
    this.retainedBytes -= this.future.reduce((sum, item) => sum + item.bytes, 0);
    this.future = [];
    // Keeping older entries after an unrecorded edit would undo across a missing dependency.
    // The edit itself stays applied, but an oversized operation becomes the new history base.
    if (entry.bytes > this.maxBytes || this.maxSteps === 0) {
      this.clear();
      return;
    }
    this.past.push(entry);
    this.retainedBytes += entry.bytes;
    while (this.retainedBytes > this.maxBytes || this.past.length > this.maxSteps) {
      this.retainedBytes -= this.past.shift()!.bytes;
    }
  }

  undo(): boolean {
    const entry = this.past[this.past.length - 1];
    if (!entry) return false;
    entry.undo();
    this.past.pop();
    this.future.push(entry);
    return true;
  }

  redo(): boolean {
    const entry = this.future[this.future.length - 1];
    if (!entry) return false;
    entry.redo();
    this.future.pop();
    this.past.push(entry);
    return true;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.retainedBytes = 0;
  }
}
