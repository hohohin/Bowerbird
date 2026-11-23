import { createSlateEditor, type SlatePlugin } from 'platejs';
import type { PlateEditor } from 'platejs/react';
import { serializeHtml } from 'platejs/static';
import { normalizeDocument, serializeReadableMarkdown } from '../../lib/documentCodec';
import { BaseEditorKit } from './plate/components/editor/editor-base-kit';
import { DocxExportKit } from './plate/components/editor/plugins/docx-export-kit';
import { EditorStatic } from './plate/ui/editor-static';
import { EquationSchema, InlineEquationSchema } from './plate/components/editor/plugins/math-schema';
import utilities from './plate/utilities.css?raw';
import mathStyles from 'katex/dist/katex.min.css?inline';
import { exportDataUrl, exportNodes } from './textEditorExportNodes';

const documentTheme = '.text-plate-ui{--bb-surface:#fff;--bb-ink:#242424;--bb-muted:#666;--bb-secondary:#555;--bb-surface-hover:#f3f3f3;--bb-surface-2:#f6f6f6;--bb-line:#ddd;--bb-blue:#316bcc;--bb-danger:#b91c1c;font:16px/1.7 system-ui,sans-serif;background:#fff;color:#242424;color-scheme:light}*{box-sizing:border-box}img,video{max-width:100%}';

const printLayout = `
  #bowerbird-document-print { position: fixed; top: 0; left: -10000px; width: 182mm; visibility: hidden; }
  @page { size: A4; margin: 14mm; }
  @media print {
    html:has(#bowerbird-document-print), body:has(> #bowerbird-document-print) {
      height: auto !important; overflow: visible !important; background: white !important; color-scheme: light !important;
    }
    body:has(> #bowerbird-document-print) > :not(#bowerbird-document-print) { display: none !important; }
    #bowerbird-document-print { position: static; width: auto; visibility: visible; }
  }
`;

const printDocumentStyles = `
  @media print {
    .text-plate-ui { orphans: 2; widows: 2; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    .text-plate-ui > :first-child { overflow: visible; margin: 0 !important; padding: 0 !important; }
    div:has(> div > table) { overflow: visible !important; }
    h1, h2, h3, h4, h5, h6 { break-after: avoid; }
    blockquote, figure, img, li, pre, tr { break-inside: avoid; }
    pre { overflow: visible !important; white-space: pre-wrap; overflow-wrap: anywhere; }
    ol, ul { padding-inline-start: 1.8em !important; }
    table { border-collapse: separate !important; border-spacing: 0; }
    th, td {
      border: 0 !important; border-bottom: 1px solid #b7b7b7 !important; border-right: 1px solid #b7b7b7 !important;
      padding: 0 6px !important; overflow-wrap: anywhere;
    }
    :is(th, td):first-child { border-left: 1px solid #b7b7b7 !important; }
    thead tr:first-child th { border-top: 1px solid #b7b7b7 !important; background-color: #f6f6f6; }
    :is(th, td)::before { content: none !important; }
    figure { max-width: 100%; }
    figcaption { height: auto !important; }
    img, video { max-height: 245mm; object-fit: contain !important; }
  }
`;

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
async function renderDocument(editor: PlateEditor) {
  const value = await exportNodes(editor);
  const hasEquations = (nodes: typeof value): boolean => nodes.some(node => ['equation', 'inline_equation'].includes(node.type) || hasEquations(node.children.filter(child => Array.isArray(child.children)) as typeof value));
  const plugins: SlatePlugin[] = [...BaseEditorKit] as SlatePlugin[];
  if (hasEquations(value)) {
    // Static HTML serialization needs resolved renderers before rendering the tree.
    const { EquationElementStatic, InlineEquationElementStatic } = await import('./plate/ui/equation-node-static');
    plugins.push(EquationSchema.withComponent(EquationElementStatic), InlineEquationSchema.withComponent(InlineEquationElementStatic));
  }
  const staticEditor = createSlateEditor({ plugins, value });
  const html = await serializeHtml(staticEditor, { editorComponent: EditorStatic, props: { style: { padding: '32px', maxWidth: '900px', margin: 'auto' } } });
  const document = new DOMParser().parseFromString(html, 'text/html');
  await inlineMedia(document);
  const math = await inlineMathFonts(document);
  return { body: document.body, styles: `${documentTheme}\n${utilities}\n${math}`, math };
}
async function documentHtml(editor: PlateEditor) {
  const { body, styles } = await renderDocument(editor);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}\n${styles}</style></head><body class="text-plate-ui">${body.innerHTML}</body></html>`;
}

let printing = false;
async function printDocument(editor: PlateEditor) {
  if (printing) return;
  printing = true;
  const host = document.createElement('div');
  host.id = 'bowerbird-document-print';
  host.inert = true;
  const layout = document.createElement('style');
  const cleanup = () => {
    window.removeEventListener('afterprint', cleanup);
    // Some native print sheets do not dispatch a DOM afterprint event.
    document.removeEventListener('pointerdown', cleanup, true);
    document.removeEventListener('keydown', cleanup, true);
    host.remove();
    layout.remove();
    printing = false;
  };
  try {
    const { body, styles, math } = await renderDocument(editor);
    const content = document.createElement('div');
    content.className = 'text-plate-ui';
    content.append(...body.childNodes);
    for (const table of content.querySelectorAll('table')) {
      const first = table.rows.item(0);
      if (!table.tHead && first?.cells.length && [...first.cells].every(cell => cell.tagName === 'TH' && cell.rowSpan === 1)) {
        table.createTHead().append(first);
      }
    }
    const style = document.createElement('style');
    style.textContent = styles + printDocumentStyles;
    // WKWebView prints the main view. Isolate the static document's CSS without putting it in an iframe.
    host.attachShadow({ mode: 'open' }).append(style, content);
    // Chromium resolves custom fonts used in the shadow tree from document-level @font-face rules.
    layout.textContent = printLayout + (math.match(/@font-face\s*\{[^}]*\}/g) ?? []).join('\n');
    document.head.append(layout);
    document.body.append(host);
    await Promise.all([...content.querySelectorAll('img')].map(image => image.decode().catch(() => {})));
    await document.fonts.ready;
    window.addEventListener('afterprint', cleanup, { once: true });
    await window.print();
    if (host.isConnected) {
      document.addEventListener('pointerdown', cleanup, { capture: true, once: true });
      document.addEventListener('keydown', cleanup, { capture: true, once: true });
    }
  } catch (error) {
    cleanup();
    throw error;
  }
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
  if (format === 'pdf') { await printDocument(editor); return; }
  const canvas = await documentCanvas(editor);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (blob) download(blob, format);
}
