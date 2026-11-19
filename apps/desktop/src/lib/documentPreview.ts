import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import { parseDocument } from 'htmlparser2';
import { documentReadingSource } from './documentState.ts';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter).use(remarkMath);

/** Parse as data, including inside a worker. No browser nodes or resource loads. */
function htmlText(source: string): string {
  function text(node: ReturnType<typeof parseDocument>['children'][number]): string {
    if (node.type === 'text') return node.data;
    if (node.type === 'tag') {
      const tag = node.name;
      if (['script', 'style', 'template', 'iframe', 'object', 'embed', 'svg'].includes(tag)) return '';
      if (tag === 'br') return '\n';
      if (['img', 'audio', 'video'].includes(tag)) {
        const caption = node.attribs['data-caption'];
        if (caption) { try { return decodeURIComponent(caption); } catch { return ''; } }
        return node.attribs.alt ?? '';
      }
      const content = node.children.map(text).join('');
      return content + (/^(p|div|h[1-6]|li|tr|blockquote|pre|section|article)$/.test(tag) ? '\n' : /^(td|th)$/.test(tag) ? ' ' : '');
    }
    return '';
  }
  return parseDocument(source).children.map(text).join('');
}

type PreviewNode = { type: string; value?: string; alt?: string | null; children?: PreviewNode[]; depth?: number; ordered?: boolean | null; start?: number | null; checked?: boolean | null };
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
  const text = markdownText(parser.parse(documentReadingSource(source)));
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
}

function escapeText(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Only bypass Markdown for unambiguous prose. Unrecognized punctuation is left to the parser. */
function plainParagraphHtml(source: string): string | undefined {
  if (/[^\p{L}\p{M}\p{N} \r\n.,;:!?'“”‘’"()，。；：、？！…（）《》—–-]/u.test(source)
    || /^(?: |-|\d{1,9}[.)](?: |$))| \r?$|www\./im.test(source)) return;
  const text = source.replace(/\r\n?/g, '\n').trim();
  return text ? renderParagraphs(text.split(/\n{2,}/)) : '';
}

function renderParagraphs(paragraphs: string[]) {
  // A few text nodes avoid both a DOM element per paragraph and one gigantic line-layout block.
  const chunks: string[] = [];
  for (let i = 0; i < paragraphs.length; i += 32) {
    const text = paragraphs.slice(i, i + 32).map(p => p.replace(/\n/g, ' ')).join('\n\n');
    chunks.push(`<span class="canvas-document-prose">${escapeText(text)}</span>`);
  }
  return chunks.join('');
}

/** Generate only fixed reading tags. Raw HTML, link targets and media URLs never enter the card DOM. */
export function documentReadingHtml(source: string): string {
  const body = documentReadingSource(source);
  const prose = plainParagraphHtml(body);
  if (prose !== undefined) return prose;
  function render(node: PreviewNode): string {
    const children = () => node.children?.map(render).join('') ?? '';
    switch (node.type) {
      case 'heading': {
        const level = Math.max(1, Math.min(node.depth ?? 1, 6));
        return `<h${level}>${children()}</h${level}>`;
      }
      case 'paragraph': return `<p>${children()}</p>`;
      case 'strong': return `<strong>${children()}</strong>`;
      case 'emphasis': return `<em>${children()}</em>`;
      case 'delete': return `<del>${children()}</del>`;
      case 'link': case 'linkReference': return `<u>${children()}</u>`;
      case 'blockquote': return `<blockquote>${children()}</blockquote>`;
      case 'list': return node.ordered ? `<ol start="${Number(node.start ?? 1)}">${children()}</ol>` : `<ul>${children()}</ul>`;
      case 'listItem': return `<li>${node.checked == null ? '' : node.checked ? '☑ ' : '☐ '}${children()}</li>`;
      case 'table': {
        const rows = node.children ?? [];
        const row = (cells: PreviewNode[], tag: 'th' | 'td') => '<tr>' + cells.map(cell => `<${tag}>${render(cell)}</${tag}>`).join('') + '</tr>';
        return '<table><thead>' + row(rows[0]?.children ?? [], 'th') + '</thead><tbody>' + rows.slice(1).map(r => row(r.children ?? [], 'td')).join('') + '</tbody></table>';
      }
      case 'code': case 'math': return `<pre>${escapeText(node.value ?? '')}</pre>`;
      case 'inlineCode': case 'inlineMath': return `<code>${escapeText(node.value ?? '')}</code>`;
      case 'break': return '<br>';
      case 'thematicBreak': return '<hr>';
      case 'html': return escapeText(markdownText(node)).replace(/\n/g, '<br>');
      case 'text': case 'image': case 'imageReference': return escapeText(markdownText(node));
      case 'yaml': case 'toml': case 'definition': case 'footnoteReference': return '';
      default: return children();
    }
  }
  const tree = parser.parse(body);
  if (tree.children.every(node => node.type === 'paragraph' && node.children.every(child => child.type === 'text'))) {
    return renderParagraphs(tree.children.map(node => markdownText(node).trimEnd()));
  }
  return render(tree);
}
