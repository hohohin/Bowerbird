import type { RecentTextDocument } from './recentTextDocuments';

export type AutosaveStatus = 'saved' | 'saving' | 'error';
type StagedDocument = { capture: () => void; prepare?: () => Promise<() => void> };
/** One writer per open document. A completed older write never replaces newer input. */
export class TextDocumentAutosave {
  private current: RecentTextDocument;
  private generation = 0;
  private savedGeneration = 0;
  private writing?: Promise<void>;
  private staged?: StagedDocument;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(entry: RecentTextDocument, private save: (entry: RecentTextDocument) => Promise<RecentTextDocument>,
    private report: (status: AutosaveStatus, error?: unknown) => void) { this.current = entry; }
  get document() { this.capture(); return this.current; }
  get pending() { return !!this.staged || this.generation !== this.savedGeneration; }
  capture = () => { if (this.staged) this.apply(this.staged, this.staged.capture); };
  private apply(staged: StagedDocument, materialize: () => void) {
    this.staged = undefined;
    try { materialize(); }
    catch (error) {
      this.staged ??= staged;
      this.report('error', error);
      throw error;
    }
  }
  stage(capture: () => void, prepare?: () => Promise<() => void>) {
    this.staged = { capture, prepare };
    this.schedule();
  }
  private async captureInBackground(staged: StagedDocument) {
    try {
      const materialize = await staged.prepare!();
      if (staged === this.staged) this.apply(staged, materialize);
    } catch (error) {
      if (staged === this.staged) throw error;
    }
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
      if (this.staged?.prepare) await this.captureInBackground(this.staged);
      else this.capture();
      if (this.staged) continue;
      if (!this.pending) break;
      const generation = this.generation;
      const saved = await this.save(this.current);
      this.current = { ...this.current, revision: saved.revision, updatedAt: saved.updatedAt };
      this.savedGeneration = generation;
    }
  }
}
