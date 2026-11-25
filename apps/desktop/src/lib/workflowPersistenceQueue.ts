import { api } from "./api";
import { emptyWorkflow, type CanvasWorkflow, type WorkflowRun } from "./canvasWorkflow";
import { mergeWorkflowChanges } from "./workflowExternalChanges";

interface WorkflowPersistenceHost {
  readonly projectId: string;
  document: CanvasWorkflow;
  revision: number;
  readonly discarded: boolean;
  readonly error: string;
  liveGenerationCheckpoint(nodeId: string, run: WorkflowRun): boolean;
  changed(promptEditor?: string): void;
  saved(previous: CanvasWorkflow, next: CanvasWorkflow): void;
  writeSettled(promptEditor?: string): void;
  refreshed(previous: CanvasWorkflow, next: CanvasWorkflow): void;
  refreshSettled(): void;
}

const promptSaveDelay = 180;

export class WorkflowPersistenceQueue {
  private writing: Promise<void> = Promise.resolve();
  private persistedDocument = emptyWorkflow();
  private queuedDocument = this.persistedDocument;
  private queuedWriteVersion = 0;
  private queuedDraft?: { draft: { nodeId: string; document: CanvasWorkflow; authorizeEdit: boolean }; result: Promise<void>; release: () => void; debounce?: () => void };
  private failedWrite?: { base: CanvasWorkflow; authorizeEdit: boolean; saveError: string };

  constructor(private readonly host: WorkflowPersistenceHost) {}

  get error() { return this.failedWrite?.saveError; }

  reset(document: CanvasWorkflow) {
    this.persistedDocument = document;
    this.queuedDocument = document;
    this.failedWrite = undefined;
  }

  releaseDraft() { this.queuedDraft?.release(); }

  async settle() {
    const writing = this.writing;
    const draft = this.queuedDraft;
    this.queuedDraft = undefined;
    draft?.release();
    await writing;
  }

  async save(document: CanvasWorkflow, authorizeEdit: boolean, draftNodeId?: string, editorOnly = false) {
    const promptEditor = editorOnly ? draftNodeId : undefined;
    this.host.document = document;
    this.queuedWriteVersion++;
    const initial = document;
    const base = this.queuedDocument;
    this.queuedDocument = initial;
    const queuedDraft = this.queuedDraft;
    if (draftNodeId && queuedDraft?.draft.nodeId === draftNodeId && !!queuedDraft.debounce === editorOnly) {
      queuedDraft.draft.document = initial;
      queuedDraft.draft.authorizeEdit ||= authorizeEdit;
      queuedDraft.debounce?.();
      this.host.changed(promptEditor);
      return queuedDraft.result;
    }
    // Only successive prompt edits to the same card may share a pending write.
    // An in-flight save, a structural edit or a run checkpoint is a boundary.
    queuedDraft?.release();
    const draft = draftNodeId ? { nodeId: draftNodeId, document: initial, authorizeEdit } : undefined;
    let release = () => {}, debounce: (() => void) | undefined;
    const delay = draft && editorOnly ? new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      release = () => { clearTimeout(timer); resolve(); };
      debounce = () => { clearTimeout(timer); timer = setTimeout(release, promptSaveDelay); };
      debounce();
    }) : undefined;
    const result = this.writing.then(async () => {
      if (delay) await delay;
      if (this.queuedDraft?.draft === draft) this.queuedDraft = undefined;
      const snapshot = draft?.document ?? initial;
      if (this.host.discarded) return;
      let writeBase = this.failedWrite?.base ?? base;
      const needsAuthorization = (draft?.authorizeEdit ?? authorizeEdit) || !!this.failedWrite?.authorizeEdit;
      let refreshBoard = !!this.host.error;
      try {
        if (needsAuthorization) await api.canvasWorkflowAuthorize();
        let merged = mergeWorkflowChanges(writeBase, snapshot, this.persistedDocument, this.host.liveGenerationCheckpoint);
        let mergeBase = this.persistedDocument, revision = this.host.revision;
        // A chat turn can append four batches while unrelated runs checkpoint.
        for (let conflicts = 0; ; conflicts++) {
          if (this.host.discarded) return;
          try {
            this.host.revision = await api.canvasWorkflowSave(this.host.projectId, revision, merged);
            break;
          } catch (error) {
            if (!String(error).includes("工作流已被其他窗口修改") || conflicts >= 4) throw error;
            refreshBoard = true;
            const latest = await api.canvasWorkflowGet(this.host.projectId);
            merged = mergeWorkflowChanges(mergeBase, merged, latest.document, this.host.liveGenerationCheckpoint);
            mergeBase = latest.document; revision = latest.revision;
          }
        }
        const previous = this.persistedDocument;
        this.persistedDocument = merged;
        // A successful native commit can still expose a conflict with a newer local edit.
        // Keep that edit's original base when reconciling with the committed document.
        writeBase = snapshot;
        this.host.document = mergeWorkflowChanges(snapshot, this.host.document, merged);
        if (this.queuedDocument === snapshot) this.queuedDocument = merged;
        this.failedWrite = undefined;
        this.host.saved(previous, merged);
      } catch (error) {
        this.failedWrite = { base: writeBase, authorizeEdit: needsAuthorization, saveError: `工作流未保存：${String(error)}` };
        throw error;
      } finally {
        this.host.writeSettled(refreshBoard || this.host.error ? undefined : promptEditor);
      }
    });
    this.queuedDraft = draft && { draft, result, release, debounce };
    this.writing = result.catch(() => {});
    this.host.changed(promptEditor);
    return result;
  }
  async refresh() {
    // A refresh must not replace the merge base of an in-flight save/CAS retry.
    this.queuedDraft?.release();
    this.queuedDraft = undefined;
    const version = this.queuedWriteVersion;
    const refresh = this.writing.then(async () => {
      const latest = await api.canvasWorkflowGet(this.host.projectId);
      // A write queued during the read will reconcile the newer revision in its CAS retry.
      if (this.host.discarded || version !== this.queuedWriteVersion || latest.revision <= this.host.revision) return;
      const document = mergeWorkflowChanges(this.failedWrite?.base ?? this.persistedDocument, this.host.document, latest.document, this.host.liveGenerationCheckpoint);
      const queued = mergeWorkflowChanges(this.failedWrite?.base ?? this.persistedDocument, this.queuedDocument, latest.document, this.host.liveGenerationCheckpoint);
      const previous = this.host.document;
      this.host.document = document;
      this.persistedDocument = structuredClone(latest.document);
      this.host.revision = latest.revision;
      if (this.failedWrite) this.failedWrite.base = this.persistedDocument;
      // Rebase queued snapshots without treating unsaved live progress as persisted.
      this.queuedDocument = structuredClone(queued);
      this.host.refreshed(previous, document);
    });
    this.writing = refresh.catch(() => {});
    try { await refresh; }
    finally { this.host.refreshSettled(); }
  }
}
