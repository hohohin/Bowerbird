import { convertFileSrc, invoke } from '@tauri-apps/api/core';
interface Attachment { id: string; path: string }
export async function saveDocumentAttachment(file: File) {
  if (file.size > 50 * 1024 * 1024) throw new Error('文档附件不能超过 50 MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 65536) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 65536)));
  const attachment = await invoke<Attachment>('save_document_attachment', { name: file.name, data: btoa(chunks.join('')) });
  return { name: file.name, attachmentId: attachment.id, url: convertFileSrc(attachment.path) };
}
export async function resolveDocumentAttachment(id: string) {
  const attachment = await invoke<Attachment>('resolve_document_attachment', { id });
  return convertFileSrc(attachment.path);
}
