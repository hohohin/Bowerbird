import type { RecentTextDocument } from './recentTextDocuments';

export type AutosaveStatus = 'saved' | 'saving' | 'error';
/** One writer per open document. A completed older write never replaces newer input. */
export class TextDocumentAutosave {
  private current: RecentTextDocument;
  private generation = 0;
  private savedGeneration = 0;
  private writing?: Promise<void>;
  private staged?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(entry: RecentTextDocument, private save: (entry: RecentTextDocument) => Promise<RecentTextDocument>,
    private report: (status: AutosaveStatus, error?: unknown) => void) { this.current = entry; }
  get document() { this.capture(); return this.current; }
  get pending() { return !!this.staged || this.generation !== this.savedGeneration; }
  capture = () => {
    const materialize = this.staged;
    this.staged = undefined;
    try { materialize?.(); }
    catch (error) {
      this.staged ??= materialize;
      this.report('error', error);
      throw error;
    }
  };
  stage(materialize: () => void) {
    this.staged = materialize;
    this.schedule();
  }
  cancelScheduled() { clearTimeout(this.timer); }
  update(entry: RecentTextDocument) {
    if (entry.title === this.current.title && entry.markdown === this.current.markdown && entry.sourceVersion === this.current.sourceVersion) return;
    this.current = { ...entry, revision: this.current.revision };
    this.generation++;
    this.schedule();
  }
  private schedule() {
    this.report('saving');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 300);
  }
  async flush(): Promise<void> {
    this.capture();
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
      this.capture();
      if (!this.pending) break;
      const generation = this.generation;
      const saved = await this.save(this.current);
      this.current = { ...this.current, revision: saved.revision, updatedAt: saved.updatedAt };
      this.savedGeneration = generation;
    }
  }
}
