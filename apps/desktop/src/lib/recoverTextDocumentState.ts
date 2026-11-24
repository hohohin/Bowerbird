import type { DocumentStateMismatch } from './documentState';
import { serializeMarkdownInWorker } from './documentSerialization';
import { openTextDocument } from './recentTextDocuments';

export async function recoverTextDocumentState(title: string, mismatch: DocumentStateMismatch) {
  const markdown = await serializeMarkdownInWorker(mismatch.value);
  return openTextDocument({ title: `${title.trim() || '文档'}（富状态草稿）`, markdown });
}
