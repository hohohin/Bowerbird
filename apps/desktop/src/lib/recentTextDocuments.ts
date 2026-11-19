import type { TextWorkspaceDocument } from './documentTypes';

export interface TextDocumentOrigin { key: string; version: string; followsChanges?: boolean }
export interface RecentTextDocument extends TextWorkspaceDocument {
  id: string;
  revision: number;
  updatedAt: number;
  sourceKey?: string;
  sourceVersion?: string;
}
export type RecentTextSummary = Pick<RecentTextDocument, 'id' | 'title' | 'updatedAt'>;
export const textDocumentVersion = (document: TextWorkspaceDocument) => JSON.stringify([document.title, document.markdown]);

let connection: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  if (connection) return connection;
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('bowerbird.text-documents', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('documents', { keyPath: 'id' });
      store.createIndex('updated', 'updatedAt');
      store.createIndex('source', ['sourceKey', 'updatedAt']);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('文档库正在升级，请关闭其他 Bowerbird 窗口后重试。'));
  }).catch(error => { connection = undefined; throw error; });
  return connection;
}

async function read<T>(operation: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('documents');
    let result: T;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
    operation(transaction.objectStore('documents'), value => { result = value; });
  });
}

export function listRecentTextDocuments(limit = 50): Promise<RecentTextSummary[]> {
  return read((store, done) => {
    const items: RecentTextSummary[] = [];
    const request = store.index('updated').openCursor(null, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || items.length === limit) { done(items); return; }
      const entry = cursor.value as RecentTextDocument;
      items.push({ id: entry.id, title: entry.title, updatedAt: entry.updatedAt });
      cursor.continue();
    };
  });
}

function latestFromSource(origin: TextDocumentOrigin): Promise<RecentTextDocument | undefined> {
  return read((store, done) => {
    const request = store.index('source').openCursor(IDBKeyRange.bound([origin.key, 0], [origin.key, Number.MAX_SAFE_INTEGER]), 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || cursor.value.sourceVersion === origin.version) { done(cursor?.value); return; }
      cursor.continue();
    };
  });
}

async function write(id: string, change: (previous: RecentTextDocument | undefined) => RecentTextDocument): Promise<RecentTextDocument> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('documents', 'readwrite', { durability: 'strict' });
    const store = transaction.objectStore('documents');
    let saved: RecentTextDocument;
    transaction.oncomplete = () => resolve(saved);
    transaction.onabort = () => reject(transaction.error ?? new Error('自动保存未完成，请重试。'));
    transaction.onerror = () => reject(transaction.error);
    const request = store.get(id);
    request.onsuccess = () => {
      try { saved = change(request.result); store.put(saved); }
      catch (error) { reject(error); transaction.abort(); }
    };
  });
}

export function saveRecentTextDocument(entry: RecentTextDocument): Promise<RecentTextDocument> {
  return write(entry.id, previous => {
    if (previous && previous.revision !== entry.revision) throw new Error('这篇文档已在其他窗口更新。可以另存草稿，保留当前内容。');
    return { ...entry, revision: entry.revision + 1, updatedAt: Date.now() };
  });
}

export function visitRecentTextDocument(id: string): Promise<RecentTextDocument> {
  return write(id, previous => {
    if (!previous) throw new Error('这篇文档已不可用，请重新打开最近文档。');
    return { ...previous, updatedAt: Date.now() };
  });
}

export async function openTextDocument(initial: TextWorkspaceDocument, origin?: TextDocumentOrigin): Promise<RecentTextDocument> {
  const previous = origin ? await latestFromSource(origin) : undefined;
  if (previous) return visitRecentTextDocument(previous.id);
  return saveRecentTextDocument({ ...initial, id: crypto.randomUUID(), revision: 0, updatedAt: Date.now(),
    ...(origin ? { sourceKey: origin.key, sourceVersion: origin.version } : {}) });
}
