import { createSlateEditor, type SlatePlugin } from 'platejs';
import { normalizeDocument, parseMarkdown, serializeMarkdown } from './documentCodec';
import { BaseEditorKit } from '../components/text-editor/plate/components/editor/editor-base-kit';
import { DocxExportKit } from '../components/text-editor/plate/components/editor/plugins/docx-export-kit';
import { importDocx, exportToDocx } from '../components/text-editor/textEditorDocx';

/** Use the same Plate codecs as the editor, not a plain-text DOCX conversion. */
export async function readDocx(encoded: string): Promise<string> {
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  const editor = createSlateEditor({ plugins: BaseEditorKit });
  const result = await importDocx(editor, bytes.buffer);
  const value = normalizeDocument(result.nodes);
  if (result.comments.length) value.discussions = result.comments.map(comment => ({
    id: `docx-${comment.id}`, userId: 'local', createdAt: new Date(0), isResolved: false,
    comments: [{ id: `docx-comment-${comment.id}`, discussionId: `docx-${comment.id}`, userId: 'local', createdAt: new Date(0), isEdited: false,
      contentRich: [{ type: 'p', children: [{ text: comment.text }] }] }],
  }));
  return serializeMarkdown(value);
}

export async function writeDocx(markdown: string): Promise<string> {
  const blob = await exportToDocx(parseMarkdown(markdown), { editorPlugins: [...BaseEditorKit, ...DocxExportKit] as SlatePlugin[] });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
