import { parseMarkdownAst } from './documentCodec.ts';
import { readDocumentState } from './documentState.ts';

/** HTML stays in an inert template: no execution, resource loads or live markup. */
function htmlText(source: string): string {
  const template = document.createElement('template');
  template.innerHTML = source;
  function text(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node instanceof Element) {
      const tag = node.localName;
      if (['script', 'style', 'template', 'iframe', 'object', 'embed', 'svg'].includes(tag)) return '';
      if (tag === 'br') return '\n';
      if (['img', 'audio', 'video'].includes(tag)) {
        const caption = node.getAttribute('data-caption');
        if (caption) { try { return decodeURIComponent(caption); } catch { return ''; } }
        return node.getAttribute('alt') ?? '';
      }
      const content = Array.from(node.childNodes, text).join('');
      return content + (/^(p|div|h[1-6]|li|tr|blockquote|pre|section|article)$/.test(tag) ? '\n' : /^(td|th)$/.test(tag) ? ' ' : '');
    }
    return node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? Array.from(node.childNodes, text).join('') : '';
  }
  return text(template.content);
}

type PreviewNode = { type: string; value?: string; alt?: string | null; children?: PreviewNode[] };
function markdownText(node: PreviewNode): string {
  switch (node.type) {
    case 'yaml': case 'toml': case 'definition': case 'footnoteReference': case 'thematicBreak': return '';
    case 'html': return htmlText(node.value ?? '');
    case 'image': case 'imageReference': return node.alt ?? '';
    case 'text': return node.value?.replace(/\r?\n/g, ' ') ?? '';
    case 'inlineCode': case 'inlineMath': return node.value ?? '';
    case 'code': case 'math': return `${node.value ?? ''}\n`;
    case 'break': return '\n';
  }
  const children = node.children?.map(markdownText) ?? [];
  if (node.type === 'tableRow') return children.join(' · ') + '\n';
  const content = children.join('');
  return content + (['paragraph', 'heading', 'listItem', 'blockquote', 'table'].includes(node.type) ? '\n' : '');
}

/** A bounded reading excerpt, never a source-code fallback. TXT remains literal. */
export function documentPreviewText(source: string, format: 'markdown' | 'text', limit = 1200): string {
  if (format === 'text') return source.trim().slice(0, limit);
  const text = markdownText(parseMarkdownAst(readDocumentState(source).source));
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
}
