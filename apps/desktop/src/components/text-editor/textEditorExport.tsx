import { createSlateEditor, type SlatePlugin } from 'platejs';
import type { PlateEditor } from 'platejs/react';
import { serializeHtml } from 'platejs/static';
import { normalizeDocument, serializeReadableMarkdown } from '../../lib/documentCodec';
import { BaseEditorKit } from './plate/components/editor/editor-base-kit';
import { DocxExportKit } from './plate/components/editor/plugins/docx-export-kit';
import { EditorStatic } from './plate/ui/editor-static';
import utilities from './plate/utilities.css?raw';
import mathStyles from 'katex/dist/katex.min.css?inline';
import { exportDataUrl, exportNodes } from './textEditorExportNodes';

function download(blob: Blob, extension: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `文档.${extension}`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function inlineMedia(document: Document) {
  for (const media of document.querySelectorAll<HTMLImageElement>('img[src],audio[src],video[src]')) {
    if (media.getAttribute('src')) media.setAttribute('src', await exportDataUrl(media.getAttribute('src')!));
  }
  for (const attachment of document.querySelectorAll<HTMLAnchorElement>('a[download][href]')) attachment.href = await exportDataUrl(attachment.getAttribute('href')!);
}
async function inlineMathFonts(document: Document) {
  if (!document.querySelector('.katex')) return '';
  const fontUrls = [...new Set([...mathStyles.matchAll(/url\(([^)]+)\)/g)].map(match => match[1].replace(/^["']|["']$/g, '')))];
  let math = mathStyles;
  for (const url of fontUrls) math = math.replaceAll(url, await exportDataUrl(url));
  return math;
}
async function documentHtml(editor: PlateEditor) {
  const staticEditor = createSlateEditor({ plugins: BaseEditorKit, value: await exportNodes(editor) });
  const html = await serializeHtml(staticEditor, { editorComponent: EditorStatic, props: { style: { padding: '32px', maxWidth: '900px', margin: 'auto' } } });
  const document = new DOMParser().parseFromString(html, 'text/html');
  await inlineMedia(document);
  const math = await inlineMathFonts(document);
  const theme = ':root{--bb-surface:#fff;--bb-ink:#242424;--bb-muted:#666;--bb-secondary:#555;--bb-surface-hover:#f3f3f3;--bb-surface-2:#f6f6f6;--bb-line:#ddd;--bb-blue:#316bcc;--bb-danger:#b91c1c}*{box-sizing:border-box}body{margin:0;font:16px/1.7 system-ui,sans-serif;background:white;color:#242424}img,video{max-width:100%}';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${theme}\n${utilities}\n${math}</style></head><body class="text-plate-ui">${document.body.innerHTML}</body></html>`;
}
async function documentCanvas(editor: PlateEditor) {
  const html = await documentHtml(editor);
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:-10000px;width:960px;height:600px;border:0';
  // Static serializer emits no scripts; use an isolated frame so controls, selections and scrolling cannot enter the export.
  try {
    await new Promise<void>(resolve => { frame.onload = () => resolve(); frame.srcdoc = html; document.body.append(frame); });
    const doc = frame.contentDocument!;
    await doc.fonts.ready;
    await Promise.all([...doc.images].map(img => img.decode().catch(() => {})));
    frame.style.height = `${doc.body.scrollHeight}px`;
    const { default: html2canvas } = await import('html2canvas-pro');
    const rendered = await html2canvas(doc.body, { backgroundColor: '#ffffff', windowWidth: 960, windowHeight: doc.body.scrollHeight, logging: false });
    // Keep the result in the live document before disposing its rendering frame.
    const canvas = document.createElement('canvas'); canvas.width = rendered.width; canvas.height = rendered.height;
    canvas.getContext('2d')!.drawImage(rendered, 0, 0);
    return canvas;
  } finally { frame.remove(); }
}
export async function exportDocument(editor: PlateEditor, format: 'html' | 'pdf' | 'png' | 'md' | 'docx') {
  if (format === 'md') {
    const value = normalizeDocument(editor.children);
    download(new Blob([serializeReadableMarkdown(value)], { type: 'text/markdown;charset=utf-8' }), format); return;
  }
  if (format === 'html') { download(new Blob([await documentHtml(editor)], { type: 'text/html;charset=utf-8' }), format); return; }
  if (format === 'docx') {
    const { exportToDocx } = await import('./textEditorDocx');
    download(await exportToDocx(await exportNodes(editor), { editorPlugins: [...BaseEditorKit, ...DocxExportKit] as SlatePlugin[] }), format); return;
  }
  const canvas = await documentCanvas(editor);
  if (format === 'png') { const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png')); if (blob) download(blob, format); return; }
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(canvas.toDataURL('image/png'));
  const scale = 595.28 / canvas.width, pageHeight = 841.89;
  for (let offset = 0; offset < canvas.height * scale; offset += pageHeight) {
    pdf.addPage([595.28, pageHeight]).drawImage(image, { x: 0, y: pageHeight - canvas.height * scale + offset, width: 595.28, height: canvas.height * scale });
  }
  download(new Blob([await pdf.save() as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), format);
}
