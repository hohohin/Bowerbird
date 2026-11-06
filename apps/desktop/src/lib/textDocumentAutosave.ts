import type { RecentTextDocument } from './recentTextDocuments';

export type AutosaveStatus = 'saved' | 'saving' | 'error';
/** One writer per open document. A completed older write never replaces newer input. */
export class TextDocumentAutosave {
  private current: RecentTextDocument;
  private generation = 0;
  private savedGeneration = 0;
  private writing?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(entry: RecentTextDocument, private save: (entry: RecentTextDocument) => Promise<RecentTextDocument>,
    private report: (status: AutosaveStatus, error?: unknown) => void) { this.current = entry; }
  get document() { return this.current; }
  get pending() { return this.generation !== this.savedGeneration; }
  cancelScheduled() { clearTimeout(this.timer); }
  update(entry: RecentTextDocument) {
    if (entry.title === this.current.title && entry.markdown === this.current.markdown && entry.sourceVersion === this.current.sourceVersion) return;
    this.current = { ...entry, revision: this.current.revision };
    this.generation++;
    this.report('saving');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 300);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.writing) { await this.writing; if (this.pending) return this.flush(); return; }
    if (!this.pending) return;
    this.report('saving');
    this.writing = this.drain();
    try { await this.writing; this.report('saved'); }
    catch (error) { this.report('error', error); throw error; }
    finally { this.writing = undefined; }
  }
  private async drain() {
    while (this.pending) {
      const generation = this.generation;
      const saved = await this.save(this.current);
      this.current = { ...this.current, revision: saved.revision, updatedAt: saved.updatedAt };
      this.savedGeneration = generation;
    }
  }
}
