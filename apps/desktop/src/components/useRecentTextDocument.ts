import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { DocumentValue, TextWorkspaceDocument } from '../lib/documentTypes';
import { parseMarkdown, serializeMarkdown } from '../lib/documentCodec';
import { openTextDocument, visitRecentTextDocument, saveRecentTextDocument, textDocumentVersion, type RecentTextDocument, type TextDocumentOrigin } from '../lib/recentTextDocuments';
import { TextDocumentAutosave, type AutosaveStatus } from '../lib/textDocumentAutosave';
import { userErrorMessage } from '../lib/userError';

type WriterRef = MutableRefObject<TextDocumentAutosave | undefined>;
type Report = (status: AutosaveStatus, error?: unknown) => void;
function initialEntry(initial: TextWorkspaceDocument, origin?: TextDocumentOrigin): RecentTextDocument {
  return { ...initial, id: crypto.randomUUID(), revision: 0, updatedAt: Date.now(), sourceKey: origin?.key, sourceVersion: origin?.version };
}
function useAutosaveExit(writer: WriterRef) {
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const flush = () => { void writer.current?.flush().catch(() => {}); };
    const exiting = (event: BeforeUnloadEvent) => {
      if (!writer.current?.pending) return;
      flush(); event.preventDefault(); event.returnValue = '';
    };
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('beforeunload', exiting); document.addEventListener('visibilitychange', hidden);
    return () => { live.current = false; flush(); window.removeEventListener('beforeunload', exiting); document.removeEventListener('visibilitychange', hidden); };
  }, [writer]);
  return live;
}
function useAutosaveFeedback(live: MutableRefObject<boolean>) {
  const [status, setStatus] = useState<AutosaveStatus>('saving'), [error, setError] = useState('');
  const report: Report = (next, reason) => {
    if (!live.current) return;
    setStatus(next); setError(reason ? userErrorMessage(reason, '文档暂时无法保存，请重试；当前内容仍保留。') : '');
  };
  return { status, error, report };
}
function useDocumentOpening(initial: TextWorkspaceDocument, origin: TextDocumentOrigin | undefined, receive: (entry: RecentTextDocument) => void, fail: (reason: unknown) => void) {
  const opening = useRef<Promise<RecentTextDocument>>(), live = useRef(true);
  const deliver = (request: Promise<RecentTextDocument>) => request.then(entry => { if (live.current) receive(entry); }, reason => { if (live.current) fail(reason); throw reason; });
  useEffect(() => {
    let active = true; live.current = true;
    opening.current ??= openTextDocument(initial, origin);
    void opening.current.then(entry => { if (active) receive(entry); }, reason => { if (active) fail(reason); });
    return () => { active = false; live.current = false; };
  }, []);
  return () => deliver(openTextDocument(initial, origin));
}
function useRecentSelection(writer: WriterRef, live: MutableRefObject<boolean>, attach: (entry: RecentTextDocument) => void, report: Report) {
  const selection = useRef(0);
  useEffect(() => () => { selection.current++; }, []);
  return async (id: string) => {
    const request = ++selection.current;
    try {
      await writer.current?.flush();
      const entry = await visitRecentTextDocument(id);
      await writer.current?.flush();
      if (!live.current || request !== selection.current || id === writer.current?.document.id) return;
      attach(entry); report('saved');
    } catch (reason) { report('error', reason); }
  };
}
async function copyDraft(writer: WriterRef, bound: MutableRefObject<{ id: string; document: TextWorkspaceDocument }>, live: MutableRefObject<boolean>, adopt: (saved: RecentTextDocument, latest: TextWorkspaceDocument) => void) {
  const previous = writer.current;
  if (!previous) return;
  const { title, markdown } = previous.document;
  const saved = await openTextDocument({ title, markdown });
  const source = await visitRecentTextDocument(previous.document.id).catch(() => undefined);
  if (!live.current) return;
  if (source && source.id === bound.current.id) bound.current.document = source;
  previous.cancelScheduled();
  adopt(saved, previous.document);
  await writer.current?.flush();
}

export function useRecentTextDocument(initial: TextWorkspaceDocument, origin: TextDocumentOrigin | undefined, onChange?: (document: TextWorkspaceDocument, context: { isSourceDocument: boolean }) => void) {
  const [draft, setDraft] = useState(() => initialEntry(initial, origin));
  const [value, setValue] = useState(() => parseMarkdown(initial.markdown)), [ready, setReady] = useState(false);
  const current = useRef<TextWorkspaceDocument>(initial), bound = useRef({ id: draft.id, document: initial });
  const writer = useRef<TextDocumentAutosave>();
  const live = useAutosaveExit(writer), { status, error, report } = useAutosaveFeedback(live);
  const changed = useRef(onChange); changed.current = onChange;
  function attach(entry: RecentTextDocument) {
    writer.current = new TextDocumentAutosave(entry, saveRecentTextDocument, report);
    current.current = entry; setDraft(entry); setValue(parseMarkdown(entry.markdown));
  }
  const reopen = useDocumentOpening(initial, origin, entry => {
    bound.current = { id: entry.id, document: entry };
    attach(entry); report('saved'); update(entry); setReady(true);
  }, reason => report('error', reason));
  function update(next: TextWorkspaceDocument) {
    const save = writer.current;
    if (!save) return;
    const entry = { ...save.document, title: next.title, markdown: next.markdown };
    current.current = entry; setDraft(entry);
    if (entry.id === bound.current.id) {
      bound.current.document = entry;
      if (origin?.followsChanges) entry.sourceVersion = textDocumentVersion(entry);
    }
    save.update(entry);
    changed.current?.(entry, { isSourceDocument: entry.id === bound.current.id });
  }
  function changeValue(next: DocumentValue) { setValue(next); update({ ...current.current, markdown: serializeMarkdown(next) }); }
  async function flush() { if (writer.current) await writer.current.flush(); else await reopen(); }
  const choose = useRecentSelection(writer, live, attach, report);
  return { draft, value, current, bound, ready, status, error, update, changeValue, flush, choose,
    retry: flush,
    copy: () => {
      report('saving');
      return copyDraft(writer, bound, live, (saved, latest) => { attach(saved); setValue(parseMarkdown(latest.markdown)); report('saved'); update(latest); })
        .catch(reason => report('error', reason));
    },
    isSourceDocument: () => writer.current?.document.id === bound.current.id };
}
