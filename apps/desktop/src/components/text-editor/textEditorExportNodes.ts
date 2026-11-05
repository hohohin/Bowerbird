import { ElementApi, NodeApi, type TElement, type Value } from 'platejs';
import type { PlateEditor } from 'platejs/react';
import type { DocumentDrawingElement } from './plate/ui/excalidraw-node';

export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
export async function exportDataUrl(url: string) {
  if (url.startsWith('data:')) return url;
  const response = await fetch(url);
  if (!response.ok) throw new Error('无法读取导出所需的媒体');
  return blobDataUrl(await response.blob());
}
function codeBlock(node: TElement, text: string, lang = ''): TElement {
  return { id: node.id, type: 'code_block', lang, children: text.split('\n').map(line => ({ type: 'code_line', children: [{ text: line }] })) };
}
async function drawingImage(node: DocumentDrawingElement): Promise<TElement> {
  const { exportToBlob } = await import('@excalidraw/excalidraw');
  const blob = await exportToBlob({ elements: node.data?.elements ?? [], files: node.data?.files, appState: { ...node.data?.state, exportBackground: true }, mimeType: 'image/png' });
  return { id: node.id, type: 'img', url: await blobDataUrl(blob), children: [{ text: '' }] };
}
async function exportNode(editor: PlateEditor, node: TElement): Promise<TElement> {
  if (node.type === 'excalidraw') return drawingImage(node);
  if (node.type === 'raw') return codeBlock(node, NodeApi.string(node));
  if (node.type === 'code_drawing') {
    const preview = editor.api.toDOMNode(node)?.querySelector<HTMLImageElement>('img');
    if (preview?.src) return { id: node.id, type: 'img', url: await exportDataUrl(preview.src), children: [{ text: '' }] };
    const data = node.data as { code?: string; drawingType?: string } | undefined;
    return codeBlock(node, data?.code ?? '', data?.drawingType?.toLowerCase());
  }
  const children = await Promise.all(node.children.map(child => ElementApi.isElement(child) ? exportNode(editor, child) : { ...child }));
  return { ...node, children };
}
/** Convert interactive-only nodes without mutating the editable document or contacting diagram services. */
export function exportNodes(editor: PlateEditor): Promise<Value> {
  return Promise.all(editor.children.map(node => exportNode(editor, node)));
}
